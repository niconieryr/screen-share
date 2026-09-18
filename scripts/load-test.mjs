#!/usr/bin/env node
/**
 * screen-share 并发压测：N 路**只收不渲染**的 WHEP 会话压服务端。
 *
 * 为什么只收不渲染：
 *   MediaMTX 照样要为每一路做 RTP 打包和发送，服务端该干的活一点没少；
 *   但不把流挂到 <video> 上就没有渲染、合成、上屏这些活，跑压测的这台机器
 *   不会因为自己画不过来而拖慢压测结果。
 *   注意实测：Chrome **仍然会解码**收到的视频（只是没人渲染），所以路数开到
 *   几十路时本机 CPU 一样会成为瓶颈 —— 那属于压测机的极限，不是服务端的。
 *   （旧项目那版还额外开了几路完整页面做端到端渲染 —— 那是在量本机，
 *     新部署的瓶颈是 4 Mbps 出口带宽，所以砍掉，省下的资源全给转发路数。）
 *
 * 每路的实际码率从 bytesReceived 的差值算，不按参数估：
 * 合成画面压缩率远高于真实屏幕内容，估出来的数字没有参考价值。
 *
 * 用法：
 *   node scripts/load-test.mjs              # 默认 4 路
 *   node scripts/load-test.mjs --n=10
 *   node scripts/load-test.mjs --n=10 --seconds=20 --base=http://43.142.33.45:8443
 *   node scripts/load-test.mjs --publish-token=…
 *
 * 观看端是短链接公开访问：VIEW_TOKEN 为空（默认）时所有 WHEP 请求都不带 ?k=；
 * 填了令牌就自动带上。推流令牌始终必填。
 *
 * 退出码 0 = 所有会话都建起来了，1 = 有失败。
 */
import {
  EGRESS_BUDGET_MBPS,
  EGRESS_TARGET_MBPS,
  OVERHEAD_FACTOR,
  checkReachable,
  closeWhepSessions,
  createReporter,
  installWatchdog,
  launchBrowser,
  openOriginPage,
  openWhepSessions,
  parseArgs,
  reportFatal,
  resolveConfig,
  sampleWhepBitrates,
  startSyntheticPublisher,
  stopSyntheticPublisher,
  waitForStreamReady,
} from './lib/harness.mjs'

const USAGE = `
screen-share 并发压测（默认 N=4）

用法：
  node scripts/load-test.mjs [选项]

选项：
  --n=<人数>              并发只收会话数（默认 4）
  --seconds=<秒>          码率采样时长（默认 15）
  --base=<url>            对外地址（默认 http://43.142.33.45:8443）
  --room=<名字>           房间号（默认 share01）
  --view-token=<令牌>     观看令牌（默认环境变量 VIEW_TOKEN → .env）。留空 = 开放模式，
                          请求不带 ?k=；有值 = 受控模式，自动带上
  --publish-token=<令牌>  推流令牌（默认环境变量 PUBLISH_TOKEN → .env），必填
  --canvas=1920x1080      合成推流的画布尺寸（默认 1280x720）
  --timeout=<秒>          整个脚本的总超时（默认 300）
  --help                  看这段

预算口径：出口 = 码率 × 人数 × ${OVERHEAD_FACTOR}；总出口 ${EGRESS_BUDGET_MBPS} Mbps，
         预留 15% 余量后目标 ≤${EGRESS_TARGET_MBPS} Mbps。详见 docs/OBS-设置.md。
`

