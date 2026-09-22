/**
 * 临时诊断脚本（用完即删）：为什么「拦掉 WHEP → 自动降级 HLS」在浏览器里不出画。
 *
 * 和 e2e 的第 7 节做同一件事，但把页面控制台、失败请求、以及 hls.js 拿到的
 * 播放列表内容全部打出来 —— 光看 videoWidth=0 猜不出原因。
 *
 *   node scripts/.diag-hls.mjs [--seconds=45]
 */
import {
  launchBrowser,
  openOriginPage,
  parseArgs,
  probeHls,
  resolveConfig,
  sleep,
  startSyntheticPublisher,
  stopSyntheticPublisher,
  waitForStreamReady,
} from './lib/harness.mjs'

const args = parseArgs(process.argv.slice(2))
const config = resolveConfig(args, { need: ['publishToken'] })
config.pageTimeoutMs = 30000
const seconds = Number.parseFloat(args.flags.seconds ?? '45') || 45
// 预热：e2e 里第 7 节是在推流跑了 2-3 分钟之后才执行的，这里复现那个时序
const warmup = Number.parseFloat(args.flags.warmup ?? '0') || 0
// 复现 e2e 的页面序列：第 5 节会开一个正在放 WHEP 的观众页并**留着不关**
const extraPages = Number.parseInt(args.flags['extra-pages'] ?? '0', 10) || 0
// 复现 e2e 第 6 节：先用直连探针碰一次 HLS —— 这会让 MediaMTX 的 HLS 会话先跑起来，
// 于是浏览器变成「中途加入」，必须靠 _HLS_msn 阻塞式刷新拿新分片
const probeFirst = Boolean(args.flags['probe-first'])

const browserRef = await launchBrowser()
const browser = browserRef.browser
console.log(`浏览器 ${browserRef.used}`)
console.log(`目标   ${config.base}（${config.baseFrom}）`)
console.log(`观看   ${config.viewerURL}`)

let publisher = null
try {
  publisher = await openOriginPage(browser, config.base)
  const publish = await startSyntheticPublisher(publisher, {
    base: config.base,
    room: config.room,
    token: config.publishToken,
    label: 'diag',
  })
  console.log(`推流   ${publish.state}，轨道 ${publish.sentTracks.join(' + ')}`)
  const ready = await waitForStreamReady(publisher, {
    base: config.base,
    room: config.room,
    token: config.viewToken,
  })
  console.log(`就绪   ${JSON.stringify(ready)}`)

  // 复现 e2e 第 5 节：开一个正常观众页（走 WHEP 出画）并留着不管它
  for (let index = 0; index < extraPages; index += 1) {
    const extra = await browser.newPage({ viewport: { width: 960, height: 600 } })
    await extra.goto(config.viewerURL, { waitUntil: 'domcontentloaded' })
    console.log(`已另开一个观众页（第 ${index + 1} 个，走 WHEP，保持打开）`)
  }

  // 复现 e2e 第 6 节：直连探针先碰一遍 HLS（master → 变体 → 分片）
  if (probeFirst) {
    const probe = await probeHls(config.base, config.room, config.viewToken)
    console.log(
      `直连探针：master=${probe.masterStatus} 变体=${probe.variant.status} 分片=${probe.segment.status}` +
        `（媒体序号已经跑起来了，下面浏览器属于中途加入）`,
    )
  }

  const page = await browser.newPage({ viewport: { width: 960, height: 600 } })
  const events = []
  const hlsStats = { total: 0, byStatus: {}, withLocation: [], firstM3u8: null }
  page.on('console', (m) => events.push(`[console.${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => events.push(`[pageerror] ${e.message}`))
  page.on('requestfailed', (r) => events.push(`[requestfailed] ${r.failure()?.errorText} ${r.url()}`))
  page.on('request', (r) => {
    const u = r.url()
    if (u.includes('/hls/')) hlsStats.total += 1
    if (u.includes('/assets/')) events.push(`[request] ${u}`)
  })
  page.on('response', async (r) => {
    const u = r.url()
    if (u.includes('/hls/')) {
      hlsStats.byStatus[r.status()] = (hlsStats.byStatus[r.status()] ?? 0) + 1
      const loc = r.headers()['location']
      if (loc) hlsStats.withLocation.push(`${r.status()} ${u} → Location: ${loc}`)
    }
    if (r.status() >= 400) events.push(`[http ${r.status()}] ${r.request().method()} ${u}`)
    if (u.includes('.m3u8')) {
      let body = ''
      try {
        body = await r.text()
      } catch (error) {
        body = `(读不到 body: ${error.message})`
      }
      if (!hlsStats.firstM3u8) hlsStats.firstM3u8 = `${u}\n${body.slice(0, 700)}`
      if (body.includes('#EXT-X-GAP')) {
        const gaps = (body.match(/#EXT-X-GAP/g) ?? []).length
        const reals = (body.match(/^[0-9a-f]{12}_\w+_seg\d+\.mp4/gm) ?? []).length
        events.push(`[GAP 统计] ${u}\n  #EXT-X-GAP × ${gaps}，真实分片 × ${reals}`)
      }
    }
  })
  // 和 e2e 第 7 节一样：掐掉所有 WHEP，逼页面走 HLS
  await page.route('**/whep/**', (route) => route.abort())
  if (warmup > 0) {
    console.log(`先预热 ${warmup} 秒（复现 e2e 里「推流已经跑了几分钟」的时序）……`)
    await sleep(warmup * 1000)
  }
  await page.goto(config.viewerURL, { waitUntil: 'domcontentloaded' })
  console.log(`等 ${seconds} 秒看它出不出画……`)
  await sleep(seconds * 1000)

  const state = await page.evaluate(() => {
    const video = document.querySelector('video')
    if (!video) return null
    return {
      readyState: video.readyState,
      networkState: video.networkState,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      currentTime: video.currentTime,
      paused: video.paused,
      muted: video.muted,
      src: video.src,
      error: video.error ? { code: video.error.code, message: video.error.message } : null,
      buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
    }
  })
  console.log('\n===== video 状态 =====')
  console.log(JSON.stringify(state, null, 2))
  console.log('\n===== HLS 请求统计 =====')
  console.log(`总数 ${hlsStats.total}，按状态码：${JSON.stringify(hlsStats.byStatus)}`)
  console.log(`带 Location 的响应：${hlsStats.withLocation.length} 条`)
  hlsStats.withLocation.slice(0, 10).forEach((line) => console.log(`  ${line}`))
  console.log('\n===== 第一次 m3u8 响应 =====')
  console.log(hlsStats.firstM3u8 ?? '(没有)')
  console.log('\n===== 事件（去重后前 60 条） =====')
  const seenEvents = new Set()
  const unique = events.filter((line) => {
    const key = line.replace(/[0-9a-f]{12}|part\d+|seg\d+|_HLS_msn=\d+|_HLS_part=\d+/g, 'X')
    if (seenEvents.has(key)) return false
    seenEvents.add(key)
    return true
  })
  console.log(unique.slice(0, 60).join('\n'))
  console.log(`\n（原始事件 ${events.length} 条，去重后 ${unique.length} 条）`)
} finally {
  try {
    if (publisher) await stopSyntheticPublisher(publisher)
  } catch (error) {
    console.log(`停推流失败：${error.message}`)
  }
  await browser.close()
}
