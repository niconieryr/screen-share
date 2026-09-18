<script setup lang="ts">
/**
 * 首屏门禁。
 *
 * 这不是装饰 —— 浏览器的自动播放策略禁止页面在**没有用户手势**的情况下出声。
 * 与其先静音自动播放、再在角落提示「点击开启声音」（大多数人不看），
 * 不如把这一次点击做成进入房间的仪式：点完就出声，状态只有一种。
 *
 * 两种形态：
 *   - 地址栏里没有 ?k=，或者手上的令牌被服务端拒了 → 让人粘一条新链接进来
 *   - 令牌没问题 → 确认一下房间和链接，点进去
 *
 * 令牌只活在地址栏里，**不落 localStorage**：存起来的话「没带令牌」这个状态
 * 就永远不会出现，门禁也就形同虚设了。
 */
import { computed, ref } from 'vue'

import CopyField from './CopyField.vue'
import Icon from './Icon.vue'
import { parseToken } from '@/lib/config'

const props = defineProps<{
  room: string
  /** 地址栏里带进来的令牌，空串表示没有 */
  token: string
  /** 有令牌时可以直接发出去的完整观看链接 */
  shareUrl: string
  /** 令牌被服务端拒了（HTTP 401） */
  unauthorized?: boolean
}>()

const emit = defineEmits<{ (e: 'enter', token: string): void }>()

const draft = ref('')
const localError = ref('')

/** 需要用户输入：手上没有令牌，或者已有的令牌已经被服务端拒了 */
const needsInput = computed(() => props.token === '' || props.unauthorized === true)

const warning = computed(() => localError.value)

function submit(): void {
  if (!needsInput.value) {
    emit('enter', props.token)
    return
  }

  const text = draft.value.trim()
  if (!text) {
    localError.value = '把分享给你的链接，或者 ?k= 后面那串令牌，粘到这里。'
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

      <template v-if="needsInput">
        <p class="gate__desc">
          把分享者给你的<strong>完整链接</strong>粘进来，或者只粘 <code>?k=</code>
          后面那串令牌。
        </p>

        <input
          v-model="draft"
          class="gate__input num"
          type="text"
          placeholder="http://…/?k=… 或者直接贴令牌"
          spellcheck="false"
          autocomplete="off"
          @input="localError = ''"
          @keydown.enter="submit"
        />
      </template>

      <template v-else>
        <p class="gate__desc">
          链接已经带上令牌了。点下面的按钮进入，<strong>点一下就会开始播放并打开声音</strong>。
        </p>
        <CopyField label="观看链接" :value="shareUrl" />
      </template>

      <p v-if="unauthorized" class="gate__warn">
        <Icon name="alert" :size="16" />
        <span>链接不对或已失效（服务端返回 401）。找分享者要一条新的完整链接。</span>
      </p>

      <p v-else-if="warning" class="gate__warn">
        <Icon name="alert" :size="16" />
        <span>{{ warning }}</span>
      </p>

      <button type="button" class="gate__btn" @click="submit">
        <Icon name="play" :size="18" />
        <span>进入房间</span>
      </button>
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
</style>
