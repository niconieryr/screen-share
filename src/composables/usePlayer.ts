/**
 * 播放状态机 —— 整个前端的正确性都集中在这个文件里。
 *
 *   idle ──start()──▶ connecting ──▶ playing
 *                        │   ▲           │
 *                        │   └── 自动重连 ◀┘
 *                        ▼
 *                waiting（等待主播开播）──退避重试──▶ connecting
 *
 * 服务端明确说 404（这个房间里没有流）→ waiting，按退避一直试；
 * 401（令牌不对）→ unauthorized，重试多少次都一样，直接送回门禁页。
 *
 * 三条铁律：
 *   1. 音轨不是 Opus 就**不许**走 WebRTC —— 那会触发服务端转码，音质会毁
 *   2. WebRTC 建不起来就自动降级 HLS，观众不需要知道发生了什么，但页面要标出来
 *   3. 卡死要有看门狗兜底：字节/播放位置不再前进就重连，不能让人对着静止画面干等
 *
 * 和旧版的差别：新部署不暴露控制 API，所以没有「先问 /api/status 再决定连不连」
 * 这一步。「等待主播开播」直接由 WHEP/HLS 的失败结果驱动，配合退避重试；
 * 铁律 1 改成在 WHEP 的 answer 回来之后自己看协商出来的音频编码。
 */
import { onBeforeUnmount, ref, type Ref } from 'vue'

import type { Session } from '@/lib/config'
import { readElementStats, readWebRtcStats, type PlaybackStats } from '@/lib/stats'

import { HlsPlaybackError, startHls, type HlsHandle } from './useHlsPlayer'
import { startWhep, WhepError, type WhepSession } from './useWhep'

export type PlayerPhase =
  | 'idle'
  | 'connecting'
  | 'playing'
  /** 服务端说没有流（或者链路暂时不通）—— 这就是「等待主播开播」 */
  | 'waiting'
  | 'reconnecting'
  /** 令牌被服务端拒绝，是硬错误，不再重试 */
  | 'unauthorized'
  | 'error'

export type Transport = 'webrtc' | 'hls' | null

const STATS_POLL_MS = 1000
/** 连续这么多个采样周期没有新数据就判定卡死（约 8 秒） */
const STALL_LIMIT_TICKS = 8
/** WebRTC 建会话的尝试次数，用完就降级 HLS */
const WHEP_ATTEMPTS = 2
const RECONNECT_DELAY_MS = 1500
/** 收到 offer 应答后等第一个媒体轨道的上限 */
const FIRST_TRACK_TIMEOUT_MS = 6000
/**
 * 等待开播的退避节奏。
 *
 * 这里**不能**沿用旧版那种固定 3 秒轮询：旧版轮询的是一个只读 JSON 接口，
 * 现在的每一次尝试都是一次真实的 WHEP 建会话（服务端要分配会话、等 ICE），
 * 用固定高频去敲既没意义也浪费。逐步拉长到 10 秒封顶，
 * 主播开播后最多多等 10 秒，这个代价可以接受。
 */
const WAIT_BACKOFF_MS = [2000, 3000, 5000, 8000, 10000]

type Outcome = 'ok' | 'wait' | 'unauthorized' | 'fatal'

interface AttemptResult {
  outcome: Outcome
  /** 给观众看的失败原因；成功时是空串（降级 HLS 的那句说明由 connectHls 自己写） */
  reason: string
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitForFirstTrack(stream: MediaStream, timeoutMs: number): Promise<void> {
  if (stream.getTracks().length > 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.removeEventListener('addtrack', onAdd)
      reject(new Error('WebRTC 会话建立了，但一直没有收到媒体轨道'))
    }, timeoutMs)

    const onAdd = () => {
      clearTimeout(timer)
      stream.removeEventListener('addtrack', onAdd)
      resolve()
    }
    stream.addEventListener('addtrack', onAdd)
  })
}

