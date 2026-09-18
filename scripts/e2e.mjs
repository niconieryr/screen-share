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
  reportFatal,
  resolveConfig,
  sdpCodecs,
  startSyntheticPublisher,
  stopSyntheticPublisher,
  waitForStreamReady,
} from './lib/harness.mjs'

const USAGE = `
screen-share 端到端验收

用法：
  node scripts/e2e.mjs [选项]

选项：
  --base=<url>            对外地址（默认 http://43.142.33.45:8443）
  --room=<名字>           房间号（默认 share01，nginx 里是固化的）
  --view-token=<令牌>     观看令牌（默认取环境变量 VIEW_TOKEN，再取 .env 的 VIEW_TOKEN）
  --publish-token=<令牌>  推流令牌（默认取环境变量 PUBLISH_TOKEN，再取 .env 的 PUBLISH_TOKEN）
  --canvas=1920x1080      合成推流的画布尺寸（默认 1280x720）
  --hls-timeout=<秒>      HLS 降级出画的超时上限（默认 60，超时即失败）
  --timeout=<秒>          整个脚本的总超时（默认 300）
  --help                  看这段

验收项：WHIP 建流 / WHEP 出画 / 音轨是 Opus / WHEP DELETE / 降级 HLS / 错误令牌 401 /
        零转码（分辨率与编码一致）/ 房间名写错 404
`

// ------------------------------------------------------------------ 小工具

/** 打开观众页并尽量让它开始播。设计上可能有个「进入房间」门禁，有就点，没有就往下走。 */
async function openWatchPage(browser, config, { blockWhep = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } })
  page.setDefaultTimeout(config.pageTimeoutMs)
  page.setDefaultNavigationTimeout(config.pageTimeoutMs)

  const seen = { hls: [], bad: [] }
  page.on('request', (request) => {
    if (request.url().includes('/hls/') && request.url().includes('.m3u8')) seen.hls.push(request.url())
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

  await page.goto(`${config.base}/?k=${encodeURIComponent(config.viewToken)}`, {
    waitUntil: 'domcontentloaded',
  })

  // 有门禁按钮就点（旧项目是这样）；新页面直接带 ?k= 自动播，那就点不到，属正常
  await page
    .getByRole('button', { name: /进入房间|进入观看|开始观看/ })
    .first()
    .click({ timeout: 3000 })
    .catch(() => undefined)

  // 自动播放策略：带声音的自动播放可能被拦，主动 play() 一下。
  // 注意这不影响断言 —— 断言要的是 videoWidth > 0（真有画面），不是 paused。
  await page
    .evaluate(() => {
      const video = document.querySelector('video')
      video?.play?.().catch(() => undefined)
    })
    .catch(() => undefined)
  return { page, seen }
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
        return `videoWidth=${video.videoWidth} readyState=${video.readyState} paused=${video.paused} currentTime=${video.currentTime.toFixed(2)}`
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
      return {
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
        muted: video.muted,
        audioTracks: video.srcObject?.getAudioTracks?.().length ?? 0,
      }
    })
    .catch(() => null)
}

