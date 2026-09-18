#!/usr/bin/env node
/**
 * screen-share 端到端验收。
 *
 * 用真实浏览器**自己合成**一路 WHIP 推流（canvas 画移动方块 + 振荡器出 440Hz），
 * 不碰分享者的屏幕，也不需要 OBS / ffmpeg 在场；然后开一个观看页去接，逐项验收。
 *
 * 只跟对外 URL 打交道，全程明文 http，不需要 ssh、不碰远端主机。
 * 目标地址 / 令牌的取值顺序：命令行 > 环境变量 > .env > 内置默认值（见 --help）。
 *
 * 用法：node scripts/e2e.mjs
 *      node scripts/e2e.mjs --base=http://43.142.33.45:8443 --view-token=... --publish-token=...
 *      CHROME_PATH=... node scripts/e2e.mjs        # 指定浏览器
 *
 * 退出码 0 = 全过，1 = 有失败（含「压根连不上」这种前置失败）。
 */
import {
  EGRESS_BUDGET_MBPS,
  checkReachable,
  createReporter,
  fetchOptionalStatus,
  inspectWhepLocation,
  installWatchdog,
  launchBrowser,
  openOriginPage,
  parseArgs,
  probeHls,
  readReceivedStats,
  readSenderStats,
  readableError,
  reportFatal,
  resolveConfig,
  sdpCodecs,
  startSyntheticPublisher,
  stopSyntheticPublisher,
  waitForStreamReady,
  withToken,
} from './lib/harness.mjs'

const USAGE = `
screen-share 端到端验收

用法：
  node scripts/e2e.mjs [选项]

选项：
  --base=<url>            对外地址（默认 http://43.142.33.45:8443）
  --room=<名字>           房间号（默认 share01，nginx 里是固化的）
  --view-path=<路径>      观看短链接的路径段（默认 screen，即 /screen）
  --view-token=<令牌>     观看令牌（默认取环境变量 VIEW_TOKEN，再取 .env 的 VIEW_TOKEN）
                          留空 = 开放模式：/screen 谁都能看，观看请求不带 ?k=（默认形态）
                          有值 = 受控模式：观看请求会带上 ?k=
  --publish-token=<令牌>  推流令牌（默认取环境变量 PUBLISH_TOKEN，再取 .env 的 PUBLISH_TOKEN）
  --canvas=1920x1080      合成推流的画布尺寸（默认 1280x720）
  --hls-timeout=<秒>      HLS 降级出画的超时上限（默认 60，超时即失败）
  --timeout=<秒>          整个脚本的总超时（默认 300）
  --help                  看这段

验收项：短链接 /screen 可用 / 根路径同一页 / WHIP 建流 / 不带令牌就能拉流（开放模式）/
        WHEP 出画 / 音轨是 Opus / WHEP DELETE / 零转码（分辨率与编码一致）/
        观众页免点击出画且默认静音 / HLS 三级探针 / 拦掉 WHEP 自动降级 HLS /
        推流令牌错或缺失 → 401 / 房间名写错 → 404
`

// ------------------------------------------------------------------ 小工具

/**
 * 打开观众页。**一个字都不点** —— 新交互要求短链接点进去就该静音自动播放，
 * 任何点击（门禁、播放按钮）都算它没做到。
 * blockWhep 用来模拟「观众网络把 WebRTC 全掐了」，验证自动降级 HLS。
 */
async function openWatchPage(browser, config, { blockWhep = false, url } = {}) {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } })
  page.setDefaultTimeout(config.pageTimeoutMs)
  page.setDefaultNavigationTimeout(config.pageTimeoutMs)

  const seen = { hls: [], bad: [], whep: [] }
  page.on('request', (request) => {
    const target = request.url()
    if (target.includes('/hls/') && target.includes('.m3u8')) seen.hls.push(target)
    if (target.includes('/whep/')) seen.whep.push(target)
  })
  page.on('response', (response) => {
    if (response.status() >= 400) seen.bad.push(`${response.status()} ${response.request().method()} ${response.url()}`)
  })
  page.on('pageerror', (error) => console.log(`      [页面报错] ${error.message}`))
  if (blockWhep) {
    // 掐掉所有 WHEP 请求，等价于观众所在网络把 UDP 整个封了：
    // WebRTC 建不起来，页面必须自己切 HLS，而不是干等或者白屏。
    await page.route('**/whep/**', (route) => route.abort())
  }

  // 注意：全局 launch 参数里放开了自动播放策略，避免把「浏览器策略」误判成
  // 「页面实现问题」。所以页面必须自己做到静音自动播放 —— 下面单独断言 video.muted。
  await page.goto(url ?? config.viewerURL, { waitUntil: 'domcontentloaded' })
  return { page, seen }
}

