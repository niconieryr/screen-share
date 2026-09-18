<script setup lang="ts">
/**
 * 播放统计面板。
 *
 * 刻意**不显示**「端到端延迟」这种编出来的数字 —— 浏览器测不到它。
 * 只报能测准的，并用传输方式作为延迟量级的诚实说明。
 *
 * 这个面板是给观众判断「带宽够不够」用的：码率贴不满 + 丢包率上去了，
 * 就是链路不够，换播放器也没用。
 */
import { computed } from 'vue'

import type { PlaybackStats } from '@/lib/stats'
import { formatBitrate, formatMs, formatPercent } from '@/lib/format'

const props = defineProps<{ stats: PlaybackStats | null }>()

interface Row {
  label: string
  value: string
}

const rows = computed<Row[]>(() => {
  const s = props.stats
  if (!s) return []

  const base: Row[] = [
    { label: '传输方式', value: s.transport === 'webrtc' ? 'WebRTC / WHEP' : 'LL-HLS' },
    {
      label: '延迟量级',
      value: s.transport === 'webrtc' ? '通常 1 秒内' : '通常 2-4 秒',
    },
    { label: '分辨率', value: s.width && s.height ? `${s.width}×${s.height}` : '—' },
    { label: '帧率', value: s.fps ? `${s.fps.toFixed(0)} fps` : '—' },
    { label: '码率', value: formatBitrate(s.bitrate) },
  ]

  if (s.transport === 'webrtc') {
    base.push(
      { label: '丢包率', value: formatPercent(s.lossRate) },
      { label: '网络抖动', value: formatMs(s.jitterMs / 1000) },
      { label: '往返时延', value: formatMs(s.rttMs / 1000) },
      { label: '抖动缓冲', value: formatMs(s.jitterBufferMs / 1000) },
    )
  }

  return base
})
</script>

<template>
  <aside v-if="rows.length" class="stats" aria-label="播放统计">
    <dl class="stats__grid">
      <template v-for="row in rows" :key="row.label">
        <dt class="stats__key">{{ row.label }}</dt>
        <dd class="stats__val num">{{ row.value }}</dd>
      </template>
    </dl>
    <p class="stats__note">
      1080p30 的屏幕内容通常 3 Mbps 上下。码率长期贴不满、丢包率也上去了，就是带宽不够。
    </p>
  </aside>
</template>

<style scoped>
.stats {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  padding: var(--sp-3);
  min-width: 232px;
  max-width: 288px;
}

.stats__grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--sp-1) var(--sp-4);
  margin: 0;
  align-items: baseline;
}

.stats__key {
  font-size: var(--fs-xs);
  color: var(--fg-muted);
  white-space: nowrap;
}

.stats__val {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--fg);
  text-align: right;
  white-space: nowrap;
}

.stats__note {
  margin-top: var(--sp-3);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--border);
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}
</style>
