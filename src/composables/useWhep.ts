/**
 * WHEP 客户端。
 *
 * 手写而不是引库：WHEP 本身就是「POST 一个 SDP offer，拿回一个 SDP answer」，
 * 引一个播放器框架反而多一层要调试的东西。
 *
 * 和这套部署（面板 nginx 终止 TLS → edge 反代 → MediaMTX）的契约：
 *
 *   POST   <origin>/whep/<房间>[?k=<令牌>]   Content-Type: application/sdp
 *   PATCH  <Location>                        Content-Type: application/trickle-ice-sdpfrag
 *   DELETE <Location>
 *
 * 令牌是可选的：默认（开放模式）请求上不带任何 query，
 * 只有页面 URL 里带了 ?k=（受控模式）才透传上去。
 *
 * <Location> 是服务器用 Location 头回来的地址。MediaMTX 给的是**相对路径**
 * （/r-<房间>/whep/<会话>），edge 的 nginx 用 proxy_redirect 把它改写成
 * /whep/<房间>/<会话>?k=<令牌>，并且 **absolute_redirect off** 保证它不会被
 * 拼成「http://域名:8443/...」那种绝对地址 —— 否则页面在 https 下跟随它
 * 就是 mixed content，浏览器直接拦掉。所以这里**直接跟随 Location 原样请求**
 * 就对了 —— 千万不要自己再拼一次 ?k=，令牌拼两遍会被 nginx 那条 401 拦掉，
 * 会话就得等 ICE 超时（约 30 秒）才从服务端消失。
 */
import { origin, withToken } from '@/lib/config'

/** WHEP 请求失败。status 是服务端 HTTP 状态码，纯网络失败时为 0。 */
export class WhepError extends Error {
  readonly status: number

  constructor(message: string, status = 0) {
    super(message)
    this.name = 'WhepError'
    this.status = status
  }
}

export interface WhepSession {
  readonly pc: RTCPeerConnection
  readonly stream: MediaStream
  /** answer 里协商出来的音频编码；没有音轨时为 null */
  readonly audioCodec: string | null
  close(): Promise<void>
}

export interface WhepOptions {
  room: string
  token: string
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void
}

/** 只等这么久 ICE 收集。我们没有配 STUN，正常情况下几十毫秒就完事。 */
const ICE_GATHER_TIMEOUT_MS = 2000
/** 建会话的网络超时。超过就说明这条链路没戏，早点让上层去降级。 */
const SESSION_TIMEOUT_MS = 8000

function waitForIceGathering(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      pc.removeEventListener('icegatheringstatechange', onChange)
      clearTimeout(timer)
      resolve()
    }
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    // 超时也照样往下走：宁可用半份候选去试，也别把用户卡在「连接中」
    const timer = setTimeout(finish, timeoutMs)
  })
}

function firstMatch(text: string, re: RegExp): string {
  return re.exec(text)?.[1]?.trim() ?? ''
}

/** 取第一个 m= 段里的 a=mid */
function firstMid(sdp: string): string {
  let inMedia = false
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      if (inMedia) break
      inMedia = true
      continue
    }
    if (inMedia && line.startsWith('a=mid:')) return line.slice('a=mid:'.length).trim()
  }
  return ''
}

/**
 * 按 RFC 8840 拼一个 trickle-ice-sdpfrag。
 *
 * 头部那几行（v/o/s/t）标准 fragment 里没有，这里一起写上：补上之后这个 body
 * **同时**是一份合法的完整 SDP，服务端无论用宽松的 fragment 解析还是严格的
 * SDP 解析都能认。max-bundle 下所有候选共用一条 ICE 传输，统一挂在第一个
 * m= 段上就够了。
 */
function buildCandidateFragment(pc: RTCPeerConnection, candidate: string): string {
  const sdp = pc.localDescription?.sdp ?? ''
  const ufrag = firstMatch(sdp, /a=ice-ufrag:([^\r\n]+)/)
  const pwd = firstMatch(sdp, /a=ice-pwd:([^\r\n]+)/)
  const media = firstMatch(sdp, /^m=([^\r\n]+)$/m)
  const mid = firstMid(sdp)

  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    ufrag ? `a=ice-ufrag:${ufrag}` : '',
    pwd ? `a=ice-pwd:${pwd}` : '',
    media ? `m=${media}` : '',
    mid ? `a=mid:${mid}` : '',
    `a=${candidate}`,
  ]
  return `${lines.filter(Boolean).join('\r\n')}\r\n`
}

/** 补一个候选。这是尽力而为的路径，失败就吞掉（见下面 onicecandidate 的说明）。 */
async function patchCandidate(url: string, body: string): Promise<void> {
  try {
    const response = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/trickle-ice-sdpfrag' },
      body,
    })
    if (!response.ok) console.debug(`[whep] 补候选被拒（HTTP ${response.status}），忽略`)
  } catch {
    /* 网络层面的失败同样忽略：主路径那份 offer 已经带上当时的全部候选了 */
  }
}

/**
 * 从 SDP 里读协商出来的音频编码。
 *
 * 旧版是问 /api/status 拿轨道列表来判断「音轨是不是 Opus」的；新部署不暴露控制
 * API，只能在 answer 回来之后自己看 —— 代价是可能白建一次会话，但
 * 「音轨不是 Opus 就不许走 WebRTC（会被服务端转码毁掉音质）」这条铁律保住了。
 */
