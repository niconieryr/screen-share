<script setup lang="ts">
/**
 * 观看页 —— 观众看到的全部内容，也是这个应用**唯一**的一页。
 *
 * 出画是**零点击**的：打开链接直接 start()，静音自动播放
 * （浏览器只允许静音免手势播放，这是唯一能免掉那一下的办法）。
 * 代价是没声音，而没声音会被当成故障 —— 所以画面上常驻一条显眼的
 * 「点击开启声音」，点一下就摘掉静音。这一下点击是自动播放策略硬要求的，
 * 免不掉，只能做得足够显眼。
 *
 * 只有在服务端返回 401（受控模式）时才会退回「需要令牌」的门禁；
 * 默认的开放模式下观众永远看不到它。
 *
 * 布局是「顶栏 / 分享条 / 舞台 / 控制栏」四段，全部纯色块，没有任何浮动元素和投影。
 * 所有会出错的地方都在舞台中央给出一个整块的说明态，而不是弹窗或 toast。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

import ControlBar from '@/components/ControlBar.vue'
import CopyField from '@/components/CopyField.vue'
import Icon from '@/components/Icon.vue'
import JoinGate from '@/components/JoinGate.vue'
import SoundPrompt from '@/components/SoundPrompt.vue'
import StatsPanel from '@/components/StatsPanel.vue'
import StatusChip from '@/components/StatusChip.vue'
import { usePlayer } from '@/composables/usePlayer'
import { buildWatchUrl, FIXED_ROOM, readToken, type Session } from '@/lib/config'

// 房间号是构建时常量；令牌默认是空串（开放模式），只有受控模式才从地址栏带进来
const session = reactive<Session>({ room: FIXED_ROOM, token: readToken() })

const videoRef = ref<HTMLVideoElement | null>(null)
const stageRef = ref<HTMLElement | null>(null)

const {
  phase,
  transport,
  errorMessage,
  waitReason,
  stats,
  needsManualPlay,
  start,
  retry,
  enableSound,
} = usePlayer(videoRef, session)

const soundOn = ref(false)
const muted = ref(true)
const volume = ref(1)
const paused = ref(true)
const statsOpen = ref(false)
const fullscreen = ref(false)
const pipActive = ref(false)
const pipSupported = ref(false)
const controlsVisible = ref(true)

const isPlaying = computed(() => phase.value === 'playing')
/** 短链接，不带令牌；受控模式下（地址栏里本来就有 ?k=）才跟着带上令牌 */
const shareUrl = computed(() => buildWatchUrl(session.token))
/** 服务端用 404 表示「房间里没有流」，也用来表示「房间路径不对」—— 后者是配置问题 */
const looksLikeMissingPath = computed(() => waitReason.value.includes('404'))

type OverlayKind = 'none' | 'gate' | 'connecting' | 'waiting' | 'reconnecting' | 'error' | 'tap'

const overlay = computed<OverlayKind>(() => {
  // 401 才要令牌；其余情况一律不拦人
  if (phase.value === 'unauthorized') return 'gate'
  if (needsManualPlay.value) return 'tap'
  switch (phase.value) {
    case 'idle':
    case 'connecting':
      return 'connecting'
    case 'waiting':
      return 'waiting'
    case 'reconnecting':
      return 'reconnecting'
    case 'error':
      return 'error'
    default:
      return 'none'
  }
})

/** 出画了但还没开声 → 把「点击开启声音」摆在正中间 */
const showSoundPrompt = computed(() => isPlaying.value && !soundOn.value && overlay.value === 'none')

const errorText = computed(() => errorMessage.value || '出了点问题')

// ------------------------------------------------------------------ 交互

/** 受控模式：观众把带令牌的链接粘进来 */
function onEnter(token: string): void {
  if (token && token !== session.token) {
    session.token = token
    // 地址栏跟着更新，这样随手把地址栏复制给别人，对方拿到的就是一条能用的链接
    const url = new URL(window.location.href)
    url.searchParams.set('k', token)
    window.history.replaceState(null, '', url)
  }
  start()
}