// ------------------------------------------------------------------ 主流程

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.help) {
    console.log(USAGE.trim())
    return 0
  }

  const config = resolveConfig(args, { need: ['viewToken', 'publishToken'] })
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
  report.info(`观看令牌 ${config.viewToken ? '已配置' : '缺失'}（来自 ${config.viewTokenFrom}）`)
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

  if (!config.viewToken || !config.publishToken) {
    const missing = [!config.viewToken && '观看令牌', !config.publishToken && '推流令牌'].filter(Boolean)
    report.record('令牌齐备', false, `缺 ${missing.join(' 和 ')}`)
    report.note('用 --view-token=… / --publish-token=… 传，或设同名环境变量，或在项目根目录的 .env 里写')
    report.note('VIEW_TOKEN=… / PUBLISH_TOKEN=…（.env 现在可能还不存在）。')
    return report.summary()
  }

  // 总超时看门狗：宁可自己了断，也不要挂死
  const clearWatchdog = installWatchdog(watchdogMs, '验收')

  let browser = null
  let publisher = null
  let viewer = null
  let fallback = null

  try {
    report.section('1. 合成一路 WHIP 推流（canvas + 振荡器，H.264 + Opus）')
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
      report.record('WHIP 推流建立成功（PeerConnection connected）', false, error?.message ?? String(error))
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
      '服务端已就绪（WHEP 能建会话）',
      ready.ok,
      ready.ok
        ? `${ready.attempts} 次探测后成功，耗时 ${ready.seconds.toFixed(1)} 秒`
        : `${ready.seconds.toFixed(1)} 秒内 ${ready.attempts} 次探测都失败，最后一次 HTTP ${ready.status} ${ready.body}`,
    )
    if (!ready.ok) {
      report.note('流都拉不到，后面的断言没有意义，先解决推流到服务端这一段。')
      return report.summary()
    }

    // ---------------------------------------------------------------- WHEP
    report.section('2. WHEP 主路径（裸会话读接收侧统计）')

    const sender = await readSenderStats(publisher, { waitMs: 1500 })
    const senderVideo = sender.outbound.find((item) => item.kind === 'video') ?? null
    const senderAudio = sender.outbound.find((item) => item.kind === 'audio') ?? null

    // 这一路接了个自建 <video>：既证「服务端真的在发」，也证「浏览器真能解出画面」，
    // 和前端页面写得怎么样无关。位置：见 harness 的 attachVideo。
    const received = await readReceivedStats(publisher, {
      base: config.base,
      room: config.room,
      token: config.viewToken,
      waitMs: 6000,
      attachVideo: true,
    })
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
      'WHEP 的 Location 指回对外地址且带令牌',
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
    report.section('3. 服务端零转码（推流与收看一致）')

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
    report.section('4. 观看页出画面（前端实现）')

    // 上面那路是自建 <video>，证明的是链路；这一路走真实观众页，
    // 证明的是「页面自己会拉流并渲染」。两者分开，出问题时一眼能分清是谁的锅。
    const watch = await openWatchPage(browser, config)
    viewer = watch.page
    const picture = await waitForPicture(viewer, 30000)
    report.record(
      '观众页出画面（videoWidth > 0，不是只有 currentTime 在走）',
      picture.ok,
      picture.ok ? `耗时 ${picture.seconds.toFixed(1)} 秒` : `30 秒内没出画：${picture.observed}`,
    )
    if (picture.ok) {
      const shown = await readPlayback(viewer)
      if (shown) {
        report.note(
          `页面 video：${shown.width}×${shown.height}，paused=${shown.paused}，muted=${shown.muted}，音轨 ${shown.audioTracks} 条`,
        )
      }
    }
    const badOnWatchPage = watch.seen.bad.filter((line) => !line.includes('/whep/'))
    report.record(
      '观看页没有意料之外的失败请求',
      badOnWatchPage.length === 0,
      badOnWatchPage.length ? [...new Set(badOnWatchPage)].join('；') : '干净',
    )

    // ---------------------------------------------------------------- HLS 直连探针
    report.section('5. HLS 兜底链路（直连探针，走完整三级）')

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
      'HLS 分片能取到（不带 ?k=，靠服务端种的 cookie）',
      hls.segment.status === 200,
      hls.segment.url
        ? `HTTP ${hls.segment.status}（${hls.segment.url}；cookie：[${hls.cookies.join(', ') || '无'}]）`
        : `变体播放列表里没解析出分片地址（找到 ${hls.segments} 个候选）`,
    )
    if (hls.trace.length > 1) report.note(`请求轨迹：${hls.trace.join(' → ')}`)

    // ---------------------------------------------------------------- 降级
    report.section('6. WHEP 走不通时自动降级 HLS')

    const blocked = await openWatchPage(browser, config, { blockWhep: true })
    fallback = blocked.page
    const fallbackStarted = Date.now()
    const fallbackPicture = await waitForPicture(fallback, hlsTimeoutMs)
    const fallbackSeconds = (Date.now() - fallbackStarted) / 1000
    report.record(
      '拦掉 WHEP 后仍能出画（超时算失败）',
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
    report.section('7. 鉴权与房间路由')

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

    // 房间号写错必须是 404：掉到静态站上返回 200 + 一坨 HTML 是最坑的失败方式，
    // 客户端会拿 HTML 当 SDP 用，报错牛头不对马嘴。
    const wrongWhep = await fetch(`${config.base}/whep/definitely-not-a-room?k=${encodeURIComponent(config.viewToken)}`, {
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

    const wrongHls = await fetch(`${config.base}/hls/definitely-not-a-room/index.m3u8?k=${encodeURIComponent(config.viewToken)}`, {
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

try {
  process.exit(await main())
} catch (error) {
  reportFatal(error)
  process.exit(1)
}
