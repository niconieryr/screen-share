/**
 * 验收 / 压测共用的小工具。
 *
 * 放在 lib 里是为了让「合成一路推流」和「配置取值」这两段逻辑只有一份，
 * 别在几个脚本里各写一遍然后慢慢跑偏。
 *
 * 和旧项目（sharecast）比，这一版有几处是**新部署形态逼出来的**改动：
 *
 *   1. 对外只有**一条** https 域名入口（默认 https://share.polarbear.net.cn，
 *      TLS 在腾讯云面板 nginx 的 443 上终止，edge 只绑回环）。
 *      所以 baseUrl() 读的是 .env 的 PUBLIC_URL，不再拼 host:port。
 *      （2026-09-22 之前是明文 http + IP:8443，那条路已经退役。）
 *   2. **没有任何 ssh**：脚本只跟对外 URL 打交道。服务端的容器 CPU、网卡
 *      出口字节这些指标一概不取（旧项目靠 ssh + docker stats，这里刻意去掉），
 *      出口带宽改成「把每一路实测码率加起来」，这本来就更贴近真实占用。
 *   3. 配置取值顺序：命令行 > 环境变量 > 项目根目录 .env > 内置默认值。
 *      .env 可能还不存在（部署脚本还没跑过），所以读不到就给空值，绝不抛异常。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 项目根目录（scripts/lib/../..） */
export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 默认目标：唯一入口就是这条 https 域名（面板 nginx 的 443，真证书） */
export const DEFAULT_BASE = 'https://share.polarbear.net.cn'
/** 房间号在新部署里是固化的：nginx 只认这一个，MediaMTX 那边叫 r-share01 */
export const DEFAULT_ROOM = 'share01'
/** 观看端的短链接路径：https://share.polarbear.net.cn/screen —— 公开访问，不带令牌 */
export const DEFAULT_VIEW_PATH = 'screen'
/** 出口带宽（最硬的约束）：4 Mbps。留给观众的上限，不是目标值 */
export const EGRESS_BUDGET_MBPS = 4
/** 预留 15% 余量后的出口目标：4 × 0.85 = 3.4 Mbps */
export const EGRESS_TARGET_MBPS = 3.4
/** 协议/封装开销系数：出口 = 码率 × 人数 × 1.07 */
export const OVERHEAD_FACTOR = 1.07

/**
 * 「用户能看懂的错误」。
 * main() 只打印它的 message，不打印堆栈 —— 连不上就是连不上，
 * 抛一屏 ERR_ 出来的栈对谁都没帮助。
 */
export class FriendlyError extends Error {}

// ------------------------------------------------------------------ 配置

/** 读 .env（就是 KEY=VALUE 加 # 注释那种，不引依赖）。文件不存在返回空对象。 */
export function loadEnv() {
  const path = join(root, '.env')
  if (!existsSync(path)) return {}
  const map = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index < 1) continue
    map[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return map
}

/**
 * 去掉末尾斜杠、补上 scheme。
 * 命令行里写 `share.polarbear.net.cn` 也能用（按域名走 https）；
 * 写 `43.142.33.45:8443` 这种 IP 形式则按 http —— 那是 EDGE_BIND=0.0.0.0
 * 的临时直连形态，不是日常入口。
 */
export function normalizeBase(value) {
  const trimmed = String(value ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return DEFAULT_BASE
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(trimmed) ? `http://${trimmed}` : `https://${trimmed}`
}

/**
 * 拼 URL 时带上观看令牌：**只有令牌非空才拼 `?k=`**。
 *
 * 观看端现在是「短链接公开访问」：`VIEW_TOKEN` 为空 = 开放模式（默认），
 * 此时请求里必须**完全没有** k 参数 —— 拼一个空的 `?k=` 会被 nginx 当成
 * 「令牌不等于配置值」直接 401，看起来像服务端坏了，其实是脚本自己加错了参数。
 * `VIEW_TOKEN` 非空 = 受控模式，那就照旧带上。
 */
export function withToken(url, token) {
  const trimmed = typeof token === 'string' ? token.trim() : ''
  if (!trimmed) return url
  const parsed = new URL(url)
  parsed.searchParams.set('k', trimmed)
  return parsed.href
}

/**
 * 从 .env 的 PUBLIC_URL 取对外地址 —— 现在只有一条 https 域名入口。
 * .env 还没生成时给内置默认值，绝不抛异常。
 */
export function baseUrl(env = loadEnv()) {
  const url = String(env.PUBLIC_URL ?? '')
    .trim()
    .replace(/\/+$/, '')
  return url ? normalizeBase(url) : DEFAULT_BASE
}

/** `--key=value` / `--flag` 解析。不做花哨的短选项。 */
export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      flags.help = true
      continue
    }
    if (raw.startsWith('--')) {
      const body = raw.slice(2)
      const eq = body.indexOf('=')
      if (eq === -1) flags[body.toLowerCase()] = true
      else flags[body.slice(0, eq).toLowerCase()] = body.slice(eq + 1)
    } else {
      positional.push(raw)
    }
  }
  return { flags, positional }
}

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '')

