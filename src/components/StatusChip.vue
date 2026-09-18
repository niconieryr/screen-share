<script setup lang="ts">
/**
 * 传输方式 / 连接状态的实心色块。
 * 平面化的做法：状态靠**色块 + 文字**表达，不靠光晕、投影或动画。
 */
import { computed } from 'vue'

import type { Transport } from '@/composables/usePlayer'

const props = defineProps<{
  transport: Transport
  /** 正在播放 */
  playing: boolean
}>()

const label = computed(() => {
  if (props.transport === 'webrtc') return 'WebRTC · 1 秒内'
  if (props.transport === 'hls') return 'HLS · 2-4 秒'
  return '未连接'
})

const tone = computed(() => {
  if (!props.playing) return 'idle'
  return props.transport === 'webrtc' ? 'ok' : 'warn'
})
</script>

<template>
  <span class="chip" :class="`chip--${tone}`">
    <span class="chip__dot" aria-hidden="true" />
    <span class="chip__text num">{{ label }}</span>
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  height: 24px;
  padding: 0 var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-xs);
  font-weight: 500;
  white-space: nowrap;
}

.chip__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

.chip--ok {
  background: var(--ok);
  color: #04150c;
}

.chip--warn {
  background: var(--warn);
  color: #1a1200;
}

.chip--idle {
  background: var(--surface-3);
  color: var(--fg-muted);
}
</style>
