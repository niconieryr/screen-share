<script setup lang="ts">
/**
 * 底部控制栏。
 * 平面化：纯色块 + 1px 上边框，没有浮动、没有投影、没有毛玻璃。
 */
import Icon from './Icon.vue'

const props = defineProps<{
  playing: boolean
  muted: boolean
  volume: number
  statsOpen: boolean
  fullscreen: boolean
  pipSupported: boolean
  pipActive: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-play'): void
  (e: 'toggle-mute'): void
  (e: 'update:volume', value: number): void
  (e: 'toggle-stats'): void
  (e: 'toggle-fullscreen'): void
  (e: 'toggle-pip'): void
}>()

function onVolume(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value)
  emit('update:volume', value)
}

const volumeIcon = () => (props.muted || props.volume === 0 ? 'mute' : 'volume')
</script>

<template>
  <div class="bar">
    <button
      type="button"
      class="bar__btn"
      :aria-label="playing ? '暂停' : '播放'"
      :title="playing ? '暂停（空格）' : '播放（空格）'"
      @click="emit('toggle-play')"
    >
      <Icon :name="playing ? 'pause' : 'play'" :size="18" />
    </button>

    <div class="bar__volume">
      <button
        type="button"
        class="bar__btn"
        :aria-label="muted ? '取消静音' : '静音'"
        :title="muted ? '取消静音（M）' : '静音（M）'"
        @click="emit('toggle-mute')"
      >
        <Icon :name="volumeIcon()" :size="18" />
      </button>
      <input
        class="bar__slider"
        type="range"
        min="0"
        max="1"
        step="0.01"
        :value="muted ? 0 : volume"
        aria-label="音量"
        @input="onVolume"
      />
    </div>

    <span class="bar__spacer" />

    <button
      type="button"
      class="bar__btn"
      :class="{ 'bar__btn--on': statsOpen }"
      :aria-pressed="statsOpen"
      aria-label="播放统计"
      title="播放统计"
      @click="emit('toggle-stats')"
    >
      <Icon name="activity" :size="18" />
    </button>

    <button
      v-if="pipSupported"
      type="button"
      class="bar__btn"
      :class="{ 'bar__btn--on': pipActive }"
      :aria-pressed="pipActive"
      aria-label="画中画"
      title="画中画（P）"
      @click="emit('toggle-pip')"
    >
      <Icon name="pip" :size="18" />
    </button>

    <button
      type="button"
      class="bar__btn"
      :aria-label="fullscreen ? '退出全屏' : '全屏'"
      :title="fullscreen ? '退出全屏（F）' : '全屏（F）'"
      @click="emit('toggle-fullscreen')"
    >
      <Icon :name="fullscreen ? 'exitFullscreen' : 'fullscreen'" :size="18" />
    </button>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  height: var(--bar-bottom);
  padding: 0 var(--sp-2);
  background: var(--surface);
  border-top: 1px solid var(--border);
}

.bar__btn {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: var(--r-sm);
  color: var(--fg);
  transition:
    background var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease);
}

.bar__btn:hover {
  background: var(--surface-2);
}

.bar__btn--on {
  background: var(--surface-3);
  color: var(--ok);
}

.bar__volume {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}

.bar__slider {
  width: 84px;
  height: 4px;
  margin: 0 var(--sp-2) 0 0;
  appearance: none;
  background: var(--surface-3);
  border-radius: 0;
  cursor: pointer;
}

.bar__slider::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 0;
  background: var(--fg);
  cursor: pointer;
}

.bar__slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 0;
  border-radius: 0;
  background: var(--fg);
  cursor: pointer;
}

.bar__slider:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 4px;
}

.bar__spacer {
  flex: 1;
}

/* 窄屏：音量条太占地方，收掉，静音按钮留着 */
@media (max-width: 560px) {
  .bar__slider {
    display: none;
  }
}
</style>