/**
 * 取值顺序：命令行 > 环境变量 > .env > 默认值。
 * 每一项都记下「值是从哪来的」，排查「令牌明明是新的怎么还 401」时全靠它。
 */
export function resolveConfig(args, { need = [] } = {}) {
  const flags = args?.flags ?? {}
  const env = loadEnv()

  const baseFlag = text(flags.base)
  const baseEnv = text(process.env.SHARE_BASE)
  let base = DEFAULT_BASE
  let baseFrom = '内置默认值'
  if (baseFlag) [base, baseFrom] = [normalizeBase(baseFlag), '命令行 --base']
  else if (baseEnv) [base, baseFrom] = [normalizeBase(baseEnv), '环境变量 SHARE_BASE']
  else if (text(env.PUBLIC_URL)) [base, baseFrom] = [baseUrl(env), '.env（PUBLIC_URL）']

  const roomFlag = text(flags.room)
  const roomEnv = text(process.env.ROOM)
  let room = DEFAULT_ROOM
  let roomFrom = '内置默认值'
  if (roomFlag) [room, roomFrom] = [roomFlag, '命令行 --room']
  else if (roomEnv) [room, roomFrom] = [roomEnv, '环境变量 ROOM']
  else if (text(env.ROOM)) [room, roomFrom] = [text(env.ROOM), '.env（ROOM）']

  const viewFlag = text(flags['view-token'])
  const viewEnv = text(process.env.VIEW_TOKEN)
  let viewToken = ''
  let viewTokenFrom = '（没有 → 开放模式）'
  if (viewFlag) [viewToken, viewTokenFrom] = [viewFlag, '命令行 --view-token']
  else if (viewEnv) [viewToken, viewTokenFrom] = [viewEnv, '环境变量 VIEW_TOKEN']
  else if (text(env.VIEW_TOKEN)) [viewToken, viewTokenFrom] = [text(env.VIEW_TOKEN), '.env（VIEW_TOKEN）']

  const publishFlag = text(flags['publish-token'])
  const publishEnv = text(process.env.PUBLISH_TOKEN)
  let publishToken = ''
  let publishTokenFrom = '（没有）'
  if (publishFlag) [publishToken, publishTokenFrom] = [publishFlag, '命令行 --publish-token']
  else if (publishEnv) [publishToken, publishTokenFrom] = [publishEnv, '环境变量 PUBLISH_TOKEN']
  else if (text(env.PUBLISH_TOKEN))
    [publishToken, publishTokenFrom] = [text(env.PUBLISH_TOKEN), '.env（PUBLISH_TOKEN）']

  // 观看短链接的路径段。`/screen` 就是默认值，`.env` 里用 VIEW_PATH 改。
  const viewPathFlag = text(flags['view-path'])
  const viewPathEnv = text(process.env.VIEW_PATH)
  let viewPath = DEFAULT_VIEW_PATH
  let viewPathFrom = '内置默认值'
  if (viewPathFlag) [viewPath, viewPathFrom] = [viewPathFlag, '命令行 --view-path']
  else if (viewPathEnv) [viewPath, viewPathFrom] = [viewPathEnv, '环境变量 VIEW_PATH']
  else if (text(env.VIEW_PATH)) [viewPath, viewPathFrom] = [text(env.VIEW_PATH), '.env（VIEW_PATH）']
  viewPath = String(viewPath).replace(/^\/+|\/+$/g, '') || DEFAULT_VIEW_PATH

  const config = {
    base,
    baseFrom,
    room,
    roomFrom,
    viewToken,
    viewTokenFrom,
    publishToken,
    publishTokenFrom,
    viewPath,
    viewPathFrom,
    // 观看令牌为空就是**开放模式**：/screen 谁都能看，请求里不带 k 参数。
    // 这是默认形态；填了令牌才回到受控模式。断言怎么判全看这个开关。
    openMode: !viewToken,
    env,
    missing: need.filter((key) => !text({ viewToken, publishToken, room, base }[key])),
  }
  config.viewerURL = viewerUrl(config)
  return config
}

/** 观众页地址：开放模式就是光秃秃的短链接，受控模式才拼 ?k= */
export function viewerUrl(config) {
  return withToken(`${config.base}/${config.viewPath}`, config.viewToken)
}

// ------------------------------------------------------------------ 输出

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const CYAN = '\u001b[36m'
const DIM = '\u001b[2m'
const OFF = '\u001b[0m'

/**
 * 每断言一行 ✓/✗ + 一句人话说明；失败时把实际观察到的值塞进 detail。
 * 不用彩色库，就 ANSI 转义。
 */
export function createReporter() {
  const results = []
  return {
    results,
    section(title) {
      console.log(`\n${CYAN}==> ${title}${OFF}`)
    },
    /** 断言。detail 尽量写实际值，别写「失败了」。 */
    record(name, ok, detail = '') {
      results.push({ name, ok, detail })
      const tag = ok ? `${GREEN}✓${OFF}` : `${RED}✗${OFF}`
      console.log(`  ${tag} ${name}${detail ? `\n      ${DIM}${detail}${OFF}` : ''}`)
      return ok
    },
    note(line) {
      console.log(`  ${DIM}${line}${OFF}`)
    },
    info(line) {
      console.log(`  ${line}`)
    },
    /** 打印汇总并返回退出码：有失败就是 1 */
    summary(title = '验收结果') {
      const failed = results.filter((item) => !item.ok)
      console.log(`\n${'='.repeat(60)}`)
      console.log(`${title}：${results.length - failed.length}/${results.length} 通过`)
      if (failed.length) {
        console.log('\n未通过：')
        for (const item of failed) {
          console.log(`  ${RED}✗${OFF} ${item.name}${item.detail ? `（${item.detail}）` : ''}`)
        }
      }
      console.log('='.repeat(60))
      return failed.length ? 1 : 0
    },
  }
}

