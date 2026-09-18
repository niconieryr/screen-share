<script setup lang="ts">
/**
 * 内联 SVG 图标集（Lucide 风格）。
 * 刻意不用 emoji —— 平面化设计要求图标形状一致，emoji 在不同系统上长得完全不一样。
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 })

interface IconDef {
  paths: string[]
  filled?: boolean
}

const ICONS: Record<string, IconDef> = {
  play: { paths: ['M6 3.5 20 12 6 20.5z'], filled: true },
  pause: { paths: ['M6.5 4h4v16h-4z', 'M13.5 4h4v16h-4z'], filled: true },
  volume: {
    paths: ['M11 4.5 6 9H2v6h4l5 4.5z', 'M15.6 8.4a5 5 0 0 1 0 7.2', 'M18.9 5.1a9.5 9.5 0 0 1 0 13.8'],
  },
  mute: { paths: ['M11 4.5 6 9H2v6h4l5 4.5z', 'M16 9.5l5 5', 'M21 9.5l-5 5'] },
  fullscreen: {
    paths: ['M8 3H5a2 2 0 0 0-2 2v3', 'M21 8V5a2 2 0 0 0-2-2h-3', 'M3 16v3a2 2 0 0 0 2 2h3', 'M16 21h3a2 2 0 0 0 2-2v-3'],
  },
  exitFullscreen: {
    paths: ['M8 3v3a2 2 0 0 1-2 2H3', 'M21 8h-3a2 2 0 0 1-2-2V3', 'M3 16h3a2 2 0 0 1 2 2v3', 'M16 21v-3a2 2 0 0 1 2-2h3'],
  },
  pip: { paths: ['M21 5v14H3V5z', 'M13 12h6v4h-6z'] },
  activity: { paths: ['M22 12h-4l-3 9L9 3l-3 9H2'] },
  refresh: {
    paths: ['M3 12a9 9 0 0 1 15.1-6.6L21 8', 'M21 3.5V8h-4.5', 'M21 12a9 9 0 0 1-15.1 6.6L3 16', 'M3 20.5V16h4.5'],
  },
  monitor: { paths: ['M2 3.5h20v13H2z', 'M8.5 20.5h7', 'M12 16.5v4'] },
  copy: { paths: ['M9 9h11v11H9z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'] },
  check: { paths: ['M20 6.5 9.5 17 4 11.5'] },
  alert: { paths: ['M12 3 2.5 20.5h19z', 'M12 9.5v4.5', 'M12 17.5h.01'] },
  live: {
    paths: [
      'M4.9 19.1a10 10 0 0 1 0-14.2',
      'M7.8 16.2a6 6 0 0 1 0-8.4',
      'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
      'M16.2 7.8a6 6 0 0 1 0 8.4',
      'M19.1 4.9a10 10 0 0 1 0 14.2',
    ],
  },
  link: {
    paths: [
      'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7',
      'M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    ],
  },
  clock: { paths: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6.5V12l3.5 2'] },
  down: { paths: ['M12 4v13', 'M6 12l6 6 6-6'] },
}

const icon = computed<IconDef>(() => ICONS[props.name] ?? { paths: [] })
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="icon.filled ? 'currentColor' : 'none'"
    stroke="currentColor"
    :stroke-width="icon.filled ? 0 : 1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(d, index) in icon.paths" :key="index" :d="d" />
  </svg>
</template>