/**
 * 尽早抓住 <video> 的**初始**状态：muted 必须在页面自己播放之前就是 true，
 * 晚一点读可能已经被页面的其它逻辑改掉了。
 */
async function waitForInitialVideo(page, timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const state = await page
      .evaluate(() => {
        const video = document.querySelector('video')
        if (!video) return null
        return { muted: video.muted, autoplay: video.autoplay, paused: video.paused, playsInline: video.playsInline }
      })
      .catch(() => null)
    if (state) return state
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return null
}

/** 等画面真的出来：videoWidth > 0 才算，currentTime 在走不算（能只有声音没画面）。 */
async function waitForPicture(page, timeoutMs) {
  const started = Date.now()
  try {
    await page.waitForFunction(
      () => {
        const video = document.querySelector('video')
        return !!video && video.videoWidth > 0 && video.readyState >= 2
      },
      { timeout: timeoutMs },
    )
  } catch {
    const observed = await page
      .evaluate(() => {
        const video = document.querySelector('video')
        if (!video) return '页面上没有 <video> 元素'
        return `videoWidth=${video.videoWidth} readyState=${video.readyState} paused=${video.paused} currentTime=${video.currentTime.toFixed(2)} source=${video.srcObject ? 'MediaStream' : video.currentSrc || '(空)'}`
      })
      .catch(() => '页面都读不到了')
    return { ok: false, seconds: (Date.now() - started) / 1000, observed }
  }
  return { ok: true, seconds: (Date.now() - started) / 1000, observed: '' }
}

async function readPlayback(page) {
  return page
    .evaluate(() => {
      const video = document.querySelector('video')
      if (!video) return null
      const controls = [...document.querySelectorAll('button,[role="button"],a')]
      const label = (element) =>
        `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''}`.trim()
      // 开声按钮：文案/无障碍标签里带「声音 / 静音 / 取消静音 / unmute」之类
      const unmute = controls.find((element) => /声音|静音|开声|取消静音|unmute|unmuted|volume|speaker/i.test(label(element)))
      return {
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
        muted: video.muted,
        audioTracks: video.srcObject?.getAudioTracks?.().length ?? 0,
        unmuteControl: unmute ? label(unmute).replace(/\s+/g, ' ').slice(0, 24) : null,
      }
    })
    .catch(() => null)
}