/**
 * 把错误压成一行人话。
 * 页面里（page.evaluate）抛出来的 Error，message 里会带一整段 JS 栈 ——
 * 对看日志的人来说那是噪音，只留第一行的原因就够了。
 */
export function readableError(error) {
  const raw = String(error?.message ?? error ?? '未知错误')
  return raw
    .replace(/^page\.evaluate:\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .split('\n')[0]
    .trim()
}

/**
 * 顶层兜底：用户看得懂的错误只打一行，别的才带堆栈（也压成一行）。
 */
export function reportFatal(error) {
  if (error instanceof FriendlyError) {
    console.error(`\n${RED}✗${OFF} ${error.message}`)
    return
  }
  console.error(`\n${RED}✗${OFF} 执行中断：${readableError(error)}`)
  // 页面内的错误已经把栈写在 message 里了，别再叠一层
  if (!String(error?.message ?? '').includes('\n')) {
    const stack = String(error?.stack ?? '')
      .split('\n')
      .slice(1, 4)
      .map((line) => `    ${line.trim()}`)
      .join('\n')
    if (stack) console.error(stack)
  }
}

/**
 * 总超时看门狗。
 * 「不挂死」是硬要求：某个等画面的 waitForFunction 万一永远不满足，
 * 进程必须自己了断，而不是让 CI/人干等。
 */
export function installWatchdog(timeoutMs, label = '整个脚本') {
  const timer = setTimeout(() => {
    console.error(`\n${RED}✗${OFF} ${label}超过 ${Math.round(timeoutMs / 1000)} 秒还没跑完，强制退出。`)
    process.exit(1)
  }, timeoutMs)
  return () => clearTimeout(timer)
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor(predicate, { timeout = 20000, interval = 500, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await sleep(interval)
  }
  throw new FriendlyError(`等待「${label}」超时（${timeout}ms）`)
}

// ------------------------------------------------------------------ 网络预检

/** 把 fetch 的花式报错压成一句人话 */
export function describeFetchError(error, timeoutMs) {
  if (!error) return '未知错误'
  if (error.name === 'TimeoutError' || error.name === 'AbortError') {
    return `${timeoutMs}ms 内没有任何响应（超时）`
  }
  const cause = error.cause
  const code = cause?.code ?? cause?.errno ?? ''
  if (code === 'ECONNREFUSED') return '连接被拒绝（端口没在监听 / 服务没起来）'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析不了'
  if (code === 'ECONNRESET') return '连接被对端重置'
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return '网络不可达（安全组 / ufw 没放行？）'
  const inner = cause?.message && cause.message !== error.message ? `（${cause.message}）` : ''
  return `${error.message}${inner}`
}

/**
 * 探活。**任何 HTTP 状态都算通** —— 401/404 也说明服务在监听，
 * 真正要区分的是「连不上」和「连上了但令牌不对」。
 */
export async function checkReachable(base, { timeoutMs = 8000 } = {}) {
  const started = Date.now()
  try {
    const response = await fetch(`${base}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    return { ok: true, status: response.status, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: describeFetchError(error, timeoutMs), ms: Date.now() - started }
  }
}

// ------------------------------------------------------------------ 浏览器

/** 本机已装的 Chrome / Edge。CHROME_PATH 最高优先级。 */
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  return candidates.find((path) => existsSync(path))
}

/**
 * 懒加载 playwright-core。
 *
 * 刻意不在文件顶部 import：没部署的时候要**先**探活、干净退出，
 * 而不是在 import 阶段就甩一个 ERR_MODULE_NOT_FOUND 的栈出来。
 */
export async function loadChromium() {
  try {
    const module = await import('playwright-core')
    return module.chromium
  } catch (error) {
    throw new FriendlyError(
      `加载 playwright-core 失败：${error?.message ?? error}\n` +
        '  先在项目根目录跑一次 npm install（playwright-core 在 devDependencies 里）。',
    )
  }
}

/**
 * 起浏览器：先按 executablePath 探本机已装的 Chrome/Edge；探不到再让 Playwright
 * 自己按 channel 找（chrome / msedge）。这是旧项目那套探测方式的照搬 + 一点兜底。
 */
export async function launchBrowser({ headless = true, timeoutMs = 60000 } = {}) {
  const chromium = await loadChromium()
  const executablePath = findChrome()
  const attempts = []
  if (executablePath) attempts.push({ label: executablePath, options: { executablePath } })
  attempts.push({ label: 'channel=chrome（Playwright 自己找）', options: { channel: 'chrome' } })
  attempts.push({ label: 'channel=msedge（Playwright 自己找）', options: { channel: 'msedge' } })

  const errors = []
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch({
        headless,
        timeout: timeoutMs,
        // --autoplay-policy：不加这个，没被用户点过的新页面里带声音的自动播放会被拦，
        //   「出画面」那条断言就会因为浏览器策略而不是因为服务端失败。
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
        ...attempt.options,
      })
      return { browser, used: attempt.label }
    } catch (error) {
      errors.push(`${attempt.label}: ${error?.message?.split('\n')[0] ?? error}`)
    }
  }
  throw new FriendlyError(
    `起不了 Chrome/Edge：\n    ${errors.join('\n    ')}\n` +
      '  本机装一个 Chrome 或 Edge，或者用 CHROME_PATH 指定浏览器可执行文件。',
  )
}

/** 打开同源页面。fetch 必须同源，否则会被 CORS 拦掉 —— 顺便也验证了静态站能打开。 */
export async function openOriginPage(browser, base, { viewport, timeoutMs = 30000 } = {}) {
  const page = await browser.newPage(viewport ? { viewport } : undefined)
  page.setDefaultTimeout(timeoutMs)
  page.setDefaultNavigationTimeout(timeoutMs)
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
  return page
}

// ------------------------------------------------------------------ 合成推流

/**
 * 在页面里合成一路 WHIP 推流：canvas 画移动方块当画面，振荡器出 440Hz 当声音。
 *
 * 走的是和 OBS 完全一样的 WHIP + H.264 + Opus 路径，但不碰分享者的屏幕，
 * 也不需要 OBS / ffmpeg 在场。真实路径能过，合成路径就一定在测同一段链路。
 */
export async function startSyntheticPublisher(
  page,
  { base, room, token, label = 'e2e', width = 1280, height = 720, fps = 30, connectTimeoutMs = 20000 },
) {
  return page.evaluate(
    async ({ base, room, token, label, width, height, fps, connectTimeoutMs }) => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      let frame = 0
      const draw = () => {
        frame += 1
        ctx.fillStyle = '#0B0B0D'
        ctx.fillRect(0, 0, width, height)
        ctx.fillStyle = '#E5484D'
        ctx.fillRect(60 + ((frame * 9) % Math.max(1, width - 160)), Math.round(height * 0.4), 90, 90)
        ctx.fillStyle = '#F4F4F5'
        ctx.font = '600 56px monospace'
        ctx.fillText(`${label}  frame ${frame}`, 60, 120)
        requestAnimationFrame(draw)
      }
      draw()

      const stream = canvas.captureStream(fps)

      // 48 kHz 正弦波 —— 和 OBS 的音频一样，最终由浏览器编成 Opus
      const audioContext = new AudioContext({ sampleRate: 48000 })
      const oscillator = audioContext.createOscillator()
      oscillator.frequency.value = 440
      const destination = audioContext.createMediaStreamDestination()
      oscillator.connect(destination)
      oscillator.start()
      for (const track of destination.stream.getAudioTracks()) stream.addTrack(track)

      const pc = new RTCPeerConnection({ iceServers: [] })

      // 强制用 H.264，别让 Chrome 自己挑 VP8。
      // MediaMTX 的 HLS 出不了 VP8（分片会变成 #EXT-X-GAP，观众只有声音没画面），
      // 而真实 OBS 推的就是 H.264 —— 合成流要和真实路径一致，测试才有意义。
      const videoTrack = stream.getVideoTracks()[0]
      const transceiver = pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [stream] })
      const capabilities = RTCRtpSender.getCapabilities('video')
      const h264 = capabilities?.codecs.filter((codec) => codec.mimeType === 'video/H264') ?? []
      if (h264.length > 0) transceiver.setCodecPreferences(h264)

      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream)

      await pc.setLocalDescription(await pc.createOffer())
      await new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve()
        pc.addEventListener('icegatheringstatechange', () => {
          if (pc.iceGatheringState === 'complete') resolve()
        })
        setTimeout(resolve, 3000)
      })

      const response = await fetch(`${base}/whip/${room}?k=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
      })
      if (!response.ok) {
        throw new Error(`WHIP HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() })

      // HTTP 200 只说明 SDP 换过了，ICE/DTLS 还没打通的时候照样 200。
      // 所以这里要盯到 PeerConnection 真的 connected —— 那才是「推流建立成功」。
      const state = await new Promise((resolve, reject) => {
        if (pc.connectionState === 'connected') return resolve('connected')
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`WHIP 建会话后 ${connectTimeoutMs / 1000} 秒连接状态还是 ${pc.connectionState}`))
        }, connectTimeoutMs)
        const onChange = () => {
          if (pc.connectionState === 'connected') {
            cleanup()
            resolve('connected')
          } else if (pc.connectionState === 'failed') {
            cleanup()
            reject(new Error('PeerConnection 状态变成 failed（ICE 没打通：UDP 8189 放行了没？）'))
          }
        }
        const cleanup = () => {
          clearTimeout(timer)
          pc.removeEventListener('connectionstatechange', onChange)
        }
        pc.addEventListener('connectionstatechange', onChange)
      })

      window.__syntheticPublisher = { pc, stream, audioContext }
      return {
        state,
        sentTracks: stream.getTracks().map((track) => track.kind),
        width,
        height,
      }
    },
    { base, room, token, label, width, height, fps, connectTimeoutMs },
  )
}

export async function stopSyntheticPublisher(page) {
  await page
    .evaluate(() => {
      const publisher = window.__syntheticPublisher
      if (publisher?.pc) publisher.pc.close()
      publisher?.stream?.getTracks().forEach((track) => track.stop())
    })
    .catch(() => undefined)
}

/**
 * 读推流端（发送侧）统计：分辨率、编码、已发字节。
 * 「服务端没转码」这条断言就是拿这里的数字去和收看侧比。
 */
export async function readSenderStats(page, { waitMs = 0 } = {}) {
  if (waitMs > 0) await sleep(waitMs)
  return page.evaluate(async () => {
    const pc = window.__syntheticPublisher?.pc
    if (!pc) throw new Error('页面里没有合成推流器')
    const report = await pc.getStats()
    const codecs = new Map()
    report.forEach((entry) => {
      if (entry.type === 'codec') codecs.set(entry.id, entry.mimeType)
    })
    const outbound = []
    report.forEach((entry) => {
      if (entry.type !== 'outbound-rtp') return
      outbound.push({
        kind: entry.kind ?? entry.mediaType,
        mime: codecs.get(entry.codecId) ?? null,
        bytes: entry.bytesSent ?? 0,
        frameWidth: entry.frameWidth ?? null,
        frameHeight: entry.frameHeight ?? null,
        framesEncoded: entry.framesEncoded ?? null,
      })
    })
    return { outbound }
  })
}

// ------------------------------------------------------------------ WHEP

/**
 * 页面里建一路 WHEP 会话并读接收侧统计。整段是塞进页面里执行的。
 *
 * attachVideo = true 时会自己造一个 <video> 挂上去、读 videoWidth：
 * 这样「浏览器到底能不能解码出画面」就和前端页面实现脱钩了 ——
 * 断网页面还没写好、或者页面用 canvas 渲染时，这条依然测得出真假。
 *
 * 另外 DELETE **必须在 pc.close() 之前**发。反过来的话 MediaMTX 已经把会话回收了，
 * DELETE 只会拿到 404 session not found —— 那是测试自己造出来的假失败（踩过）。
 */
const IN_PAGE_WHEP = async ({ whepUrl, base, waitMs, attachVideo }) => {
  const settle = (pc) =>
    new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve()
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve()
      })
      setTimeout(resolve, 3000)
    })

  const pc = new RTCPeerConnection({ iceServers: [] })
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })

  let video = null
  if (attachVideo) {
    video = document.createElement('video')
    video.autoplay = true
    video.muted = true // 静音：免得撞上浏览器的自动播放策略，我们要看的是画面
    video.playsInline = true
    video.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px;height:180px'
    document.body.appendChild(video)
    const stream = new MediaStream()
    pc.ontrack = (event) => {
      for (const track of event.streams[0]?.getTracks() ?? [event.track]) {
        if (!stream.getTracks().some((item) => item.id === track.id)) stream.addTrack(track)
      }
      video.srcObject = stream
      video.play?.().catch(() => undefined)
    }
  } else {
    // 刻意不接 <video>：没有渲染/合成/上屏的活。
    // 注意 Chrome 仍然会解码（实测 4 路时每路都在出帧），只是没人渲染 ——
    // 这正是压测想要的：量服务端转发和本机解码的边界，而不是显卡的上限。
    pc.ontrack = () => {}
  }

  await pc.setLocalDescription(await pc.createOffer())
  await settle(pc)

  const response = await fetch(whepUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
    body: pc.localDescription.sdp,
  })
  if (!response.ok) {
    throw new Error(`WHEP HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  const sdp = await response.text()
  const location = response.headers.get('Location')
  await pc.setRemoteDescription({ type: 'answer', sdp })

  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))

  const report = await pc.getStats()
  const codecs = new Map()
  report.forEach((entry) => {
    if (entry.type === 'codec') codecs.set(entry.id, entry.mimeType)
  })
  const inbound = []
  report.forEach((entry) => {
    if (entry.type !== 'inbound-rtp') return
    inbound.push({
      kind: entry.kind ?? entry.mediaType,
      mime: codecs.get(entry.codecId) ?? null,
      bytes: entry.bytesReceived ?? 0,
      frameWidth: entry.frameWidth ?? null,
      frameHeight: entry.frameHeight ?? null,
      packetsLost: entry.packetsLost ?? null,
    })
  })

  const playback = video
    ? {
        width: video.videoWidth,
        height: video.videoHeight,
        readyState: video.readyState,
        paused: video.paused,
        currentTime: video.currentTime,
      }
    : null

  // 结束会话：DELETE 服务端给的 Location，且要赶在 pc.close() 之前
  let deleteStatus = null
  let deleteUrl = null
  let deleteBody = ''
  if (location) {
    try {
      deleteUrl = new URL(location, base).href
    } catch {
      deleteUrl = String(location)
    }
    try {
      const deleted = await fetch(deleteUrl, { method: 'DELETE' })
      deleteStatus = deleted.status
      deleteBody = (await deleted.text().catch(() => '')).slice(0, 200)
    } catch (error) {
      deleteStatus = -1
      deleteBody = String(error?.message ?? error)
    }
  }

  const connectionState = pc.connectionState
  if (video) video.srcObject = null
  pc.close()
  return { inbound, sdp, location, connectionState, playback, deleteStatus, deleteUrl, deleteBody }
}

/**
 * 自己建一路 WHEP 会话，读接收侧统计（顺便验一遍 DELETE）。
 * 默认不接 <video>（不解码）；要验「浏览器真能解出画面」就传 attachVideo: true。
 * 令牌可选：开放模式（VIEW_TOKEN 为空）下请求里不带 k 参数。
 */
export async function readReceivedStats(page, { base, room, token = '', waitMs = 4000, attachVideo = false }) {
  const whepUrl = withToken(`${base}/whep/${room}`, token)
  return page.evaluate(IN_PAGE_WHEP, { whepUrl, base, waitMs, attachVideo })
}

/** 从 SDP 里抠出服务端同意的编码，用来断言「音轨就是 Opus」。 */
export function sdpCodecs(sdp) {
  const found = new Set()
  for (const line of String(sdp ?? '').split(/\r?\n/)) {
    const match = line.match(/^a=rtpmap:\d+\s+([A-Za-z0-9._-]+)\/(\d+)/)
    if (match) found.add(`${match[1]}/${match[2]}`)
  }
  return [...found]
}

/**
 * 看 nginx 有没有把 MediaMTX 的 Location 改写回对外路径，令牌该带就带、不该带就不带。
 *
 * 这条是旧项目踩过的坑：MediaMTX 会把自己收到的 query 原样回显进 Location，
 * 要是 nginx 改写时又拼一遍 query，就变成 ?k=xxx?k=xxx —— 令牌对不上，
 * DELETE 被自己的 401 拦掉，会话要挂到 ICE 超时（约 30 秒）才消失。
 *
 * 现在观看端是短链接公开访问，开放模式下 Location **本来就不该有令牌**，
 * 所以判据分两种：受控模式要求 k 等于配置的令牌；开放模式只要求没有重复 query。
 * 两种模式都要求路径是 /whep/<房间>/…（不能漏出内部的 /r-<房间>/…）。
 */
export function inspectWhepLocation(base, room, location, viewToken = '') {
  if (!location) return { ok: false, url: null, why: '响应里没有 Location 头' }
  let url
  try {
    url = new URL(location, base)
  } catch {
    return { ok: false, url: String(location), why: `Location 不是合法 URL：${location}` }
  }
  if (url.pathname.includes(`/r-${room}/`)) {
    return { ok: false, url: url.href, why: `露出了内部路径 ${url.pathname}（nginx 没把 Location 改写回 /whep/${room}/…）` }
  }
  if (!url.pathname.startsWith(`/whep/${room}/`)) {
    return { ok: false, url: url.href, why: `路径不是 /whep/${room}/… 而是 ${url.pathname}` }
  }
  // 两个问号 = query 被拼了两遍，不管哪种模式都是错
  if ((String(location).match(/\?/g) ?? []).length > 1) {
    return { ok: false, url: url.href, why: `Location 里有多个 ?，query 被拼了两遍：${location}` }
  }
  const token = url.searchParams.get('k')
  if (viewToken) {
    if (!token) return { ok: false, url: url.href, why: '受控模式下 Location 里没有 ?k= 令牌，后续 DELETE 会被 401 拦掉' }
    if (token !== viewToken) {
      return {
        ok: false,
        url: url.href,
        why: `?k= 的值不等于观看令牌（实际 "${token}"）—— 典型的 query 回显把令牌拼了两遍`,
      }
    }
  }
  return { ok: true, url: url.href, why: '' }
}

/**
 * 只探一下「现在能不能拉流」：建会话 → 立刻 DELETE → 关掉，不留垃圾会话。
 * 推流刚 connected 的那一瞬间 MediaMTX 还没把流登记好，这时候拉流会
 * 404 no stream is available on path —— 实测踩到过，所以要有这个重试闸门。
 */
const IN_PAGE_WHEP_PING = async ({ whepUrl, base }) => {
  const pc = new RTCPeerConnection({ iceServers: [] })
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  pc.ontrack = () => {}
  try {
    await pc.setLocalDescription(await pc.createOffer())
    const response = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    })
    const body = (await response.text().catch(() => '')).slice(0, 200)
    if (!response.ok) return { ok: false, status: response.status, body }
    const location = response.headers.get('Location')
    if (location) {
      await fetch(new URL(location, base).href, { method: 'DELETE' }).catch(() => undefined)
    }
    return { ok: true, status: response.status, body: '' }
  } catch (error) {
    return { ok: false, status: -1, body: String(error?.message ?? error) }
  } finally {
    pc.close()
  }
}

