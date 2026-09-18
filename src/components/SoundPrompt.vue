<script setup lang="ts">
/**
 * 「点击开启声音」条 —— 画面上唯一一个必须存在的用户手势。
 *
 * 为什么非要有它：页面是**静音自动播放**起来的（浏览器只允许静音免手势播放，
 * 这是零点击出画的唯一办法），于是进来「有画面没声音」。
 * 而没声音会被直接当成故障 —— 所以这一下点击免不掉，只能做得足够显眼：
 * 正中间一条纯色块，文案说清「已经在播了，点一下就有声」。
 *
 * 点完就消失、不再回来（由上层用 soundOn 记住，手动静音也不会再弹）。
 * 容器本身 pointer-events: none，所以点它以外的地方照样能落到视频上。
 */
import Icon from './Icon.vue'

const emit = defineEmits<{ (e: 'enable'): void }>()
</script>

<template>
  <div class="sound">
    <button type="button" class="sound__btn" @click="emit('enable')">
      <Icon name="volume" :size="20" />
      <span class="sound__text">画面已开始 · 点击开启声音</span>
    </button>
    <p class="sound__hint">浏览器不允许网页未经点击就出声</p>
  </div>
</template>

<style scoped>
/* 整层都不吃事件，只有按钮本身可点 —— 免得挡住画面上的播放/暂停点击 */
.sound {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  z-index: 2;
  pointer-events: none;
  padding: var(--sp-4);
}

.sound__btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-3);
  height: 52px;
  min-height: 52px;
  padding: 0 var(--sp-5);
  background: var(--warn);
  color: #1a1200;
  border-radius: var(--r-md);
  font-size: var(--fs-md);
  font-weight: 600;
  pointer-events: auto;
  transition: filter var(--t-fast) var(--ease);
}

.sound__btn:hover {
  filter: brightness(1.1);
}

.sound__btn:active {
  transform: scale(0.99);
}

.sound__hint {
  color: var(--fg-muted);
  font-size: var(--fs-xs);
  background: var(--bg);
  padding: 2px var(--sp-2);
  border-radius: var(--r-sm);
}

@media (max-width: 560px) {
  .sound__btn {
    padding: 0 var(--sp-4);
    font-size: var(--fs-base);
  }
}
</style>