/** 页面是不是「应用页面」而不是占位页：有 module 脚本或引用了构建产物 */
function looksLikeApp(html) {
  return /<script[^>]+type=["']module["']/i.test(html) || /(?:src|href)=["'][^"']*assets\//i.test(html)
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.help) {
    console.log(USAGE.trim())
    return 0
  }

  // 观看令牌现在是**可选**的（空 = 开放模式），所以 need 里只要推流令牌
  const config = resolveConfig(args, { need: ['publishToken'] })
  const [canvasWidth, canvasHeight] = String(args.flags.canvas ?? '1280x720')
    .split('x')
    .map((value) => Number.parseInt(value, 10))
  config.pageTimeoutMs = 30000
  const hlsTimeoutMs = (Number.parseFloat(args.flags['hls-timeout'] ?? '60') || 60) * 1000
  const watchdogMs = (Number.parseFloat(args.flags.timeout ?? '300') || 300) * 1000

  const report = createReporter()
  console.log('screen-share 端到端验收（明文 http，无域名无证书）')
  report.info(`目标     ${config.base}（来自 ${config.baseFrom}）`)
  report.info(`房间     ${config.room}（来自 ${config.roomFrom}）`)
  report.info(`观看入口 ${config.viewerURL}（路径来自 ${config.viewPathFrom}）`)
  report.info(`观看令牌 ${config.viewToken ? `已配置（${config.viewTokenFrom}）→ 受控模式` : `为空（${config.viewTokenFrom}）→ 开放模式`}`)
  report.info(`推流令牌 ${config.publishToken ? '已配置' : '缺失'}（来自 ${config.publishTokenFrom}）`)

  // ---------------------------------------------------------------- 前置：探活
  report.section('0. 前置检查')

  const reach = await checkReachable(config.base)
  if (!reach.ok) {
    report.record('目标可达', false, `${config.base} —— ${reach.error}`)
    report.note('没部署 / 安全组和 ufw 没放行 8443 / 本机网络不通，都会长这样。')
    report.note(`换个地址：--base=http://主机:端口，或设 SHARE_BASE、或在 .env 里写 PUBLIC_HOST/PUBLIC_PORT。`)
    return report.summary()
  }
  report.record('目标可达', true, `${config.base} → HTTP ${reach.status}（${reach.ms}ms）`)

  if (!config.publishToken) {
    report.record('推流令牌齐备', false, '推流令牌是必填的 —— 少了它连合成推流都建不起来')
    report.note('用 --publish-token=… 传，或设环境变量 PUBLISH_TOKEN，或在项目根目录 .env 里写 PUBLISH_TOKEN=…。')
    return report.summary()
  }
  report.record(
    '观看端模式',
    true,
    config.openMode
      ? `开放模式（VIEW_TOKEN 为空）→ ${config.viewerURL} 谁都能看，观看请求不带 ?k=`
      : `受控模式（VIEW_TOKEN 有值）→ 观看请求带 ?k=${config.viewToken.slice(0, 4)}…`,
  )

  // ---- 别把正在直播的那一路顶下线 ----
  //
  // MediaMTX 的 overridePublisher 默认是 true：谁后推谁说了算，合成推流一起，
  // 正在推的 OBS 会被**顶掉**（实测踩过：OBS 要 2 秒左右才自动重连回来，观众会断一下）。
  // 所以发现房间里已经有流就直接拒绝跑，要跑得显式 --force。
  if (!args.flags.force) {
    const liveProbe = await fetch(withToken(`${config.base}/hls/${config.room}/index.m3u8`, config.viewToken), {
      method: 'GET',
    }).catch(() => null)
    if (liveProbe?.status === 200) {
      report.record('没有正在直播的推流', false, `${config.base}/hls/${config.room}/index.m3u8 → 200，房间里有流`)
      report.note('现在跑会把正在推的 OBS 顶下线（overridePublisher=true），所以先不跑。')
      report.note('要停掉直播再跑，或者确认可以顶掉时加 --force。')
      return report.summary()
    }
    report.record('没有正在直播的推流', true, `房间空着（HLS 播放列表 ${liveProbe?.status ?? '连不上'}），可以安全地起合成推流`)
  } else {
    report.record('没有正在直播的推流', true, '--force：跳过检查，合成推流会把现有推流顶掉')
  }

  // 总超时看门狗：宁可自己了断，也不要挂死
  const clearWatchdog = installWatchdog(watchdogMs, '验收')

  let browser = null
  let publisher = null
  let viewer = null
  let fallback = null

  try {
    // ---------------------------------------------------------------- 短链接
    report.section('1. 观看短链接（公开访问）')

    // 短链接：**跟随重定向**再判。`/screen` 本身 200 最好；302 到某个同样是应用页的
    // 地址也照样算「点进去就能看」—— 我们要的是结果，不是某一种实现。
    const fetchPage = async (path) => {
      try {
        const response = await fetch(`${config.base}${path}`, { signal: AbortSignal.timeout(15000) })
        return {
          status: response.status,
          html: await response.text().catch(() => ''),
          finalUrl: response.url,
          redirected: response.redirected,
        }
      } catch (error) {
        return { status: -1, html: '', finalUrl: '', redirected: false, error: error?.message ?? String(error) }
      }
    }
    const describePage = (page, path) =>
      page.status !== 200
        ? `HTTP ${page.status}${page.error ? `（${page.error}）` : ''}`
        : looksLikeApp(page.html)
          ? `HTTP 200（${path}${page.redirected ? ` → ${page.finalUrl}` : ''}，${page.html.length} 字节应用页面）`
          : `HTTP 200 但拿到的不是应用页面（没有 module 脚本也没有 assets/ 引用）：${page.html.replace(/\s+/g, ' ').slice(0, 120)}`

    const shortLink = await fetchPage(`/${config.viewPath}`)
    report.record(
      `GET /${config.viewPath} → 200 且是应用页面`,
      shortLink.status === 200 && looksLikeApp(shortLink.html) && shortLink.finalUrl.startsWith(config.base),
      describePage(shortLink, `/${config.viewPath}`),
    )

    // `/` 也仍然应该出同一页（短链接只是更好看，不是唯一入口）。
    // 实测部署里 `/` 是 302 → /screen，所以这里跟随重定向判最终结果。
    const rootPage = await fetchPage('/')
    report.record(
      'GET / 也出同一页（短链接不是唯一入口）',
      rootPage.status === 200 && looksLikeApp(rootPage.html) && rootPage.finalUrl.startsWith(config.base),
      describePage(rootPage, '/'),
    )

    // ---------------------------------------------------------------- 推流
    report.section('2. 合成一路 WHIP 推流（canvas + 振荡器，H.264 + Opus）')
    const launched = await launchBrowser()
    browser = launched.browser
    report.info(`浏览器   ${launched.used}`)

    try {
      publisher = await openOriginPage(browser, config.base)
      const publish = await startSyntheticPublisher(publisher, {
        base: config.base,
        room: config.room,
        token: config.publishToken,
        label: 'e2e',
        width: canvasWidth,
        height: canvasHeight,
        fps: 30,
      })
      report.record(
        'WHIP 推流建立成功（PeerConnection connected）',
        publish.state === 'connected',
        `连接状态 ${publish.state}，发送轨道 ${publish.sentTracks.join(' + ')}，画布 ${publish.width}×${publish.height}`,
      )
    } catch (error) {
      // 推流建不起来，后面全都没意义，直接收摊
      report.record('WHIP 推流建立成功（PeerConnection connected）', false, readableError(error))
      report.note('推流是后面所有断言的前提，先把它弄通。OBS 侧的对照设置见 docs/OBS-设置.md。')
      return report.summary()
    }

    // 推流刚 connected 时 MediaMTX 还没把流登记好，这时候去拉会 404
    // no stream is available on path（实测踩到过），所以先等它真的可拉。
    const ready = await waitForStreamReady(publisher, {
      base: config.base,
      room: config.room,
      token: config.viewToken,
    })
    report.record(
      config.openMode ? '不带任何令牌也能建 WHEP 会话（开放模式）' : '服务端已就绪（WHEP 能建会话）',
      ready.ok,
      ready.ok
        ? `${ready.attempts} 次探测后成功，耗时 ${ready.seconds.toFixed(1)} 秒（请求${config.openMode ? '不带 ?k=' : '带 ?k='}）`
        : `${ready.seconds.toFixed(1)} 秒内 ${ready.attempts} 次探测都失败，最后一次 HTTP ${ready.status} ${ready.body}`,
    )
    if (!ready.ok) {
      report.note('流都拉不到，后面的断言没有意义，先解决推流到服务端这一段。')
      return report.summary()
    }

    // ---------------------------------------------------------------- WHEP
    report.section('3. WHEP 主路径（裸会话读接收侧统计）')

    const sender = await readSenderStats(publisher, { waitMs: 1500 })
    const senderVideo = sender.outbound.find((item) => item.kind === 'video') ?? null
    const senderAudio = sender.outbound.find((item) => item.kind === 'audio') ?? null

    // 这一路接了个自建 <video>：既证「服务端真的在发」，也证「浏览器真能解出画面」，
    // 和前端页面写得怎么样无关。位置：见 harness 的 attachVideo。
    let received
    try {
      received = await readReceivedStats(publisher, {
        base: config.base,
        room: config.room,
        token: config.viewToken,
        waitMs: 6000,
        attachVideo: true,
      })
    } catch (error) {
      report.record(
        config.openMode ? '开放模式：不带令牌的 WHEP 会话也能建起来' : 'WHEP 会话能建起来',
        false,
        readableError(error),
      )
      report.note('这一路是后面所有观看侧断言的前提，先把它弄通。')
      return report.summary()
    }
    const audioIn = received.inbound.find((item) => item.kind === 'audio') ?? null
    const videoIn = received.inbound.find((item) => item.kind === 'video') ?? null

    // 「服务端上报的音轨」= WHEP answer SDP 里协商出来的编码 + 接收侧统计里的 codec。
    // 两处都得是 Opus：只要有一处不是，说明链路上有人在转码，前端就该改走 HLS 而不是硬走 WHEP。
    const answerCodecs = sdpCodecs(received.sdp)
    const opusInSdp = answerCodecs.some((codec) => /opus/i.test(codec))
    const audioMime = audioIn?.mime ?? null
    const opusInStats = /opus/i.test(audioMime ?? '')
    report.record(
      '服务端上报的音轨是 Opus（否则不该走 WHEP）',
      opusInSdp && opusInStats,
      `WHEP answer SDP：${answerCodecs.join(', ') || '(空)'}；接收侧音轨编码：${audioMime ?? '(无音轨)'}`,
    )

    // 旧项目里 nginx 有个只读 /api/status。新契约里没有它，所以只当补充信息，不当断言。
    const status = await fetchOptionalStatus(config.base, config.viewToken, config.room)
    if (status.available) {
      const tracks = status.item?.tracks ?? []
      report.note(`/api/status 说房间 ${status.item?.ready ? '开播中' : '没开播'}，轨道 [${tracks.join(', ')}]`)
    } else {
      report.note(`没有 /api/status（${status.reason}），跳过 —— 它不是本项目的 URL 契约，不影响验收`)
    }

    report.record(
      '接收侧音频在持续传输',
      !!audioIn && audioIn.bytes > 0,
      audioIn ? `${audioIn.mime}，已收到 ${audioIn.bytes} 字节` : '没有音频流',
    )
    report.record(
      '接收侧视频在持续传输',
      !!videoIn && videoIn.bytes > 0,
      videoIn ? `${videoIn.mime}，已收到 ${videoIn.bytes} 字节` : '没有视频流',
    )

    // ---------------------------------------------------------------- Location / DELETE
    const location = inspectWhepLocation(config.base, config.room, received.location, config.viewToken)
    report.record(
      config.openMode ? 'WHEP 的 Location 指回对外地址（开放模式不带令牌）' : 'WHEP 的 Location 指回对外地址且带令牌',
      location.ok,
      location.ok ? location.url : `${location.url ?? '(没有 Location)'} —— ${location.why}`,
    )

    // 这条专盯旧项目踩过的坑：nginx 改写 Location 时把原始 query 又拼了一遍，
    // 变成 ?k=xxx?k=xxx，DELETE 会被自家 401 拦掉，会话挂到 ICE 超时（约 30 秒）才消失。
    // （DELETE 是在 harness 里、pc.close() 之前发的 —— 顺序反了会拿到假的 404。）
    const deleteOk = received.deleteStatus !== null && received.deleteStatus >= 200 && received.deleteStatus < 400
    report.record(
      'WHEP 会话能正常 DELETE',
      deleteOk,
      received.deleteStatus === null
        ? '服务端没给 Location，无从 DELETE'
        : `DELETE ${received.deleteUrl} → HTTP ${received.deleteStatus}${received.deleteBody ? `：${received.deleteBody}` : ''}`,
    )

    // 画面这一条单独立项：videoWidth > 0 才算真有画面。
    // 只看 currentTime 在走是不够的 —— H.264 有 B 帧或者音视频不同步时，
    // 时间轴照样推进，画面却是黑的（旧项目就是栽在「只出声不出画」上）。
    const playback = received.playback
    report.record(
      'WHEP 出画面（videoWidth > 0）',
      !!playback && playback.width > 0 && playback.readyState >= 2,
      playback
        ? `videoWidth=${playback.width} videoHeight=${playback.height} readyState=${playback.readyState} ` +
          `currentTime=${playback.currentTime.toFixed(2)} paused=${playback.paused}`
        : '没能把流挂到 <video> 上',
    )

    // ---------------------------------------------------------------- 零转码
    report.section('4. 服务端零转码（推流与收看一致）')

    const sameSize =
      !!senderVideo &&
      !!videoIn &&
      videoIn.frameWidth > 0 &&
      senderVideo.frameWidth === videoIn.frameWidth &&
      senderVideo.frameHeight === videoIn.frameHeight
    report.record(
      '分辨率与推流端一致（没被重新缩放）',
      sameSize,
      `推流端 ${senderVideo?.frameWidth ?? '?'}×${senderVideo?.frameHeight ?? '?'}` +
        ` → 收看端 ${videoIn?.frameWidth ?? '?'}×${videoIn?.frameHeight ?? '?'}`,
    )

    const sameVideoCodec = !!senderVideo && !!videoIn && senderVideo.mime === videoIn.mime
    const sameAudioCodec = !!senderAudio && !!audioIn && senderAudio.mime === audioIn.mime
    report.record(
      '编码与推流端一致（H.264 / Opus 原样转发）',
      sameVideoCodec && sameAudioCodec,
      `推流端 ${senderVideo?.mime ?? '?'} + ${senderAudio?.mime ?? '?'}` +
        ` → 收看端 ${videoIn?.mime ?? '?'} + ${audioIn?.mime ?? '?'}`,
    )

    // ---------------------------------------------------------------- 观看页
    report.section('5. 观众页：短链接点进去就出画（一次都不点）')

    // 上面那路是自建 <video>，证明的是链路；这一路走真实观众页，
    // 证明的是「页面自己会拉流、自己静音自动播放」。两者分开，出问题时一眼能分清是谁的锅。
    const watch = await openWatchPage(browser, config)
    viewer = watch.page

    // 先抓 <video> 一出现时的 muted —— 这是「静音自动播放」的直接证据，
    // 等出画之后再读可能已经被页面自己的逻辑改掉了。
    const initial = await waitForInitialVideo(viewer, 20000)
    if (!initial) {
      report.record('观众页有 <video> 元素', false, '20 秒内页面上都没出现 <video>')
    }
    const picture = await waitForPicture(viewer, 30000)
    report.record(
      config.openMode ? `直接打开 /${config.viewPath}（不带 query）就出画，全程没点任何东西` : '观众页出画（全程没点任何东西）',
      picture.ok,
      picture.ok ? `耗时 ${picture.seconds.toFixed(1)} 秒（URL：${config.viewerURL}）` : `30 秒内没出画：${picture.observed}`,
    )
    report.record(
      '页面默认静音（不然浏览器不给自动播放）',
      !!initial && initial.muted === true,
      initial ? `video.muted=${initial.muted}，autoplay=${initial.autoplay}，playsInline=${initial.playsInline}` : '没读到 <video>',
    )

    const shown = picture.ok ? await readPlayback(viewer) : null
    if (shown) {
      report.note(
        `页面 video：${shown.width}×${shown.height}，paused=${shown.paused}，muted=${shown.muted}，音轨 ${shown.audioTracks} 条`,
      )
    }
    // 开声按钮是给观众自己点的那一下（浏览器要求有用户手势才能出声），顺带看一眼在不在
    report.record(
      '页面上有开声控件（观众自己点一下才有声音）',
      !!shown?.unmuteControl,
      shown?.unmuteControl ? `找到控件：「${shown.unmuteControl}」` : '没找到文案/aria-label 里带「声音/静音/开声/unmute」的按钮或链接',
    )

    const badOnWatchPage = watch.seen.bad.filter((line) => !line.includes('/whep/'))
    report.record(
      '观看页没有意料之外的失败请求',
      badOnWatchPage.length === 0,
      badOnWatchPage.length ? [...new Set(badOnWatchPage)].join('；') : '干净',
    )

    // ---------------------------------------------------------------- HLS 直连探针
    report.section('6. HLS 兜底链路（直连探针，走完整三级）')

    const hls = await probeHls(config.base, config.room, config.viewToken)
    report.record(
      'HLS master 播放列表（index.m3u8）能取到',
      hls.masterOk,
      `HTTP ${hls.masterStatus} ${hls.masterHead || '(空响应)'}`,
    )
    report.record(
      'HLS 变体播放列表能取到（master 里的 video*/audio* 地址）',
      hls.variantOk,
      hls.variant.url
        ? `HTTP ${hls.variant.status} ${hls.variant.head || '(空响应)'}` +
            (hls.variantAttempts.length > 1
              ? `；逐个变体：${hls.variantAttempts.map((item) => `${item.url.split('/').pop()} → ${item.status}`).join('，')}`
              : '')
        : `master 里没解析出变体地址（找到 ${hls.variants} 个候选）`,
    )
    report.record(
      'HLS 分片能取到（不带 ?k=，cookie 只用于 MediaMTX 自己的 cookieCheck/session）',
      hls.segment.status === 200,
      hls.segment.url
        ? `HTTP ${hls.segment.status}（${hls.segment.url}；cookie：[${hls.cookies.join(', ') || '无'}]）`
        : `变体播放列表里没解析出分片地址（找到 ${hls.segments} 个候选）`,
    )
    if (hls.trace.length > 1) report.note(`请求轨迹：${hls.trace.join(' → ')}`)

    // ---------------------------------------------------------------- 降级
    report.section('7. WHEP 走不通时自动降级 HLS')

    const blocked = await openWatchPage(browser, config, { blockWhep: true })
    fallback = blocked.page
    const fallbackStarted = Date.now()
    const fallbackPicture = await waitForPicture(fallback, hlsTimeoutMs)
    const fallbackSeconds = (Date.now() - fallbackStarted) / 1000
    report.record(
      '拦掉 WHEP 后仍能出画（超时算失败，全程不点击）',
      fallbackPicture.ok,
      fallbackPicture.ok
        ? `耗时 ${fallbackSeconds.toFixed(1)} 秒（上限 ${hlsTimeoutMs / 1000} 秒）`
        : `${hlsTimeoutMs / 1000} 秒内没出画：${fallbackPicture.observed}`,
    )
    // 出画不等于切到了 HLS —— 也可能是别的原因蒙对的，所以要看它真去要了播放列表
    report.record(
      '确实走了 HLS 而不是卡在 WHEP 上',
      blocked.seen.hls.length > 0,
      blocked.seen.hls.length ? `请求过 ${blocked.seen.hls[0]}` : '整段过程里没有任何 .m3u8 请求',
    )

    // 光有画面还不够，得确认它真的在往前走（HLS 首帧之后卡住的画法很常见）
    const advanced = await fallback
      .evaluate(async () => {
        const video = document.querySelector('video')
        if (!video) return 0
        const before = video.currentTime
        await new Promise((resolve) => setTimeout(resolve, 3000))
        return video.currentTime - before
      })
      .catch(() => 0)
    report.record('HLS 画面在持续推进', advanced > 0.5, `3 秒内推进了 ${advanced.toFixed(2)} 秒`)

    // ---------------------------------------------------------------- 鉴权
    report.section('8. 鉴权与房间路由')

    // 观看端现在是短链接公开访问：裸 POST（不带任何令牌）**不该**被 401。
    // 注意这里塞的是假 SDP（v=0），所以 400 之类的「内容不合法」是正常的 ——
    // 要的是「不是鉴权拒绝」。
    const anonView = await fetch(`${config.base}/whep/${config.room}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0',
      signal: AbortSignal.timeout(10000),
    }).catch((error) => ({ status: `连不上（${error.message}）` }))
    if (config.openMode) {
      report.record(
        '开放模式：不带任何令牌也不被拒（不是 401）',
        typeof anonView.status === 'number' && anonView.status !== 401 && anonView.status !== 403,
        `POST /whep/${config.room}（无 ?k=）→ HTTP ${anonView.status}（假 SDP，非 401 即算通过）`,
      )
    } else {
      report.record(
        '受控模式：不带令牌被拒（401/403）',
        anonView.status === 401 || anonView.status === 403,
        `POST /whep/${config.room}（无 ?k=）→ HTTP ${anonView.status}`,
      )
    }

    if (config.openMode) {
      // 开放模式下没有「观看令牌」这个概念，硬塞一个错的也没有意义：
      // 说明清楚并跳过，绝不算失败。
      report.note(
        '开放模式：跳过「错误观看令牌 → 401」这条（VIEW_TOKEN 为空，观看端本来就不校验令牌）。' +
          '要验受控模式，在 .env 里给 VIEW_TOKEN 填个值再跑。',
      )
    } else {
      const badView = await fetch(`${config.base}/whep/${config.room}?k=nope-nope-nope`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: 'v=0',
        signal: AbortSignal.timeout(10000),
      }).catch((error) => ({ status: `连不上（${error.message}）` }))
      report.record(
        '错误观看令牌被拒（401/403）',
        badView.status === 401 || badView.status === 403,
        `POST /whep/${config.room}?k=nope… → HTTP ${badView.status}`,
      )
    }

    // 推流端不变，而且现在只有它一个门：令牌错、或者干脆不带，都必须 401。
    const badPublish = await fetch(`${config.base}/whip/${config.room}?k=nope-nope-nope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0',
      signal: AbortSignal.timeout(10000),
    }).catch((error) => ({ status: `连不上（${error.message}）` }))
    report.record(
      '错误推流令牌被拒（401/403）',
      badPublish.status === 401 || badPublish.status === 403,
      `POST /whip/${config.room}?k=nope… → HTTP ${badPublish.status}`,
    )

    const anonPublish = await fetch(`${config.base}/whip/${config.room}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0',
      signal: AbortSignal.timeout(10000),
    }).catch((error) => ({ status: `连不上（${error.message}）` }))
    report.record(
      '不带推流令牌被拒（401/403）—— 推流是唯一的门',
      anonPublish.status === 401 || anonPublish.status === 403,
      `POST /whip/${config.room}（无 ?k=）→ HTTP ${anonPublish.status}`,
    )

    // 房间号写错必须是 404：掉到静态站上返回 200 + 一坨 HTML 是最坑的失败方式，
    // 客户端会拿 HTML 当 SDP 用，报错牛头不对马嘴。
    const wrongWhep = await fetch(withToken(`${config.base}/whep/definitely-not-a-room`, config.viewToken), {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0',
      signal: AbortSignal.timeout(10000),
    }).catch((error) => ({ status: `连不上（${error.message}）` }))
    report.record(
      '房间名写错 → 404',
      wrongWhep.status === 404,
      `POST /whep/definitely-not-a-room → HTTP ${wrongWhep.status}`,
    )

    const wrongHls = await fetch(withToken(`${config.base}/hls/definitely-not-a-room/index.m3u8`, config.viewToken), {
      signal: AbortSignal.timeout(10000),
    }).catch((error) => ({ status: `连不上（${error.message}）` }))
    report.record(
      'HLS 房间名写错 → 404',
      wrongHls.status === 404,
      `GET /hls/definitely-not-a-room/index.m3u8 → HTTP ${wrongHls.status}`,
    )

    report.note(`出口预算参考：${EGRESS_BUDGET_MBPS} Mbps 总出口，按 1.07 开销系数留给观众约 3.4 Mbps。`)

    return report.summary()
  } finally {
    clearWatchdog()
    await stopSyntheticPublisher(publisher).catch(() => undefined)
    for (const page of [fallback, viewer, publisher]) await page?.close().catch(() => undefined)
    await browser?.close().catch(() => undefined)
  }
}

// 只设 exitCode，**不要** process.exit()：fetch（undici）的长连接还没关干净就被硬退，
// 在 Windows 上会撞 libuv 的 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，
// 退出一堆红字，看着像脚本自己崩了。让 Node 自然收尾即可。
try {
  process.exitCode = await main()
} catch (error) {
  reportFatal(error)
  process.exitCode = 1
}