/** 等流真的可拉：推流 connected 之后服务端往往还要一两秒才登记好。 */
export async function waitForStreamReady(page, { base, room, token = '', timeoutMs = 25000, intervalMs = 1500 }) {
  const whepUrl = withToken(`${base}/whep/${room}`, token)
  const started = Date.now()
  let attempts = 0
  let last = { status: null, body: '' }
  while (Date.now() - started < timeoutMs) {
    attempts += 1
    last = await page.evaluate(IN_PAGE_WHEP_PING, { whepUrl, base })
    if (last.ok) {
      return { ok: true, attempts, status: last.status, seconds: (Date.now() - started) / 1000 }
    }
    await sleep(intervalMs)
  }
  return {
    ok: false,
    attempts,
    status: last.status,
    body: last.body,
    seconds: (Date.now() - started) / 1000,
  }
}

// ------------------------------------------------------------------ 并发压测：N 路只收不渲染

/**
 * 一口气开 N 路只收不渲染的 WHEP 会话。
 *
 * 「不渲染」是关键：MediaMTX 照样要为每一路做 RTP 打包和发送，服务端该干的活一点没少；
 * 但不把流挂到 <video> 上就没有渲染、合成、上屏这些开销，跑压测的机器不会因为
 * 自己画不过来而拖慢结果。观众的解码是观众自己电脑的事，不该算在服务端容量里。
 */
