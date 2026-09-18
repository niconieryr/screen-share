#!/usr/bin/env node
/**
 * 从 OBS 自己的日志里核对推流参数是不是真的生效了。
 *
 * 为什么要这么验：写进 profile 的编码器设置，OBS 认不认、键名对不对，
 * 只有它自己启动编码器时打在日志里的那份「settings:」才算数。
 * 猜是猜不准的，读日志是确定的。
 *
 * 这里带上了旧项目最后两个提交的修正：
 *   1. 关键帧判断读日志里的**实际帧率**（video settings reset 块），不再写死 30fps ——
 *      60fps 下正确的 keyint=60 曾被误报成 FAIL。
 *   2. profile 的 streamEncoder.json 必须是**顶层扁平键**，OBS 才会应用；
 *      写成 {"obs_nvenc_h264_tex": {...}} 这种嵌套结构，OBS 一个键都不读，
 *      安安静静用回默认值，界面上完全看不出来。所以这里顺手把两件事都戳穿。
 *
 * 用法：
 *   node scripts/check-obs.mjs                    # 按默认档核对（700 kbps / 20fps / 2 秒关键帧）
 *   node scripts/check-obs.mjs --preset=quality   # 按画质档核对（1400-2500 kbps / 30fps）
 *   node scripts/check-obs.mjs --bitrate=700 --fps=20 --keyint-sec=2
 *   node scripts/check-obs.mjs --log="C:\\...\\obs-studio\\logs\\2026-01-01 12-00-00.txt"
 *
 * 退出码 0 = 全过，1 = 有失败。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { createReporter, parseArgs } from './lib/harness.mjs'

const USAGE = `
从 OBS 日志核对真实生效的推流参数

用法：
  node scripts/check-obs.mjs [选项]

选项：
  --preset=default|quality  选一套预设（default = 3-4 人档，quality = 1-2 人档）
  --bitrate=<kbps>          期望视频码率（quality 档允许 1400-2500，用 --bitrate-min/--bitrate-max 改）
  --bitrate-min=<kbps>      期望码率下限
  --bitrate-max=<kbps>      期望码率上限
  --fps=<帧率>              期望输出帧率
  --keyint-sec=<秒>         期望关键帧间隔（默认按档位：default 2 秒 / quality 2 秒）
  --audio-kbps=<kbps>       期望音频码率，仅作参考（默认 default 48 / quality 96）
  --log=<路径>              指定日志文件（默认取最新的那份）
  --help                    看这段

两套预设（详见 docs/OBS-设置.md）：
  default  1920x1080 / 20 fps / NVENC H.264 CBR 700 kbps / 关键帧 2 秒 / Opus 48 kbps 单声道
  quality  1920x1080 / 30 fps / NVENC H.264 CBR 1400-2500 kbps / Opus 96 kbps

核对项：编码器是 NVENC H.264、B 帧为 0、CBR、码率、帧率、关键帧间隔、
        音频是 Opus、WHIP 会话建起来了、会话结束时 DELETE 没被拒、
        profile 里的 streamEncoder.json 是 OBS 真会读的扁平格式。
`

// ------------------------------------------------------------------ 参数

const args = parseArgs(process.argv.slice(2))
if (args.flags.help) {
  console.log(USAGE.trim())
  process.exit(0)
}

const preset = String(args.flags.preset ?? 'default').toLowerCase()
if (!['default', 'quality'].includes(preset)) {
  console.error(`--preset 只能是 default 或 quality，实际给了 ${JSON.stringify(args.flags.preset)}`)
  process.exit(1)
}

const numeric = (value, fallback) => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

// 默认值就是 docs/OBS-设置.md 里那两套预设，改文档记得一起改
const expectation =
  preset === 'quality'
    ? {
        label: '画质优先（1-2 人）',
        fps: numeric(args.flags.fps, 30),
        bitrateMin: numeric(args.flags['bitrate-min'], numeric(args.flags.bitrate, 1400)),
        bitrateMax: numeric(args.flags['bitrate-max'], numeric(args.flags.bitrate, 2500)),
        keyintSeconds: numeric(args.flags['keyint-sec'], 2),
        audioKbps: numeric(args.flags['audio-kbps'], 96),
      }
    : {
        label: '默认（3-4 人）',
        fps: numeric(args.flags.fps, 20),
        bitrateMin: numeric(args.flags['bitrate-min'], numeric(args.flags.bitrate, 700)),
        bitrateMax: numeric(args.flags['bitrate-max'], numeric(args.flags.bitrate, 700)),
        keyintSeconds: numeric(args.flags['keyint-sec'], 2),
        audioKbps: numeric(args.flags['audio-kbps'], 48),
      }
if (expectation.bitrateMax < expectation.bitrateMin) {
  expectation.bitrateMax = expectation.bitrateMin
}

const report = createReporter()

// ------------------------------------------------------------------ 日志

const LOG_DIR = join(process.env.APPDATA ?? '', 'obs-studio', 'logs')
const explicitLog = typeof args.flags.log === 'string' ? args.flags.log : ''

if (explicitLog) {
  if (!existsSync(explicitLog)) {
    console.error(`指定的日志不存在：${explicitLog}`)
    process.exit(1)
  }
} else if (!existsSync(LOG_DIR)) {
  console.error(`找不到 OBS 日志目录：${LOG_DIR}`)
  console.error('  先启动一次 OBS、推一次流，再来跑这个脚本。')
  process.exit(1)
}

const newest = explicitLog
  ? { name: explicitLog, path: explicitLog, mtime: statSync(explicitLog).mtimeMs }
  : readdirSync(LOG_DIR)
      .filter((name) => name.endsWith('.txt'))
      .map((name) => ({ name, path: join(LOG_DIR, name), mtime: statSync(join(LOG_DIR, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]

if (!newest) {
  console.error('OBS 日志目录是空的，先启动一次 OBS。')
  process.exit(1)
}

const lines = readFileSync(newest.path, 'utf8').split(/\r?\n/)

console.log('OBS 推流参数核对')
console.log(`  日志 ${newest.name}`)
console.log(`  时间 ${new Date(newest.mtime).toLocaleString('zh-CN')}`)
console.log(`  预设 ${expectation.label}`)
console.log(
  `  期望 编码器 NVENC H.264 / CBR ${expectation.bitrateMin === expectation.bitrateMax ? expectation.bitrateMin : `${expectation.bitrateMin}-${expectation.bitrateMax}`} kbps` +
    ` / ${expectation.fps} fps / 关键帧 ${expectation.keyintSeconds} 秒 / Opus ${expectation.audioKbps} kbps / B 帧 0`,
)

// ------------------------------------------------------------------ 编码器设置

// 注意日志每行都带时间戳前缀，参数行长这样：
//   16:17:24.900: [obs-nvenc: 'simple_video_stream'] settings:
//   16:17:24.900: 	keyint:       250
//   16:17:24.900: 	b-frames:     0
// x264 那条长这样：[x264 encoder: 'simple_video_stream'] settings:
const encoderBlocks = []
const SETTING_LINE = /^\d{2}:\d{2}:\d{2}\.\d{3}:\s+([A-Za-z_][\w-]*):\s+(.+)$/
const ENCODER_HEADER = /\[([a-z0-9_ -]*?encoder|obs-nvenc|jim_nvenc|ffmpeg_[a-z0-9_]+)(?::\s*'([^']+)')?\]\s+settings:/i

for (let index = 0; index < lines.length; index += 1) {
  const match = lines[index].match(ENCODER_HEADER)
  if (!match) continue
  const raw = {}
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const entry = lines[cursor].match(SETTING_LINE)
    if (!entry) break
    raw[entry[1].trim()] = entry[2].trim()
  }
  // 键名归一化：OBS 不同版本写的是 b-frames / bf、look-ahead / lookahead 之类
  const settings = {}
  for (const [key, value] of Object.entries(raw)) {
    settings[key.replace(/[^a-z0-9]/gi, '').toLowerCase()] = value
  }
  encoderBlocks.push({ encoder: match[1], output: match[2] ?? '?', raw, settings, at: lines[index].slice(0, 8) })
}

report.section('1. 视频编码器')

const last = encoderBlocks.at(-1)
if (!last) {
  report.record('找到编码器日志', false, '日志里没有编码器的 settings 块 —— 还没推过流？')
} else {
  console.log(`  编码器输出 ${last.encoder} / ${last.output}（${last.at}）`)
  console.log(`  ${JSON.stringify(last.raw)}\n`)

  report.record(
    '编码器是 NVENC H.264',
    /nvenc/i.test(last.encoder),
    `日志里的编码器是 ${last.encoder}${/nvenc/i.test(last.encoder) ? '' : '（不是 NVENC，检查 OBS 输出设置里的编码器）'}`,
  )

  const bframes = Number.parseInt(last.settings.bframes ?? last.settings.bf ?? '-1', 10)
  report.record(
    '没有 B 帧（浏览器不认 H.264 B 帧，不关就只出声不出画）',
    bframes === 0,
    `b-frames=${bframes}`,
  )

  if (last.settings.ratecontrol) {
    report.record(
      '码率控制是 CBR',
      last.settings.ratecontrol.toUpperCase() === 'CBR',
      `rate_control=${last.settings.ratecontrol}`,
    )
  } else {
    report.note('日志里没有 rate_control 字段，跳过这项')
  }

  // 码率：OBS 日志里是 kbps；万一某个版本打成 bps 也能认出来
  const rawBitrate = Number.parseInt(last.settings.bitrate ?? '', 10)
  const bitrateKbps = Number.isFinite(rawBitrate) ? (rawBitrate > 100000 ? rawBitrate / 1000 : rawBitrate) : null
  const bitrateOk =
    bitrateKbps !== null &&
    bitrateKbps >= expectation.bitrateMin * 0.95 &&
    bitrateKbps <= expectation.bitrateMax * 1.05
  report.record(
    `码率符合预期（${expectation.bitrateMin}${expectation.bitrateMax === expectation.bitrateMin ? '' : `-${expectation.bitrateMax}`} kbps）`,
    bitrateOk,
    bitrateKbps === null ? '日志里没有 bitrate 字段' : `bitrate=${bitrateKbps} kbps`,
  )

  // ---- 帧率：编码器的 settings 里根本没有 fps 字段 ----
  //
  // 帧率在日志的「video settings reset」块里。早先这里写死按 30fps 折算，
  // 结果 60fps 下完全正确的 keyint=60 被误报成 FAIL —— 所以必须读实际帧率。
  let fps = null
  for (let index = lines.length - 1; index >= 0 && fps === null; index -= 1) {
    if (!lines[index].includes('video settings reset')) continue
    for (let cursor = index + 1; cursor < Math.min(index + 8, lines.length); cursor += 1) {
      const match = lines[cursor].match(/fps:\s+(\d+)\s*\/\s*(\d+)/)
      if (match) {
        fps = Number(match[1]) / Number(match[2])
        break
      }
    }
  }

  if (fps !== null) {
    report.record(
      `输出帧率符合预期（${expectation.fps} fps）`,
      Math.abs(fps - expectation.fps) <= Math.max(1, expectation.fps * 0.1),
      `实际输出 ${fps} fps`,
    )
    if (fps > 30) {
      report.note('屏幕共享 30fps 就够了。同样的码率下 60fps 每帧只能分到一半，文字会更糊。')
    }
  } else {
    report.note('日志里没找到「video settings reset」块，帧率读不出来（关键帧间隔只好按 30fps 折算）')
  }

  // ---- 关键帧间隔 ----
  //
  // 只卡上限：真正的病是「默认 250 帧、1080p20 下 12.5 秒」，刚进来的人得黑屏等到下一个关键帧。
  // 比预期更短（比如 1 秒）只是多花一点码率，不该判 FAIL —— 所以不做双边卡。
  const keyint = Number.parseInt(last.settings.keyint ?? '0', 10)
  const referenceFps = fps && fps > 0 ? fps : 30
  const expectedKeyint = referenceFps * expectation.keyintSeconds
  const keyintSeconds = keyint / referenceFps
  report.record(
    `关键帧间隔不超过 ${expectation.keyintSeconds} 秒`,
    keyint > 0 && keyintSeconds <= expectation.keyintSeconds * 1.5 && keyintSeconds >= 0.25,
    `keyint=${keyint} 帧（${fps ?? '?'}fps 下约 ${keyintSeconds.toFixed(1)} 秒，上限 ${expectedKeyint} 帧）；` +
      'OBS 默认是 250 帧，1080p20 下就是 12.5 秒',
  )

  // lookahead 的语义没有歧义，直接判；日志里写成 "false (0 frames)" 这种带尾巴的形式，所以用前缀匹配
  const isOff = (value) => /^\s*(false|0|off|no)\b/i.test(String(value ?? ''))
  if (last.settings.lookahead !== undefined) {
    report.record(
      'lookahead 关（预分析帧数是实打实的额外延迟）',
      isOff(last.settings.lookahead),
      `lookahead=${last.settings.lookahead}`,
    )
  }
  if (last.settings.profile) {
    report.record('profile 是 high', /high/i.test(last.settings.profile), `profile=${last.settings.profile}`)
  }
  // 注意：日志里这个键叫 tuning，而 streamEncoder.json 里要写 tune —— 两边名字不一样，是 OBS 自己的差异
  const tune = last.settings.tuning ?? last.settings.tune
  if (tune !== undefined) {
    report.record('tuning 是 ll（NVENC 低延迟档）', /^ll/i.test(String(tune)), `tuning=${tune}`)
  }
  if (last.settings.repeatheaders !== undefined) {
    report.record(
      'repeat_headers 打开',
      !isOff(last.settings.repeatheaders),
      `repeat_headers=${last.settings.repeatheaders}`,
    )
  }
  // 心理视觉调优（psycho_aq）：它对屏幕文字确实不友好，但日志里这个键有时写成 aq，
  // 而 aq 在 NVENC 里还有别的含义，真假不好分辨 —— 所以只提示，不判 FAIL，免得冤枉人。
  const aq = last.settings.psychoaq ?? last.settings.aq
  if (aq !== undefined) {
    report.note(
      `心理视觉调优（日志里的 ${last.settings.psychoaq !== undefined ? 'psycho_aq' : 'aq'}）= ${aq}；` +
        '针对自然画面的优化会让屏幕文字发虚、抖，建议关掉',
    )
  }
}

// ------------------------------------------------------------------ 音频

report.section('2. 音频')

// 日志里的样子：
//   [FFmpeg libopus encoder: 'adv_stream_audio'] bitrate: 160, channels: 2, channel_layout: stereo, track: 1
const audioLines = lines.filter((line) => /opus/i.test(line) && /encoder|codec|audio/i.test(line))
const audio = audioLines.at(-1)
if (audio) {
  console.log(`  ${audio.trim()}`)
  const audioBitrate = Number.parseInt(audio.match(/bitrate:\s*(\d+)/)?.[1] ?? '', 10)
  report.record(
    '音频是 Opus（零转码的前提）',
    /opus/i.test(audio),
    'OBS 的 WHIP 输出直接出 Opus，服务端原样转发；走 RTMP 的话是 AAC，服务端要转码，音质会坏',
  )
  if (Number.isFinite(audioBitrate)) {
    report.record(
      `音频码率符合预设（${expectation.audioKbps} kbps）`,
      Math.abs(audioBitrate - expectation.audioKbps) <= expectation.audioKbps * 0.25,
      `bitrate=${audioBitrate} kbps；讲人声 48 就够，放音乐再往上加`,
    )
  }
  if (/channel_layout:\s*stereo/i.test(audio)) {
    report.note('音频是立体声 —— 默认档建议单声道（48 kbps 单声道比 96 kbps 立体声更实在，屏幕共享多数时候没人听音乐）')
  }
} else {
  report.record(
    '音频是 Opus（零转码的前提）',
    false,
    '日志里没找到 Opus 编码器的记录 —— WHIP 输出本该直接调 libopus。推一次流再看，或者检查是不是走了 RTMP',
  )
}

// ------------------------------------------------------------------ WHIP 会话

report.section('3. WHIP 会话')

// 只看**最近一次**会话：日志是累积的，早先服务端在重启时的失败不该算在这一次头上。
const whipLines = lines
  .map((line) => ({ line: line.trim(), index: line }))
  .filter((entry) => entry.line.includes('[obs-webrtc]'))

const lastConnectIndex = whipLines
  .map((entry) => entry.line)
  .reduce((found, line, index) => (/PeerConnection state is now: (Connecting|Connected)/.test(line) ? index : found), -1)
const session = lastConnectIndex >= 0 ? whipLines.slice(lastConnectIndex) : whipLines

const connected = session.some((entry) => /PeerConnection state is now: Connected/.test(entry.line))
report.record(
  'WHIP 会话建立成功',
  connected,
  connected
    ? 'PeerConnection → Connected'
    : '最近一次会话没看到 Connected（地址 / whip 路径 / 令牌 / UDP 8189 放行，逐个查）',
)

// 会话结束时的 DELETE 如果失败，服务端会一直挂着这个会话直到 ICE 超时（约 30 秒）
const deleteFailed = session.filter((entry) => /DELETE request .* failed/i.test(entry.line))
report.record(
  '会话正常结束（DELETE 没被拒）',
  deleteFailed.length === 0,
  deleteFailed.length ? deleteFailed.at(-1).line : '最近一次会话没有失败记录',
)

if (session.length) {
  console.log('\n  最近一次会话的日志：')
  for (const entry of session.slice(0, 8)) console.log(`    ${entry.line}`)
}

// ------------------------------------------------------------------ streamEncoder.json

report.section('4. OBS profile 里的 streamEncoder.json')

// 这一步专门盯旧项目踩过的坑：嵌套结构 OBS 一个键都不读，还安安静静用默认值。
// 判断键名对不对的唯一可靠办法就是看 OBS 自己往这个文件里写了什么 —— 它写的就是扁平键。
//
// 两个目录都扫：OBS 有 historical 两套布局 ——
//   OBS ≤32（本机 32.2.2 实测用的就是这个）：%APPDATA%\obs-studio\basic\profiles\<名字>\
//   新布局：%APPDATA%\obs-studio\profiles\<名字>\
// 只认后一个的话，在这台机器上会「安安静静跳过」，等于没查。
const obsRoot = join(process.env.APPDATA ?? '', 'obs-studio')
const profilesDirs = [join(obsRoot, 'profiles'), join(obsRoot, 'basic', 'profiles')].filter((dir) => existsSync(dir))

/** 从 basic.ini 里读输出模式：Simple 模式下编码参数根本不写进 streamEncoder.json */
function readOutputMode(dir, name) {
  try {
    const ini = readFileSync(join(dir, name, 'basic.ini'), 'utf8')
    const section = ini.split(/^\[/m).find((chunk) => /^Output\]/i.test(chunk))
    const match = section?.match(/^\s*Mode\s*=\s*(\w+)/im)
    return match ? match[1] : null
  } catch {
    return null
  }
}

