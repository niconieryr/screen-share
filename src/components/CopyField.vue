<script setup lang="ts">
/**
 * 可读 + 可复制的链接框。就是一块纯色文本区加一个按钮，没有投影没有浮层。
 *
 * ⚠️ 现在**没有页面在用**：观众页顶上那条「观看链接」分享条已按需求去掉
 *（看的人自己就是被分享来的，不需要再看到链接）。留着是因为下面那套降级逻辑
 * 是踩过坑写出来的，将来要在别处（比如开播台）再放分享条，直接拿来用即可。
 *
 * 复制这件事在这套部署里必须做三道兜底：对外入口是 http://<IP>:<端口>，
 * **不是安全上下文（secure context）**，很多浏览器里 navigator.clipboard 直接
 * 就是 undefined，只写 clipboard API 等于没写。
 *   1. navigator.clipboard.writeText —— https / localhost 下最干净
 *   2. 隐藏 textarea + document.execCommand('copy') —— http 下的老办法，还能用
 *   3. 都不行就把框里的文本全选上，让用户自己按 Ctrl+C
 * 而且不管走哪条路，页面上永远留着这份**可选中、可读**的文本，
 * 不能只给一个按钮 —— 复制失败时用户至少还能手动选中。
 */
import { computed, onBeforeUnmount, ref } from 'vue'

import Icon from './Icon.vue'

const props = defineProps<{
  label: string
  value: string
  hint?: string
}>()

type CopyState = 'idle' | 'ok' | 'manual' | 'fail'

const state = ref<CopyState>('idle')
const areaRef = ref<HTMLTextAreaElement | null>(null)
let resetTimer: number | null = null

const buttonLabel = computed(() => {
  switch (state.value) {
    case 'ok':
      return '已复制'
    case 'manual':
      return '已选中'
    case 'fail':
      return '复制失败'
    default:
      return '复制'
  }
})

function flash(next: CopyState): void {
  state.value = next
  if (resetTimer !== null) clearTimeout(resetTimer)
  resetTimer = window.setTimeout(() => {
    state.value = 'idle'
  }, 2600)
}

/** 第三道兜底：把框里的文本全选上，让用户自己按 Ctrl+C */
function selectField(): void {
  const area = areaRef.value
  if (!area) return
  area.focus()
  area.select()
  // iOS Safari 上 select() 对 textarea 偶尔不管用，补一刀
  area.setSelectionRange(0, area.value.length)
}

/**
 * 第二道兜底：隐藏 textarea + document.execCommand('copy')。
 *
 * 这是 http 源下唯一还能用的同步复制手段：textarea 必须真的在文档里、能被选中，
 * 不能是 display:none；选完要把原来的选区还回去，免得把用户的选中状态弄丢。
 */
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '0'
  area.style.left = '0'
  area.style.width = '1px'
  area.style.height = '1px'
  area.style.padding = '0'
  area.style.border = 'none'
  area.style.outline = 'none'
  area.style.opacity = '0'
  document.body.appendChild(area)

  const selection = document.getSelection()
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  let ok = false
  try {
    area.select()
    area.setSelectionRange(0, area.value.length)
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }

  document.body.removeChild(area)
  if (previous && selection) {
    selection.removeAllRanges()
    selection.addRange(previous)
  }
  return ok
}

async function copy(): Promise<void> {
  const text = props.value
  if (!text) {
    flash('fail')
    return
  }

  // 第一道：安全上下文（https / localhost）里才有 navigator.clipboard。
  // 这套部署是 http://<IP>:<端口>，绝大多数浏览器里它直接是 undefined。
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      flash('ok')
      return
    } catch {
      /* 权限被拒或者不是安全上下文，往下走 */
    }
  }

  if (legacyCopy(text)) {
    flash('ok')
    return
  }

  selectField()
  flash('manual')
}

/** 点进文本框就全选，方便手动复制 */
function onFocus(): void {
  selectField()
}

onBeforeUnmount(() => {
  if (resetTimer !== null) clearTimeout(resetTimer)
})
</script>

<template>
  <div class="copy">
    <span class="copy__label">{{ label }}</span>

    <!-- 永远留着这份可选中、可读的文本：复制全失败时用户至少能自己选中复制 -->
    <textarea
      ref="areaRef"
      class="copy__text num"
      :value="value"
      :aria-label="label"
      readonly
      rows="2"
      spellcheck="false"
      @focus="onFocus"
    />

    <button
      type="button"
      class="copy__btn"
      :class="{ 'copy__btn--ok': state === 'ok', 'copy__btn--warn': state === 'fail' }"
      @click="copy"
    >
      <Icon :name="state === 'ok' ? 'check' : 'copy'" :size="16" />
      <span>{{ buttonLabel }}</span>
    </button>

    <p v-if="hint" class="copy__hint">{{ hint }}</p>
    <p v-if="state === 'manual'" class="copy__hint copy__hint--warn">
      已经帮你全选好了，按 Ctrl+C（Mac 上 Cmd+C）复制。
    </p>
  </div>
</template>

<style scoped>
.copy {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  flex-wrap: wrap;
}

.copy__label {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-muted);
  line-height: 44px;
  white-space: nowrap;
}

.copy__text {
  flex: 1;
  min-width: 180px;
  min-height: 44px;
  padding: var(--sp-2) var(--sp-3);
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  line-height: 1.4;
  /* 链接没有空格，必须让它在哪里都能断行，不然会横向滚出去 */
  word-break: break-all;
  white-space: pre-wrap;
  resize: none;
  overflow: hidden;
}

.copy__text:focus-visible {
  border-color: var(--focus);
}

.copy__btn {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  height: 44px;
  min-height: 44px;
  padding: 0 var(--sp-4);
  background: var(--surface-3);
  color: var(--fg);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease);
}

.copy__btn:hover {
  background: var(--border-strong);
}

.copy__btn--ok {
  background: var(--ok);
  color: #04150c;
}

.copy__btn--warn {
  background: var(--danger);
  color: #fff;
}

.copy__hint {
  flex-basis: 100%;
  font-size: var(--fs-xs);
  color: var(--fg-muted);
}

.copy__hint--warn {
  color: var(--warn);
}

/* 窄屏：标签挪到上面单独一行，别把链接挤没 */
@media (max-width: 560px) {
  .copy__label {
    flex-basis: 100%;
    line-height: 1.4;
  }
}
</style>