export async function openWhepSessions(page, { base, room, token = '', count }) {
  const whepUrl = withToken(`${base}/whep/${room}`, token)
  return page.evaluate(
    async ({ whepUrl, count }) => {
      const settle = (pc) =>
        new Promise((resolve) => {
          if (pc.iceGatheringState === 'complete') return resolve()
          pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') resolve()
          })
          setTimeout(resolve, 3000)
        })

      const sessions = []
      const failures = []
      for (let index = 0; index < count; index += 1) {
        try {
          const pc = new RTCPeerConnection({ iceServers: [] })
          pc.addTransceiver('video', { direction: 'recvonly' })
          pc.addTransceiver('audio', { direction: 'recvonly' })
          pc.ontrack = () => {}
          await pc.setLocalDescription(await pc.createOffer())
          await settle(pc)
          const response = await fetch(whepUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/sdp' },
            body: pc.localDescription.sdp,
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() })
          sessions.push({ index: index + 1, pc, location: response.headers.get('Location') })
        } catch (error) {
          failures.push(`#${index + 1} ${error?.message ?? error}`)
        }
      }
      window.__whepSessions = sessions
      return { connected: sessions.length, failures }
    },
    { whepUrl, count },
  )
}

/**
 * 采样：每路各自数一遍收了多少字节，算出实际码率。
 * 用 bytesReceived 的差值是唯一诚实的做法 —— 合成画面压缩率太高，
 * 按参数估的码率和真跑出来的能差一个数量级。
 */