function syncMediaState(): void {
  const video = videoRef.value
  if (!video) return
  muted.value = video.muted
  volume.value = video.volume
  paused.value = video.paused
}

/** 开声：记住已经开过，之后手动静音也不再弹提示 */
async function turnOnSound(): Promise<void> {
  soundOn.value = true
  await enableSound()
}

async function togglePlay(): Promise<void> {
  const video = videoRef.value
  if (!video) return
  if (video.paused) {
    await video.play().catch(() => undefined)
  } else {
    video.pause()
  }
}

/**
 * 点画面。
 * 还在静音时，第一次点击先用来开声（别让用户以为坏了）；
 * 开过声之后才恢复成「点一下暂停/播放」。
 */
function onVideoClick(): void {
  if (!isPlaying.value) return
  if (!soundOn.value) {
    void turnOnSound()
    return
  }
  void togglePlay()
}

function toggleMute(): void {
  const video = videoRef.value
  if (!video) return
  video.muted = !video.muted
  if (!video.muted) {
    soundOn.value = true
    // 从 0 音量取消静音时给一个能听见的值，别出现「明明没静音却没声音」
    if (video.volume === 0) video.volume = 0.8
  }
}

function updateVolume(value: number): void {
  const video = videoRef.value
  if (!video) return
  video.volume = value
  video.muted = value === 0
  if (!video.muted) soundOn.value = true
}

async function toggleFullscreen(): Promise<void> {
  const element = stageRef.value
  if (!element) return
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await element.requestFullscreen()
  } catch {
    /* 用户拒绝或浏览器不支持 */
  }
}

async function togglePip(): Promise<void> {
  const video = videoRef.value
  if (!video) return
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture()
    else await video.requestPictureInPicture()
  } catch {
    /* 忽略 */
  }
}

// ------------------------------------------------------------------ 控制栏自动隐藏

let hideTimer: number | null = null

function showControls(): void {
  controlsVisible.value = true
  if (hideTimer !== null) clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    // 暂停时不隐藏，有说明态时不隐藏 —— 控制栏不该在用户需要它的时候消失
    if (videoRef.value?.paused) return
    if (overlay.value !== 'none') return
    controlsVisible.value = false
  }, 3200)
}

watch(isPlaying, (playing) => {
  if (playing) showControls()
})

// ------------------------------------------------------------------ 键盘

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
    return
  }
  // 要令牌的那一页，键盘留给输入框
  if (overlay.value === 'gate') return

  switch (event.key) {
    case ' ':
    case 'k':
      event.preventDefault()
      if (!soundOn.value && isPlaying.value) void turnOnSound()
      else void togglePlay()
      break
    case 'm':
      toggleMute()
      break
    case 'f':
      void toggleFullscreen()
      break
    case 'p':
      void togglePip()
      break
    default:
      break
  }
  showControls()
}

// ------------------------------------------------------------------ 全屏 / 后台

function onFullscreenChange(): void {
  fullscreen.value = document.fullscreenElement === stageRef.value
}

function onPipChange(): void {
  pipActive.value = document.pictureInPictureElement === videoRef.value
}

let hiddenAt = 0

function onVisibilityChange(): void {
  const video = videoRef.value
  if (!video) return

  if (document.hidden) {
    hiddenAt = Date.now()
    if (!video.paused) video.pause()
    return
  }

  // 长时间切后台回来，直接重连跳回直播边缘，别接着播一段陈旧缓冲
  if (hiddenAt > 0 && Date.now() - hiddenAt > 60_000) {
    hiddenAt = 0
    retry()
    return
  }
  hiddenAt = 0
  void video.play().catch(() => undefined)
}