if (profilesDirs.length === 0) {
  report.note(`没有找到 profile 目录（找过 ${profilesDirs.join(' 和 ')}），跳过`)
} else {
  const profiles = []
  for (const dir of profilesDirs) {
    for (const name of readdirSync(dir)) {
      if (existsSync(join(dir, name, 'streamEncoder.json'))) profiles.push({ dir, name })
    }
  }
  report.note(`扫到的 profile 目录：${profilesDirs.join('，')}`)
  if (profiles.length === 0) {
    report.note('没有任何 profile 带 streamEncoder.json，跳过')
  }
  for (const { dir, name } of profiles) {
    // 备份目录（sharecast.bak-20260918-…）不是当前在用的 profile，查它只会制造噪音
    if (/\.bak[-.]/i.test(name)) {
      report.note(`profile「${name}」是备份，跳过`)
      continue
    }
    const mode = readOutputMode(dir, name)
    if (mode && /simple/i.test(mode)) {
      // Simple 模式下参数不在这个文件里，拿它判「扁平/嵌套」属于冤枉人。
      // 但 Simple 模式改不了关键帧间隔（默认 250 帧），这点得说清楚。
      report.note(
        `profile「${name}」的输出模式是 Simple，编码参数不在 streamEncoder.json 里（跳过）。` +
          'Simple 模式**改不了关键帧间隔**，要用本文的参数请在 设置 → 输出 里切到「高级」',
      )
      continue
    }

    const path = join(dir, name, 'streamEncoder.json')
    let json
    try {
      json = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      report.record(`profile「${name}」的 streamEncoder.json 能解析`, false, error?.message ?? String(error))
      continue
    }
    const flat = typeof json.bitrate === 'number' || typeof json.rate_control === 'string'
    const nested = Object.values(json).some((value) => value && typeof value === 'object' && !Array.isArray(value))
    if (!flat && !nested) {
      report.note(`profile「${name}」的 streamEncoder.json 是空的（${mode ?? '模式未知'}），这个 profile 还没配过参数，跳过`)
      continue
    }
    report.record(
      `profile「${name}」的 streamEncoder.json 是扁平格式`,
      flat,
      flat
        ? `顶层键：${Object.keys(json).join(', ')}`
        : '顶层是嵌套结构（{"obs_nvenc_h264_tex": {...}}），OBS 一个键都不会读，会安静地用回默认 10000 kbps / keyint 250',
    )
    if (flat && typeof json.bitrate === 'number') {
      const value = json.bitrate > 100000 ? json.bitrate / 1000 : json.bitrate
      report.record(
        `profile「${name}」里的码率符合预期`,
        value >= expectation.bitrateMin * 0.95 && value <= expectation.bitrateMax * 1.05,
        `bitrate=${value} kbps（期望 ${expectation.bitrateMin}${expectation.bitrateMax === expectation.bitrateMin ? '' : `-${expectation.bitrateMax}`}）`,
      )
    }
    if (flat && typeof json.bf === 'number') {
      report.record(`profile「${name}」里的 B 帧是 0`, json.bf === 0, `bf=${json.bf}`)
    }
    if (flat && typeof json.keyint_sec === 'number') {
      report.record(
        `profile「${name}」里的关键帧间隔是 ${expectation.keyintSeconds} 秒`,
        Math.abs(json.keyint_sec - expectation.keyintSeconds) < 0.01,
        `keyint_sec=${json.keyint_sec}`,
      )
    }
  }
}

const code = report.summary('核对结果')
if (code !== 0) {
  console.log('\n如果是编码参数没生效，先看第 4 节：profile 里的 streamEncoder.json 必须是')
  console.log('顶层扁平键（{"rate_control":"CBR","bitrate":700,"keyint_sec":2,"tune":"ll","bf":0,…}），')
  console.log('嵌套写法 OBS 一个键都不读。判断键名的唯一可靠办法：在 UI 里改一次，再看 OBS 自己写了什么。')
  console.log('参数细节见 docs/OBS-设置.md。')
}
process.exit(code)