/** 把两类错误里的 HTTP 状态码统一取出来：401 / 404 要区别对待 */
function httpStatusOf(error: unknown): number {
  if (error instanceof WhepError) return error.status
  if (error instanceof HlsPlaybackError) return error.status
  return 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function usePlayer(videoRef: Ref<HTMLVideoElement | null>, session: Session) {
  const phase = ref<PlayerPhase>('idle')
  const transport = ref<Transport>(null)
  const errorMessage = ref('')
  /** waiting 状态下「上一次为什么没连上」，纯诊断用，是次要信息 */
  const waitReason = ref('')
  const stats = ref<PlaybackStats | null>(null)
  /** 浏览器拦了自动播放（或者页面被切到后台），需要用户点一下 */
  const needsManualPlay = ref(false)

  let generation = 0
  let whepSession: WhepSession | null = null
  let hlsHandle: HlsHandle | null = null
  let waitTimer: number | null = null
  let statsTimer: number | null = null

  let waitStep = 0
  let statsMarker: { bytes: number; at: number } | null = null
  let stallTicks = 0
  let lastBytes = -1
  let lastCurrentTime = -1

  // ---------------------------------------------------------------- 生命周期

  async function teardown(): Promise<void> {
    if (statsTimer !== null) {
      clearInterval(statsTimer)
      statsTimer = null
    }

    const whep = whepSession
    whepSession = null
    if (whep) {
      try {
        await whep.close()
      } catch {
        /* 关不掉也无所谓，MediaMTX 会按 ICE 超时自己回收 */
      }
    }

    const hls = hlsHandle
    hlsHandle = null
    if (hls) {
      try {
        hls.destroy()
      } catch {
        /* ignore */
      }
    }

    const video = videoRef.value
    if (video) {
      try {
        video.pause()
      } catch {
        /* ignore */
      }
      video.srcObject = null
      video.removeAttribute('src')
    }

    stats.value = null
    statsMarker = null
    stallTicks = 0
    lastBytes = -1
    lastCurrentTime = -1
  }

  /** 递增代号：所有在途的异步链都会因此失效，不会再来改状态 */
  function bump(): number {
    generation += 1
    return generation
  }

  function clearWait(): void {
    if (waitTimer !== null) {
      clearTimeout(waitTimer)
      waitTimer = null
    }
  }

  // ---------------------------------------------------------------- 连接

  async function connectWebRtc(gen: number): Promise<AttemptResult> {
    const video = videoRef.value
    if (!video) return { outcome: 'fatal', reason: '视频元素还没准备好' }

    let lastError: unknown = null

    for (let attempt = 1; attempt <= WHEP_ATTEMPTS; attempt += 1) {
      if (gen !== generation) return { outcome: 'fatal', reason: '' }
      try {
        const created = await startWhep({
          room: session.room,
          token: session.token,
          onConnectionStateChange: (state) => {
            if (gen !== generation || transport.value !== 'webrtc') return
            if (state === 'failed') {
              void reconnect('WebRTC 连接断开')
            }
            // disconnected 先不动：多数情况几秒内会自己恢复，真卡住了有看门狗兜底
          },
        })

        if (gen !== generation) {
          await created.close()
          return { outcome: 'fatal', reason: '' }
        }

        // 铁律 1（新部署的替代做法）：没有 /api/status 可问，就等 answer 回来之后
        // 自己看协商出来的音频编码。不是 Opus 就立刻弃用这次会话 ——
        // 宁可白建一次，也别让服务端去做那个毁音质的转码。
        //
        // 已知的边界：这套部署是 WHIP 推流，音轨原生就是 Opus，正常走不到这里；
        // 而且「服务端把音轨丢了」和「本来就没有音轨」在 answer 里长得一样，
        // 分不出来。所以只在**确实协商出了**非 Opus 音轨时才降级，
        // 静音画面照样用 WHEP（跟旧版的判断一致）。
        if (created.audioCodec && created.audioCodec.toLowerCase() !== 'opus') {
          await created.close()
          return await connectHls(gen, `服务端音轨是 ${created.audioCodec}，走 WebRTC 需要转码`)
        }

        whepSession = created
        video.srcObject = created.stream
        video.muted = false

        await waitForFirstTrack(created.stream, FIRST_TRACK_TIMEOUT_MS)
        if (gen !== generation) return { outcome: 'fatal', reason: '' }

        await video.play().catch(() => {
          needsManualPlay.value = true
        })

        transport.value = 'webrtc'
        phase.value = 'playing'
        startStats(gen)
        return { outcome: 'ok', reason: '' }
      } catch (error) {
        lastError = error
        const status = httpStatusOf(error)

        // 401 是硬错误：令牌不对，重试多少次都一样
        if (status === 401) {
          await teardown()
          return { outcome: 'unauthorized', reason: '访问令牌被服务端拒绝（HTTP 401）' }
        }
        // 404 就是「主播还没开播」：MediaMTX 在路径上没有流时就是这么答的
        if (status === 404) {
          await teardown()
          return { outcome: 'wait', reason: '服务端说这个房间里现在没有流（HTTP 404）' }
        }

        await teardown()
        if (attempt < WHEP_ATTEMPTS) await delay(800)
      }
    }

    return await connectHls(gen, messageOf(lastError))
  }

  async function connectHls(gen: number, cause?: string): Promise<AttemptResult> {
    const video = videoRef.value
    if (!video) return { outcome: 'fatal', reason: '视频元素还没准备好' }

    try {
      const handle = await startHls(video, session.room, session.token)
      if (gen !== generation) {
        handle.destroy()
        return { outcome: 'fatal', reason: '' }
      }

      hlsHandle = handle
      video.muted = false
      await video.play().catch(() => {
        needsManualPlay.value = true
      })

      transport.value = 'hls'
      phase.value = 'playing'
      // 降级不是错误，但要让用户知道现在延迟是几秒级的
      errorMessage.value = cause ? `WebRTC 走不通（${cause}），已切到 HLS` : ''
      startStats(gen)
      return { outcome: 'ok', reason: '' }
    } catch (error) {
      if (gen !== generation) return { outcome: 'fatal', reason: '' }
      const detail = messageOf(error)
      const reason = cause ? `WebRTC：${cause}；HLS：${detail}` : detail

      const status = httpStatusOf(error)
      if (status === 401) return { outcome: 'unauthorized', reason }
      if (status === 404) return { outcome: 'wait', reason }

      // 浏览器既不支持 MSE 也不支持原生 HLS：等下去也不会变好，直接报错
      if (error instanceof HlsPlaybackError && error.unsupported) {
        return { outcome: 'fatal', reason }
      }

      return { outcome: 'wait', reason }
    }
  }

  /** 走一遍完整的连接流程：先 WHEP，不行再 HLS */
  async function attempt(gen: number): Promise<void> {
    if (gen !== generation) return

    phase.value = 'connecting'
    errorMessage.value = ''
    waitReason.value = ''

    const result = await connectWebRtc(gen)
    if (gen !== generation) return

    switch (result.outcome) {
      case 'ok':
        waitStep = 0
        return
      case 'unauthorized':
        errorMessage.value = result.reason
        phase.value = 'unauthorized'
        return
      case 'fatal':
        errorMessage.value = result.reason
        phase.value = 'error'
        return
      default:
        scheduleWait(gen, result.reason)
    }
  }

  // ---------------------------------------------------------------- 等待开播

  function scheduleWait(gen: number, reason: string): void {
    if (gen !== generation) return

    transport.value = null
    phase.value = 'waiting'
    waitReason.value = reason

    const delayMs = WAIT_BACKOFF_MS[Math.min(waitStep, WAIT_BACKOFF_MS.length - 1)]
    waitStep += 1

    clearWait()
    waitTimer = window.setTimeout(() => {
      waitTimer = null
      void attempt(gen)
    }, delayMs)
  }

  // ---------------------------------------------------------------- 看门狗

  function startStats(gen: number): void {
    if (statsTimer !== null) clearInterval(statsTimer)
    statsMarker = null
    stallTicks = 0
    lastBytes = -1
    lastCurrentTime = -1

    statsTimer = window.setInterval(() => {
      void collectStats(gen)
    }, STATS_POLL_MS)
  }

  async function collectStats(gen: number): Promise<void> {
    if (gen !== generation) return
    const video = videoRef.value
    if (!video) return

    if (transport.value === 'webrtc' && whepSession) {
      try {
        const { stats: fresh, marker } = await readWebRtcStats(whepSession.pc, statsMarker)
        if (gen !== generation) return
        statsMarker = marker
        stats.value = fresh
        checkStallByBytes(video, marker.bytes)
      } catch {
        /* 统计读失败不影响播放 */
      }
      return
    }

    if (transport.value === 'hls' && hlsHandle) {
      stats.value = readElementStats(video, 'hls', statsMarker, hlsHandle.bandwidthEstimate())
      checkStallByClock(video)
    }
  }

  function checkStallByBytes(video: HTMLVideoElement, bytes: number): void {
    if (video.paused || video.seeking) {
      stallTicks = 0
      lastBytes = bytes
      return
    }
    if (lastBytes >= 0 && bytes - lastBytes < 512) stallTicks += 1
    else stallTicks = 0
    lastBytes = bytes

    if (stallTicks >= STALL_LIMIT_TICKS) void reconnect('画面停住了')
  }

  function checkStallByClock(video: HTMLVideoElement): void {
    if (video.paused || video.seeking) {
      stallTicks = 0
      lastCurrentTime = video.currentTime
      return
    }
    if (lastCurrentTime >= 0 && Math.abs(video.currentTime - lastCurrentTime) < 0.005) stallTicks += 1
    else stallTicks = 0
    lastCurrentTime = video.currentTime

    if (stallTicks >= STALL_LIMIT_TICKS) void reconnect('画面停住了')
  }

  // ---------------------------------------------------------------- 对外动作

  async function reconnect(reason: string): Promise<void> {
    if (phase.value === 'reconnecting') return
    const gen = bump()

    clearWait()
    phase.value = 'reconnecting'
    errorMessage.value = reason
    needsManualPlay.value = false

    await teardown()
    transport.value = null
    await delay(RECONNECT_DELAY_MS)
    if (gen !== generation) return

    await attempt(gen)
  }

  /** 用户点了「进入房间」之后调用。可以重复调（换了令牌再进来）。 */
  function start(): void {
    const gen = bump()
    clearWait()
    waitStep = 0
    phase.value = 'connecting'
    errorMessage.value = ''
    waitReason.value = ''
    needsManualPlay.value = false

    void (async () => {
      // 先把上一轮的会话清干净（比如令牌失效后重新粘了一条链接）
      await teardown()
      if (gen !== generation) return
      await attempt(gen)
    })()
  }

  /** 手动重试（错误态下的按钮）：把退避重置掉，立刻试一次 */
  function retry(): void {
    waitStep = 0
    void reconnect('手动重连')
  }

  async function stop(): Promise<void> {
    bump()
    clearWait()
    await teardown()
    transport.value = null
    phase.value = 'idle'
  }

  /** 用户点了画面上的「播放」按钮 */
  async function manualPlay(): Promise<void> {
    const video = videoRef.value
    if (!video) return
    try {
      await video.play()
      needsManualPlay.value = false
    } catch {
      /* 还是播不了，UI 继续显示按钮 */
    }
  }

  onBeforeUnmount(() => {
    void stop()
  })

  return {
    phase,
    transport,
    errorMessage,
    waitReason,
    stats,
    needsManualPlay,
    start,
    stop,
    retry,
    manualPlay,
  }
}
