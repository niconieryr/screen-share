/** 显示用的格式化函数。全部返回短字符串，避免撑破控制栏。 */

export function formatBitrate(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '—'
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`
  if (bitsPerSecond >= 1_000) return `${Math.round(bitsPerSecond / 1_000)} kbps`
  return `${Math.round(bitsPerSecond)} bps`
}

export function formatMs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  return `${Math.round(seconds * 1000)} ms`
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) return '—'
  return `${(ratio * 100).toFixed(2)}%`
}

/** 把秒数写成 1:23:45 / 12:34 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00'
  const s = Math.floor(totalSeconds % 60)
  const m = Math.floor((totalSeconds / 60) % 60)
  const h = Math.floor(totalSeconds / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