export async function sampleWhepBitrates(page, { seconds = 15 } = {}) {
  return page.evaluate(
    async ({ seconds }) => {
      const sessions = window.__whepSessions ?? []
      if (sessions.length === 0) return { rows: [], seconds }

      const read = async () => {
        const rows = []
        for (const session of sessions) {
          const report = await session.pc.getStats()
          let bytes = 0
          let frames = 0
          report.forEach((entry) => {
            if (entry.type !== 'inbound-rtp') return
            bytes += entry.bytesReceived ?? 0
            frames += entry.framesDecoded ?? 0
          })
          rows.push({ bytes, frames })
        }
        return rows
      }

      const before = await read()
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
      const after = await read()

      return {
        seconds,
        rows: before.map((row, position) => {
          const delta = Math.max(0, (after[position]?.bytes ?? 0) - row.bytes)
          return {
            index: sessions[position].index,
            bytes: delta,
            bps: (delta * 8) / seconds,
            framesDecoded: (after[position]?.frames ?? 0) - row.frames,
          }
        }),
      }
    },
    { seconds },
  )
}

/** 收摊：先 DELETE 会话（趁 pc 还活着），再关连接。 */
export async function closeWhepSessions(page) {
  return page
    .evaluate(async () => {
      const sessions = window.__whepSessions ?? []
      const statuses = []
      for (const session of sessions) {
        if (session.location) {
          const status = await fetch(new URL(session.location, location.href).href, { method: 'DELETE' })
            .then((response) => response.status)
            .catch(() => -1)
          statuses.push(status)
        }
        session.pc.close()
      }
      window.__whepSessions = []
      return statuses
    })
    .catch(() => [])
}