const mbps = (value) => `${(value / 1_000_000).toFixed(2)} Mbps`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.flags.help) {
    console.log(USAGE.trim())
    return 0
  }

  // 观看令牌可选（空 = 开放模式），推流令牌必填
  const config = resolveConfig(args, { need: ['publishToken'] })
  const report = createReporter()

  const count = Number.parseInt(args.flags.n ?? '4', 10)
  const seconds = Number.parseFloat(args.flags.seconds ?? '15') || 15
  const watchdogMs = (Number.parseFloat(args.flags.timeout ?? '300') || 300) * 1000
  const [canvasWidth, canvasHeight] = String(args.flags.canvas ?? '1280x720')
    .split('x')
    .map((value) => Number.parseInt(value, 10))

  if (!Number.isFinite(count) || count < 1) {
    report.record('--n 是正整数', false, `实际拿到 ${JSON.stringify(args.flags.n)}`)
    return report.summary('压测结果')
  }

  console.log('screen-share 并发压测（只收不渲染，量的是服务端）')
  report.info(`目标       ${config.base}（来自 ${config.baseFrom}）`)
  report.info(`房间       ${config.room}`)
  report.info(`观看入口   ${config.viewerURL}（${config.openMode ? '开放模式，请求不带 ?k=' : '受控模式，请求带 ?k='}）`)
  report.info(`并发路数   ${count} 路 recvonly WHEP`)
  report.info(`采样时长   ${seconds} 秒`)

  // ---------------------------------------------------------------- 前置
  report.section('0. 前置检查')

  const reach = await checkReachable(config.base)
  if (!reach.ok) {
    report.record('目标可达', false, `${config.base} —— ${reach.error}`)
    report.note('没部署 / 安全组和 ufw 没放行 8443 / 本机网络不通，都会长这样。')
    return report.summary('压测结果')
  }
  report.record('目标可达', true, `${config.base} → HTTP ${reach.status}（${reach.ms}ms）`)

  if (!config.publishToken) {
    report.record('推流令牌齐备', false, '推流令牌是必填的 —— 少了它连合成推流都建不起来')
    report.note('用 --publish-token=… 传，或设环境变量 PUBLISH_TOKEN，或在项目根目录 .env 里写 PUBLISH_TOKEN=…。')
    return report.summary('压测结果')
  }

  const clearWatchdog = installWatchdog(watchdogMs, '压测')

  let browser = null
  let publisher = null
  let swarm = null

  try {
    // ---------------------------------------------------------------- 推流
    report.section('1. 合成一路 WHIP 推流（没有源就没人可压）')

    const launched = await launchBrowser()
    browser = launched.browser
    report.info(`浏览器     ${launched.used}`)

    publisher = await openOriginPage(browser, config.base)
    const publish = await startSyntheticPublisher(publisher, {
      base: config.base,
      room: config.room,
      token: config.publishToken,
      label: 'load',
      width: canvasWidth,
      height: canvasHeight,
      fps: 30,
    })
    report.record(
      'WHIP 推流建立成功',
      publish.state === 'connected',
      `连接状态 ${publish.state}，画布 ${publish.width}×${publish.height}`,
    )

    // 推流刚 connected 时 MediaMTX 还没把流登记好，这时候直接开 N 路会全 404
    // （实测踩到过），所以先等它真的可拉。
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
      report.note('源这边就没通，先解决推流/拉流，再谈并发。')
      return report.summary('压测结果')
    }

    // ---------------------------------------------------------------- N 路并发
    report.section(`2. 开 ${count} 路只收不渲染的 WHEP 会话`)

    const swarmPage = await openOriginPage(browser, config.base)
    swarm = swarmPage
    const opened = await openWhepSessions(swarmPage, {
      base: config.base,
      room: config.room,
      token: config.viewToken,
      count,
    })
    report.record(
      `${count} 路会话全部建立`,
      opened.connected === count,
      `${opened.connected}/${count} 建立成功${opened.failures.length ? `；失败：${opened.failures.slice(0, 4).join('，')}` : ''}`,
    )

    if (opened.connected === 0) {
      report.note('一路都没建起来，采样没有意义，收摊。')
      return report.summary('压测结果')
    }

    // ---------------------------------------------------------------- 采样
    report.section(`3. 采样 ${seconds} 秒，读每路实际码率`)

    const sample = await sampleWhepBitrates(swarmPage, { seconds })
    const rows = sample.rows.filter((row) => row.bps > 0)
    const perSession = rows.map((row) => row.bps)
    const average = perSession.length ? perSession.reduce((sum, value) => sum + value, 0) / perSession.length : 0
    const minimum = perSession.length ? Math.min(...perSession) : 0
    const maximum = perSession.length ? Math.max(...perSession) : 0
    const total = perSession.reduce((sum, value) => sum + value, 0)
    const withOverhead = total * OVERHEAD_FACTOR

    report.record(
      '采样期间确实收到了数据',
      total > 0,
      total > 0 ? `${opened.connected} 路合计 ${mbps(total)}` : `${seconds} 秒里一路都没收到字节`,
    )
    // 有字节 ≠ 有可解码的画面：分片/RTP 乱掉时字节照样在涨。帧数一起看才稳。
    report.record(
      '每路都解出了画面帧（不只是字节在涨）',
      rows.length === opened.connected && rows.every((row) => row.framesDecoded > 0),
      rows.length
        ? `${rows.length} 路，最低解码帧数 ${Math.min(...rows.map((row) => row.framesDecoded))}`
        : '一路都没采到数据',
    )

    // 按「当前实测码率」推：出口预算内还能塞下几个人
    const perPersonEgress = average * OVERHEAD_FACTOR
    const maxPeople = perPersonEgress > 0 ? Math.floor(EGRESS_TARGET_MBPS * 1_000_000 / perPersonEgress) : 0
    const budgetUsed = (withOverhead / 1_000_000 / EGRESS_BUDGET_MBPS) * 100

    console.log(`\n${'='.repeat(64)}`)
    console.log(`并发压测结果（N=${opened.connected}，采样 ${seconds} 秒）`)
    console.log('-'.repeat(64))
    console.log(`  会话建立            ${opened.connected}/${count}`)
    console.log(`  单路实测码率        平均 ${mbps(average)}（最低 ${mbps(minimum)} / 最高 ${mbps(maximum)}）`)
    console.log(`  合计实测出口        ${mbps(total)}`)
    console.log(`  算上 ${OVERHEAD_FACTOR} 开销后    ${mbps(withOverhead)}   ← 出口预算 ${EGRESS_BUDGET_MBPS} Mbps，目标 ≤${EGRESS_TARGET_MBPS} Mbps`)
    console.log(
      `  当前 ${opened.connected} 人占用预算   ${budgetUsed.toFixed(1)}%` +
        `（${budgetUsed > 85 ? '已经超了预留线' : '还在预留线以内'}）`,
    )
    console.log(`  当前码率下最多支撑   ${maxPeople} 人（按 ${mbps(perPersonEgress)}/人 算，目标线 ${EGRESS_TARGET_MBPS} Mbps）`)
    console.log('-'.repeat(64))
    for (const row of sample.rows) {
      console.log(
        `   #${String(row.index).padStart(2)}  ${mbps(row.bps).padStart(12)}   解码帧数 ${String(row.framesDecoded).padStart(4)}`,
      )
    }
    console.log('  （Chrome 收下就会解码，只是没人渲染；路数很多时本机 CPU 会成为瓶颈，那不算服务端的问题）')
    console.log('-'.repeat(64))
    console.log('  注：上面是**合成画面**（大片纯色 + 一个方块）的码率，压缩率远高于真实屏幕内容，')
    console.log('      只适合验证「服务端能不能扛住 N 路并发」，不能拿来当出口预算的依据。')
    console.log('      真实屏幕内容按 OBS 的 CBR 预设估（出口 = 码率 × 人数 × 1.07）：')
    const presets = [
      { label: '700 kbps/人（3-4 人默认档，1080p20）', video: 700, audio: 48 },
      { label: '1400 kbps/人（1-2 人画质档，1080p30）', video: 1400, audio: 96 },
      { label: '2500 kbps/人（画质档上限）', video: 2500, audio: 96 },
    ]
    for (const preset of presets) {
      const person = (preset.video + preset.audio) * 1000 * OVERHEAD_FACTOR
      const people = Math.floor((EGRESS_TARGET_MBPS * 1_000_000) / person)
      console.log(
        `        ${preset.label.padEnd(40)} 每人 ${mbps(person)}，${EGRESS_TARGET_MBPS} Mbps 内最多 ${people} 人`,
      )
    }
    console.log(
      `        10 人时每人只有 ${mbps((EGRESS_BUDGET_MBPS * 1_000_000) / 10)} 可用` +
        `（扣掉 ${OVERHEAD_FACTOR} 开销和 48 kbps 音频，视频实际只剩约 320 kbps）—— 屏幕文字必糊，先解决出口带宽`,
    )
    console.log('='.repeat(64))

    const deletes = await sampleAllRequests(swarmPage)
    if (deletes.length) report.note(`收摊时 DELETE 各路的返回：${deletes.join(', ')}`)

    return opened.connected === count && total > 0 ? 0 : 1
  } finally {
    clearWatchdog()
    await stopSyntheticPublisher(publisher).catch(() => undefined)
    await Promise.all([swarm, publisher].filter(Boolean).map((page) => page.close().catch(() => undefined)))
    await browser?.close().catch(() => undefined)
  }
}

/** 收摊时先 DELETE 再关（趁 pc 还活着，见 harness 里的说明）。 */
async function sampleAllRequests(page) {
  if (!page) return []
  try {
    return await closeWhepSessions(page)
  } catch {
    return []
  }
}

try {
  process.exit(await main())
} catch (error) {
  reportFatal(error)
  process.exit(1)
}
