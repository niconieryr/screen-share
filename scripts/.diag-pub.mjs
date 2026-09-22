/**
 * 临时诊断（用完即删）：推流页被挤到后台之后，视频轨还在出帧吗？
 *
 * 探针用 HLS 的 video 变体播放列表：里面的 `#EXT-X-GAP` 数量就代表「这一段没有视频数据」。
 * 全是 gap = 视频轨停了 —— 那 e2e 第 7 节「HLS 不出画」就是**测试自己的假象**
 * （合成推流的画布在后台标签里被 Chrome 降频），而不是产品缺陷。
 *
 *   node scripts/.diag-pub.mjs [--rounds=7] [--interval=30]
 */
import {
  launchBrowser,
  openOriginPage,
  parseArgs,
  readSenderStats,
  resolveConfig,
  sleep,
  startSyntheticPublisher,
  stopSyntheticPublisher,
  withToken,
} from './lib/harness.mjs'

const args = parseArgs(process.argv.slice(2))
const config = resolveConfig(args, { need: ['publishToken'] })
const rounds = Number.parseInt(args.flags.rounds ?? '7', 10)
const intervalSec = Number.parseInt(args.flags.interval ?? '30', 10)

const browser = (await launchBrowser()).browser
let publisher = null
try {
  publisher = await openOriginPage(browser, config.base)
  const publish = await startSyntheticPublisher(publisher, {
    base: config.base,
    room: config.room,
    token: config.publishToken,
    label: 'pubdiag',
  })
  console.log(`推流 ${publish.state}，轨道 ${publish.sentTracks.join(' + ')}`)

  // 关键：立刻开一个前台页，把推流页挤到后台 —— 复现 e2e 里「推流页一直不是前台页」的时序
  const foreground = await browser.newPage()
  await foreground.goto(`${config.base}/screen`, { waitUntil: 'domcontentloaded' })
  console.log('推流页已退到后台，开始观测：\n')
  console.log('   时刻   视频轨 framesEncoded / bytesSent      HLS video 变体 GAP / 真实分片')

  for (let round = 1; round <= rounds; round += 1) {
    await sleep(intervalSec * 1000)
    let line = `  ${String(round * intervalSec).padStart(4)}s   `
    try {
      const stats = await readSenderStats(publisher, { waitMs: 2000 })
      const video = stats.outbound.find((track) => track.kind === 'video')
      line += `frames=${String(video?.framesEncoded ?? '?').padStart(6)} bytes=${String(video?.bytes ?? '?').padStart(9)}   `
    } catch (error) {
      line += `(读统计失败: ${error.message})   `
    }
    try {
      const master = await fetch(withToken(`${config.base}/hls/${config.room}/index.m3u8`, config.viewToken)).then(
        (response) => response.text(),
      )
      const variantLine = master.split('\n').find((row) => row.includes('video') && row.includes('.m3u8'))
      if (!variantLine) {
        line += 'master 里没有 video 变体'
      } else {
        const variantUrl = new URL(variantLine.trim(), `${config.base}/hls/${config.room}/`).href
        const variant = await fetch(variantUrl).then((response) => response.text())
        const gaps = (variant.match(/#EXT-X-GAP/g) ?? []).length
        const segments = (variant.match(/_seg\d+\.mp4/g) ?? []).length
        line += `GAP=${String(gaps).padStart(3)}  分片=${String(segments).padStart(3)}`
      }
    } catch (error) {
      line += `(读播放列表失败: ${error.message})`
    }
    console.log(line)
  }
} finally {
  try {
    if (publisher) await stopSyntheticPublisher(publisher)
  } catch (error) {
    console.log(`停推流失败：${error.message}`)
  }
  await browser.close()
}