onMounted(() => {
  pipSupported.value =
    typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled

  const video = videoRef.value
  if (video) {
    video.addEventListener('play', syncMediaState)
    video.addEventListener('pause', syncMediaState)
    video.addEventListener('enterpictureinpicture', onPipChange)
    video.addEventListener('leavepictureinpicture', onPipChange)
    syncMediaState()
  }

  window.addEventListener('keydown', onKeydown)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('pointermove', showControls, { passive: true })

  showControls()
  // 不再有「进门」这一步：挂载即开连，零点击出画
  start()
})

onBeforeUnmount(() => {
  if (hideTimer !== null) clearTimeout(hideTimer)
  const video = videoRef.value
  if (video) {
    video.removeEventListener('play', syncMediaState)
    video.removeEventListener('pause', syncMediaState)
    video.removeEventListener('enterpictureinpicture', onPipChange)
    video.removeEventListener('leavepictureinpicture', onPipChange)
  }
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  document.removeEventListener('pointermove', showControls)
})
</script>

<template>
  <div class="watch">
    <header class="topbar">
      <div class="topbar__left">
        <Icon name="monitor" :size="16" />
        <span class="topbar__room num">{{ session.room || '—' }}</span>
        <span v-if="isPlaying" class="live">
          <span class="live__dot" aria-hidden="true" />
          <span>LIVE</span>
        </span>
      </div>

      <div class="topbar__right">
        <StatusChip :transport="transport" :playing="isPlaying" />
      </div>
    </header>

    <!-- 分享条：短链接，拿到就能看。链接文本永远摊在页面上，可选中、可读 -->
    <div class="sharebar">
      <CopyField label="观看链接" :value="shareUrl" />
    </div>

    <div
      ref="stageRef"
      class="stage"
      :class="{ 'stage--hide-cursor': !controlsVisible && isPlaying }"
      @pointermove="showControls"
      @pointerdown="showControls"
      @touchstart.passive="showControls"
    >
      <video
        ref="videoRef"
        class="stage__video"
        playsinline
        preload="none"
        :muted="true"
        @volumechange="syncMediaState"
        @click="onVideoClick"
      />

      <JoinGate
        v-if="overlay === 'gate'"
        :room="session.room"
        :token="session.token"
        @enter="onEnter"
      />

      <div v-else-if="overlay !== 'none'" class="overlay">
        <div class="overlay__inner">
          <template v-if="overlay === 'connecting'">
            <Icon name="refresh" :size="28" class="spin" />
            <h2 class="overlay__title">正在建立连接</h2>
            <p class="overlay__desc">优先走 WebRTC（延迟 1 秒内），连不上会自动切到 HLS。</p>
          </template>

          <template v-else-if="overlay === 'waiting'">
            <Icon name="clock" :size="28" />
            <h2 class="overlay__title">主播还没有开播</h2>
            <p class="overlay__desc">
              页面会自己重试（间隔逐步拉长到 10 秒），开播后会自动开始播放，放着别关就行。
            </p>
            <p v-if="looksLikeMissingPath" class="overlay__note">
              服务端返回的是 404：房间里没有流。一直这样的话，确认 nginx 里的房间路径和构建时的
              ROOM 都是 <span class="num">{{ session.room }}</span>。
            </p>
            <p v-else-if="waitReason" class="overlay__note">上一次尝试：{{ waitReason }}</p>
          </template>

          <template v-else-if="overlay === 'reconnecting'">
            <Icon name="refresh" :size="28" class="spin" />
            <h2 class="overlay__title">连接断了，正在重连</h2>
            <p class="overlay__desc">{{ errorMessage || '稍等一下。' }}</p>
          </template>

          <template v-else-if="overlay === 'tap'">
            <button type="button" class="overlay__play" @click="togglePlay">
              <Icon name="play" :size="26" />
              <span class="sr-only">开始播放</span>
            </button>
            <h2 class="overlay__title">点击开始播放</h2>
            <p class="overlay__desc">浏览器拦住了自动播放，点一下就好。</p>
          </template>

          <template v-else>
            <Icon name="alert" :size="28" class="overlay__danger" />
            <h2 class="overlay__title">播不了</h2>
            <p class="overlay__desc overlay__desc--wrap">{{ errorText }}</p>
            <button type="button" class="overlay__retry" @click="retry">
              <Icon name="refresh" :size="16" />
              <span>重试</span>
            </button>
          </template>
        </div>
      </div>

      <SoundPrompt v-if="showSoundPrompt" @enable="turnOnSound" />

      <div v-if="statsOpen && stats" class="stage__stats">
        <StatsPanel :stats="stats" />
      </div>

      <ControlBar
        v-show="controlsVisible || !isPlaying"
        class="stage__bar"
        :class="{ 'stage__bar--overlay': fullscreen }"
        :playing="isPlaying && !paused"
        :muted="muted"
        :volume="volume"
        :stats-open="statsOpen"
        :fullscreen="fullscreen"
        :pip-supported="pipSupported"
        :pip-active="pipActive"
        @toggle-play="togglePlay"
        @toggle-mute="toggleMute"
        @update:volume="updateVolume"
        @toggle-stats="statsOpen = !statsOpen"
        @toggle-fullscreen="toggleFullscreen"
        @toggle-pip="togglePip"
      />
    </div>
  </div>