export function audioCodecFromSdp(sdp: string): string | null {
  const rtpmap = new Map<string, string>()
  let audioPayloads: string[] | null = null

  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('m=')) {
      if (audioPayloads === null && line.startsWith('m=audio')) {
        audioPayloads = line.split(/\s+/).slice(3)
      }
      continue
    }
    if (!line.startsWith('a=rtpmap:')) continue
    const value = line.slice('a=rtpmap:'.length)
    const space = value.indexOf(' ')
    if (space < 0) continue
    const codec = value.slice(space + 1).split('/')[0]?.trim()
    if (codec) rtpmap.set(value.slice(0, space), codec)
  }

  if (!audioPayloads) return null
  for (const pt of audioPayloads) {
    const codec = rtpmap.get(pt)
    if (codec) return codec
  }
  return null
}

export async function startWhep(options: WhepOptions): Promise<WhepSession> {
  const pc = new RTCPeerConnection({
    // 刻意不配 STUN：服务器有公网 IP，会把自己的公网地址作为 host 候选公告出来。
    // 引第三方 STUN 只是多一个可能被墙的依赖。
    iceServers: [],
    bundlePolicy: 'max-bundle',
  })

  const stream = new MediaStream()

  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })

  pc.ontrack = (event) => {
    // event.streams 在某些浏览器里是空的，自己拼 MediaStream 最稳
    const tracks = event.streams[0] ? event.streams[0].getTracks() : [event.track]
    for (const track of tracks) {
      if (!stream.getTracks().some((t) => t.id === track.id)) stream.addTrack(track)
    }
  }

  pc.onconnectionstatechange = () => {
    options.onConnectionStateChange?.(pc.connectionState)
  }

  // ---- 补候选（trickle ICE）----
  //
  // 主路径其实是「等候选集齐，再一次性 POST 一份完整 offer」：没有 STUN，
  // host 候选几十毫秒就齐了，所以下面这套基本不会被触发。只有 2 秒还没集齐时
  // 才先把半份 offer 发出去，剩下的候选等 Location 回来再 PATCH 上去 ——
  // 这样既不会把用户卡在「连接中」，也不依赖服务端对 fragment 的解析口味。
  //
  // 必须在 setLocalDescription **之前**挂上：候选是那时候开始产生的，挂晚了
  // 第一批（也就是最要紧的 host 候选）就漏了。
  let sessionUrl: string | null = null
  let trickleOff = false
  const backlog: string[] = []

  const flush = (candidate: string): void => {
    if (!sessionUrl) return
    void patchCandidate(sessionUrl, buildCandidateFragment(pc, candidate))
  }

  pc.onicecandidate = (event) => {
    const line = event.candidate?.candidate
    if (!line) return
    if (sessionUrl) flush(line)
    else if (!trickleOff) backlog.push(line)
  }

  try {
    await pc.setLocalDescription(await pc.createOffer())
    await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SESSION_TIMEOUT_MS)

    let response: Response
    try {
      response = await fetch(withToken(`${origin()}/whep/${options.room}`, options.token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
        body: pc.localDescription?.sdp ?? '',
        signal: controller.signal,
      })
    } catch (error) {
      // AbortError 是超时，不是用户取消；说清楚免得以为是「被点了取消」
      if ((error as Error)?.name === 'AbortError') {
        throw new WhepError(`WHEP 建会话超时（${SESSION_TIMEOUT_MS / 1000} 秒没有回应）`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      // nginx 用 401 表示令牌不对，用 404 表示房间路径 / 流不存在 ——
      // 上层要靠这两个码区分「链接失效」和「主播还没开播」，别混成一句话。
      const detail = await response.text().catch(() => '')
      throw new WhepError(
        `WHEP 建会话失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 160)}` : ''}`,
        response.status,
      )
    }

    const answer = await response.text()
    if (!answer.trim()) throw new WhepError('WHEP 返回了空的 SDP', 502)

    await pc.setRemoteDescription({ type: 'answer', sdp: answer })

    // 结束会话要 DELETE 到服务端给的 Location。
    // nginx 已经把这个相对路径改写回 /whep/<房间>/<会话>?k=...，所以浏览器能直接用。
    sessionUrl = response.headers.get('Location')
    if (sessionUrl) {
      for (const candidate of backlog.splice(0)) flush(candidate)
    } else {
      // 没有 Location 就既不能 PATCH 也不能 DELETE，只能靠 ICE 超时回收
      trickleOff = true
      backlog.length = 0
    }

    const audioCodec = audioCodecFromSdp(answer)

    return {
      pc,
      stream,
      audioCodec,
      async close() {
        try {
          pc.close()
        } catch {
          /* 已经关了 */
        }
        if (sessionUrl) {
          try {
            await fetch(sessionUrl, { method: 'DELETE', keepalive: true })
          } catch {
            /* 网络已经断了，MediaMTX 会按 ICE 超时自己回收 */
          }
        }
      },
    }
  } catch (error) {
    try {
      pc.close()
    } catch {
      /* ignore */
    }
    throw error
  }
}
