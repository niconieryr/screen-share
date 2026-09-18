<script setup lang="ts">
/**
 * 「需要令牌」门禁 —— 只在服务端返回 401 时出现。
 *
 * 默认的开放模式（短链接谁拿到谁能看）下观众**永远看不到这个界面**：
 * 页面打开就直接往 WHEP 上冲，零点击出画。
 * 只有服务端开了受控模式（把 VIEW_TOKEN 填上、nginx 开始要 $arg_k），
 * 或者观众拿到的是一条被别人改动过的旧链接时，才会退到这里。
 *
 * 这时没有别的办法：观众手里那条地址不带令牌，前端也变不出来，
 * 只能用输入框把分享者给的完整链接（或单独一串令牌）要过来。
 * 令牌只活在地址栏里，**不落 localStorage**。
 */
import { computed, ref } from 'vue'

import Icon from './Icon.vue'
import { parseToken } from '@/lib/config'

const props = defineProps<{
  room: string
  /** 地址栏里带进来的令牌，空串表示压根没带 */
  token: string
}>()

const emit = defineEmits<{ (e: 'enter', token: string): void }>()

const draft = ref('')
const localError = ref('')

/** 地址里本来就带了令牌还是被拒 → 那条令牌不对或过期了 */
const hadToken = computed(() => props.token.length > 0)

function submit(): void {
  const text = draft.value.trim()
  if (!text) {
    localError.value = '把分享者给你的完整链接，或者 ?k= 后面那串令牌，粘到这里。'
    return
  }

  const parsed = parseToken(text)
  if (!parsed) {
    localError.value = '这段文本里没找到令牌。整条链接和单独一串令牌都认，检查一下是不是少复制了一段。'
    return
  }

  localError.value = ''
  emit('enter', parsed)
}
</script>

<template>
  <div class="gate">
    <div class="gate__inner">
      <p class="gate__kicker">屏幕共享</p>
      <h1 class="gate__room num">{{ room || '—' }}</h1>

      <p class="gate__desc">
        <strong>这次需要令牌。</strong>
        服务端开了受控模式，光有短链接进不来 —— 把分享者给你的完整链接（带 <code>?k=</code>
        的那种）整条粘进来。
      </p>

      <input
        v-model="draft"
        class="gate__input num"
        type="text"
        placeholder="粘贴完整链接，或者只贴令牌"
        spellcheck="false"
        autocomplete="off"
        @input="localError = ''"
        @keydown.enter="submit"
      />

      <p v-if="localError" class="gate__warn">
        <Icon name="alert" :size="16" />
        <span>{{ localError }}</span>
      </p>

      <p v-else-if="hadToken" class="gate__warn">
        <Icon name="alert" :size="16" />
        <span>地址里那条令牌不对或已失效（服务端返回 401），换一条新的试试。</span>
      </p>

      <button type="button" class="gate__btn" @click="submit">
        <Icon name="play" :size="18" />
        <span>继续观看</span>
      </button>

      <p class="gate__note">服务端一直是开放模式的话，正常链接不会看到这个页面。</p>
    </div>
  </div>
</template>

<style scoped>
.gate {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--bg);
  padding: var(--sp-5);
  z-index: 3;
  overflow-y: auto;
}

.gate__inner {
  width: 100%;
  max-width: 460px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.gate__kicker {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.gate__room {
  font-family: var(--font-mono);
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: -0.01em;
  /* 平面化的色块分隔：用左边一条实心竖线代替卡片和阴影 */
  border-left: 4px solid var(--live);
  padding-left: var(--sp-3);
  line-height: 1.2;
  word-break: break-all;
}

.gate__desc {
  color: var(--fg-muted);
  font-size: var(--fs-base);
}

.gate__desc strong {
  color: var(--fg);
  font-weight: 600;
}

code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  background: var(--surface-3);
  padding: 1px 5px;
  border-radius: var(--r-sm);
}

.gate__input {
  height: 44px;
  padding: 0 var(--sp-3);
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
}

.gate__input:focus-visible {
  border-color: var(--focus);
}

.gate__warn {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--surface-2);
  border-left: 4px solid var(--danger);
  border-radius: var(--r-sm);
  color: var(--fg);
  font-size: var(--fs-sm);
}

.gate__warn svg {
  flex: none;
  margin-top: 2px;
  color: var(--danger);
}

.gate__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: 52px;
  min-height: 52px;
  background: var(--live);
  color: var(--live-fg);
  border-radius: var(--r-md);
  font-size: var(--fs-md);
  font-weight: 600;
  transition: filter var(--t-fast) var(--ease);
}

.gate__btn:hover {
  filter: brightness(1.12);
}

.gate__btn:active {
  transform: scale(0.99);
}

.gate__note {
  font-size: var(--fs-xs);
  color: var(--fg-dim);
}
</style>
