/**
 * 从 WebRTC / <video> 上读运行指标。
 *
 * 刻意**不**编造一个「端到端延迟」数字 —— 浏览器测不出真实延迟。
 * 我们只报能测准的：传输方式、码率、帧率、丢包、抖动、RTT、抖动缓冲。
 *
 * 这些数字是给观众判断「4 Mbps 的带宽够不够」用的：码率贴不满 + 丢包率上去了，
 * 就是链路不够，跟播放器没关系。
 */

export interface PlaybackStats {
  transport: 'webrtc' | 'hls'
  width: number
  height: number
  fps: number
  bitrate: number
  packetsLost: number
  lossRate: number
  jitterMs: number
  rttMs: number
  /** WebRTC 抖动缓冲里的排队时长，能粗略反映链路拥塞 */
  jitterBufferMs: number
  /** 累计接收字节，用来判断有没有卡死 */
  bytesReceived: number
}

export function emptyStats(transport: 'webrtc' | 'hls'): PlaybackStats {
  return {
    transport,
    width: 0,
    height: 0,
    fps: 0,
    bitrate: 0,
    packetsLost: 0,
    lossRate: 0,
    jitterMs: 0,
    rttMs: 0,
    jitterBufferMs: 0,
    bytesReceived: 0,
  }
}

interface InboundRtpLike extends RTCStats {
  kind?: string
  bytesReceived?: number
  packetsLost?: number
  packetsReceived?: number
  framesPerSecond?: number
  frameWidth?: number
  frameHeight?: number
  jitter?: number
  jitterBufferDelay?: number
  jitterBufferEmittedCount?: number
}

interface CandidatePairLike extends RTCStats {
  nominated?: boolean
  state?: string
  currentRoundTripTime?: number
}

interface RemoteInboundLike extends RTCStats {
  roundTripTime?: number
}

/**
 * 读一次 WebRTC 统计。
 * `previous` 用来算码率（字节差 / 时间差），没有就只报瞬时值。
 */
export async function readWebRtcStats(
  pc: RTCPeerConnection,
  previous: { bytes: number; at: number } | null,
): Promise<{ stats: PlaybackStats; marker: { bytes: number; at: number } }> {
  const report = await pc.getStats()
  const stats = emptyStats('webrtc')

  let bytes = 0
  let packetsLost = 0
  let packetsReceived = 0
  let jitterSeconds = 0

  report.forEach((entry) => {
    const item = entry as InboundRtpLike
    if (item.type !== 'inbound-rtp') return
    bytes += item.bytesReceived ?? 0

    if (item.kind === 'video') {
      stats.width = item.frameWidth ?? 0
      stats.height = item.frameHeight ?? 0
      stats.fps = item.framesPerSecond ?? 0
    }

    packetsLost += item.packetsLost ?? 0
    packetsReceived += item.packetsReceived ?? 0

    if (item.jitter) jitterSeconds = Math.max(jitterSeconds, item.jitter)

    // 抖动缓冲平均排队时长 = 累计延迟 / 已发出的样本数
    if (item.jitterBufferDelay && item.jitterBufferEmittedCount) {
      const average = item.jitterBufferDelay / item.jitterBufferEmittedCount
      stats.jitterBufferMs = Math.max(stats.jitterBufferMs, average * 1000)
    }
  })

  report.forEach((entry) => {
    const pair = entry as CandidatePairLike
    if (pair.type === 'candidate-pair' && (pair.nominated || pair.state === 'succeeded')) {
      if (pair.currentRoundTripTime) stats.rttMs = pair.currentRoundTripTime * 1000
    }
    const remote = entry as RemoteInboundLike
    if (remote.type === 'remote-inbound-rtp' && remote.roundTripTime) {
      stats.rttMs = Math.max(stats.rttMs, remote.roundTripTime * 1000)
    }
  })

  const now = performance.now()
  if (previous && now > previous.at && bytes >= previous.bytes) {
    stats.bitrate = ((bytes - previous.bytes) * 8) / ((now - previous.at) / 1000)
  }

  stats.bytesReceived = bytes
  stats.packetsLost = packetsLost
  stats.jitterMs = jitterSeconds * 1000

  const total = packetsLost + packetsReceived
  stats.lossRate = total > 0 ? packetsLost / total : 0

  return { stats, marker: { bytes, at: now } }
}

/** 从 <video> 元素读分辨率等信息。HLS 路径下 WebRTC 统计是拿不到的。 */
export function readElementStats(
  video: HTMLVideoElement,
  transport: 'webrtc' | 'hls',
  previous: { bytes: number; at: number } | null,
  bandwidthEstimate: number,
): PlaybackStats {
  const stats = emptyStats(transport)
  stats.width = video.videoWidth
  stats.height = video.videoHeight

  const quality = video.getVideoPlaybackQuality?.()
  if (quality) {
    const elapsed = video.currentTime
    if (elapsed > 0) stats.fps = quality.totalVideoFrames / elapsed
  }

  // HLS 拿不到累计字节数，用 hls.js 的带宽估计顶上（只是估算，UI 上标注清楚）
  stats.bitrate = bandwidthEstimate

  const now = performance.now()
  if (previous && now > previous.at) {
    stats.bitrate = bandwidthEstimate
  }

  return stats
}