// ------------------------------------------------------------------ HLS 直连探针

/**
 * 直连走一遍 HLS 的真实取流链条：master 播放列表 → 变体播放列表 → 分片。
 *
 * 为什么要三级都走（实测踩出来的）：
 *   - MediaMTX 的 index.m3u8 是 **master**，里面只有 #EXT-X-STREAM-INF 和变体地址
 *     （video1_stream.m3u8?session=…、audio2_stream.m3u8?session=…），一个分片地址都没有。
 *     只抓 index.m3u8 就以为 HLS 通了，是自欺欺人 —— 实测变体那一步会 401。
 *   - 变体/分片请求**不带 ?k=**（开放模式下本来就没有令牌这东西）。
 *     这里仍然手搓一个最小 cookie jar（只存 name=value），是因为 MediaMTX 自己的
 *     `cookieCheck`/`session` 机制要靠 cookie 和 302 串起来 —— 它已经不是鉴权手段了，
 *     但少了 cookie 依然会取不到分片。Node 的 fetch 没有 cookie jar，只能自己来。
 */
export async function probeHls(base, room, token = '', { timeoutMs = 15000, hops = 3 } = {}) {
  const jar = new Map()
  const trace = []

  const request = async (url) => {
    let current = url
    for (let hop = 0; hop <= hops; hop += 1) {
      const headers = {}
      if (jar.size > 0) headers.Cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ')
      let response
      try {
        response = await fetch(current, {
          redirect: 'manual',
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        trace.push(`${current} → ${describeFetchError(error, timeoutMs)}`)
        return { status: -1, body: '', url: current }
      }
      const body = await response.text().catch(() => '')
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const pair = raw.split(';')[0] ?? ''
        const eq = pair.indexOf('=')
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
      }
      trace.push(`${current} → ${response.status}`)
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get('Location')
        if (!next) return { status: response.status, body, url: current }
        current = new URL(next, current).href
        continue
      }
      return { status: response.status, body, url: current }
    }
    return { status: -1, body: '', url: current }
  }

  /** 从播放列表里挑出候选地址：裸行 + #EXT-X-MAP/PART 的 URI= 两种写法都收。 */
  const pickUris = (body, pattern) => {
    const found = []
    for (const line of String(body ?? '').split(/\r?\n/)) {
      const trimmed = line.trim()
      const tagged = trimmed.match(/^#EXT-X-[A-Z-]+:.*URI="([^"]+)"/)
      const plain = !trimmed.startsWith('#') && trimmed ? trimmed : ''
      const candidate = tagged?.[1] ?? plain
      if (!candidate || !pattern.test(candidate)) continue
      if (!found.includes(candidate)) found.push(candidate)
    }
    return found
  }

  const masterUrl = withToken(`${base}/hls/${room}/index.m3u8`, token)
  // MediaMTX 的 HLS 是按需起的，第一个请求可能赶在分片就绪之前，所以不成再等 2 秒来一次
  let master = await request(masterUrl)
  if (!(master.status === 200 && master.body.includes('#EXTM3U'))) {
    await sleep(2000)
    master = await request(masterUrl.href)
  }
  const masterOk = master.status === 200 && master.body.includes('#EXTM3U')

  // 第二级：变体播放列表。master 里的地址带 ?session=…，原样请求（不额外拼 ?k=）。
  // 每个候选都记下状态：音频变体挂了照样会让 hls.js 播不出声，得看得见。
  const variants = pickUris(master.body, /\.m3u8(\?|$)/i)
  let variantOk = false
  let variant = { status: null, url: variants[0] ? new URL(variants[0], master.url).href : null }
  const variantAttempts = []
  for (const candidate of variants.slice(0, 3)) {
    const resolved = new URL(candidate, master.url).href
    const result = await request(resolved)
    variantAttempts.push({ url: resolved, status: result.status })
    variant = {
      status: result.status,
      url: resolved,
      body: result.body,
      head: result.body.slice(0, 120).replace(/\s+/g, ' '),
    }
    if (result.status === 200 && result.body.includes('#EXTM3U')) {
      variantOk = true
      break
    }
  }
  if (!variant.head) variant.head = ''

  // 第三级：分片。刚开播时可能还没落盘，整轮重试一次，别把「来早了」误判成失败。
  const segmentUris = pickUris(variant.body ?? '', /\.(mp4|m4s|ts|aac|m4a)(\?|$)/i)
  let segment = { status: null, url: null }
  if (variantOk) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const candidate of segmentUris.slice(0, 3)) {
        const resolved = new URL(candidate, variant.url ?? master.url).href
        const result = await request(resolved)
        segment = { status: result.status, url: resolved }
        if (result.status === 200) break
      }
      if (segment.status === 200) break
      await sleep(2000)
    }
  }

  return {
    masterStatus: master.status,
    masterUrl: master.url,
    masterOk,
    masterHead: master.body.slice(0, 160).replace(/\s+/g, ' '),
    variants: variants.length,
    variant,
    variantAttempts,
    variantOk,
    segments: segmentUris.length,
    segment,
    cookies: [...jar.keys()],
    trace,
  }
}

// ------------------------------------------------------------------ 可选：房间状态接口

/**
 * 旧项目里 nginx 有个只读的 /api/status。新部署的 URL 契约里没有它，
 * 所以这里做成「有就用、没有就安静跳过」，绝不因为服务端没实现这个端点就判 FAIL。
 * 这个端点自己是要令牌的，开放模式下干脆不发请求。
 */
export async function fetchOptionalStatus(base, token, room, { timeoutMs = 6000 } = {}) {
  if (!token) return { available: false, reason: '没有观看令牌（开放模式），这个端点本来就要令牌，跳过' }
  try {
    const response = await fetch(`${base}/api/status?k=${encodeURIComponent(token)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` }
    const data = await response.json()
    const items = data?.items ?? []
    const item = items.find((entry) => entry.name === `r-${room}`) ?? null
    return { available: true, item }
  } catch (error) {
    return { available: false, reason: describeFetchError(error, timeoutMs) }
  }
}