</template>

<style scoped>
.watch {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  background: var(--bg);
}

/* ---- 顶栏 ---- */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  height: var(--bar-top);
  padding: 0 var(--sp-4);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex: none;
}

.topbar__left,
.topbar__right {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}

.topbar__room {
  font-size: var(--fs-base);
  font-weight: 600;
  letter-spacing: -0.01em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  height: 22px;
  padding: 0 var(--sp-2);
  background: var(--live);
  color: var(--live-fg);
  border-radius: var(--r-sm);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.live__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

/* ---- 分享条 ---- */
.sharebar {
  flex: none;
  padding: var(--sp-2) var(--sp-4);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

/* ---- 舞台 ---- */
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #000;
}

.stage--hide-cursor {
  cursor: none;
}

.stage__video {
  flex: 1;
  min-height: 0;
  width: 100%;
  /* 屏幕共享内容是文字，用 contain 保住原始比例，宁可留黑边也不裁切 */
  object-fit: contain;
  background: #000;
  display: block;
}

.stage__bar {
  flex: none;
}

.stage__bar--overlay {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
}

.stage__stats {
  position: absolute;
  right: var(--sp-4);
  bottom: calc(var(--bar-bottom) + var(--sp-3));
  z-index: 2;
}

/* ---- 说明态 ---- */
.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--bg);
  padding: var(--sp-5);
  z-index: 3;
  overflow-y: auto;
}

.overlay__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  max-width: 440px;
  text-align: center;
}

.overlay__title {
  font-size: var(--fs-lg);
  font-weight: 600;
}

.overlay__desc {
  color: var(--fg-muted);
  font-size: var(--fs-base);
}

.overlay__desc--wrap {
  word-break: break-word;
}

.overlay__note {
  color: var(--fg-dim);
  font-size: var(--fs-xs);
  word-break: break-word;
}

.overlay__danger {
  color: var(--danger);
}

.overlay__play {
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  min-width: 72px;
  min-height: 72px;
  border-radius: 50%;
  background: var(--live);
  color: var(--live-fg);
  transition: filter var(--t-fast) var(--ease);
}

.overlay__play:hover {
  filter: brightness(1.12);
}

.overlay__retry {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  height: 40px;
  min-height: 40px;
  padding: 0 var(--sp-4);
  background: var(--surface-3);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  font-weight: 500;
  transition: background var(--t-fast) var(--ease);
}

.overlay__retry:hover {
  background: var(--border-strong);
}

.spin {
  animation: spin 1.6s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>
