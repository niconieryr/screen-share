/**
 * LL-HLS 兜底播放。
 *
 * 什么时候用得上：观众所在网络把 UDP 整个掐掉时 WebRTC 建不起来。
 * HLS 走普通 HTTP，什么网络都能看，代价是延迟从亚秒涨到 2-4 秒。
 *
 * hls.js 有 590 KB，**必须动态 import**：只有真要降级时才去下载它，
 * 否则每个观众一进页面就得先吃下这 590 KB，首屏白等。
 */
import type HlsJs from 'hls.js'

import { origin, withToken } from '@/lib/config'

/** HLS 播放失败。status 是服务端 HTTP 状态码，拿不到时为 0。 */
export class HlsPlaybackError extends Error {
  readonly status: number
  /** 这个浏览器既没有 MSE 也没有原生 HLS —— 等下去也不会变好 */
  readonly unsupported: boolean

  constructor(message: string, options: { status?: number; unsupported?: boolean } = {}) {
    super(message)
    this.name = 'HlsPlaybackError'
    this.status = options.status ?? 0
    this.unsupported = options.unsupported ?? false
  }
}

export interface HlsHandle {
  destroy(): void
  bandwidthEstimate(): number
}

/** hls.js 的 ERROR 事件里我们只用到这几个字段 */
interface HlsErrorData {
  fatal?: boolean
  details?: string
  response?: { code?: number; text?: string }
}

const MANIFEST_TIMEOUT_MS = 12000

export async function startHls(
  video: HTMLVideoElement,
  room: string,
  token: string,
): Promise<HlsHandle> {
  // 令牌只在**第一个**请求上带（而且只有页面 URL 里带了 ?k= 才带），
  // nginx 会据此种下 cookie；后面的分片请求不带 query，靠 cookie 通过。
  //
  // 两个坑都在服务端解决掉了，这里不用管：
  //   1. hls.js 请求分片时不会把播放列表上的 query 带过去，所以令牌必须走 cookie，
  //      而 cookie 是 nginx 在「第一次带 ?k= 的请求」上种的 —— 首个 playlist 请求
  //      必须带 ?k=，之后 xhrSetup 里什么都不用加。
  //   2. nginx 会把 query 整个换成固定的 cookieCheck=1，顺手把令牌从后续请求里抹掉
  //      （不然参数会一轮轮累积，init 分片地址每次都变，客户端反复重下）。
  const url = withToken(`${origin()}/hls/${room}/index.m3u8`, token)

  const { default: Hls } = await import('hls.js')

  if (Hls.isSupported()) {
    const hls: HlsJs = new Hls({
      lowLatencyMode: true,
      enableWorker: true,
      backBufferLength: 30,
      // 直播场景：别攒分片，尽量贴着直播边缘播
      liveSyncDurationCount: 2,
      maxLiveSyncPlaybackRate: 1.5,
    })

    hls.attachMedia(video)

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new HlsPlaybackError('HLS 播放列表加载超时'))
      }, MANIFEST_TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timer)
        hls.off(Hls.Events.MANIFEST_PARSED, onParsed)
        hls.off(Hls.Events.ERROR, onError)
      }
      const onParsed = () => {
        cleanup()
        resolve()
      }
      const onError = (_event: unknown, data: HlsErrorData) => {
        // 非致命错误 hls.js 会自己重试（比如某个分片 404），只有致命错误才放弃
        if (!data?.fatal) return
        cleanup()
        // 服务端状态码要一路带到上层：401 是链接失效，404 是没有流，
        // 两者对观众的说法完全不同。
        const status = data.response?.code ?? 0
        reject(
          new HlsPlaybackError(
            `HLS 加载失败：${data.details ?? '未知错误'}${status ? `（HTTP ${status}）` : ''}`,
            { status },
          ),
        )
      }

      hls.on(Hls.Events.MANIFEST_PARSED, onParsed)
      hls.on(Hls.Events.ERROR, onError)
      hls.loadSource(url)
    })

    return {
      destroy: () => hls.destroy(),
      bandwidthEstimate: () => hls.bandwidthEstimate ?? 0,
    }
  }

  // Safari / iOS 走原生 HLS
  if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new HlsPlaybackError('原生 HLS 加载超时'))
      }, MANIFEST_TIMEOUT_MS)

      const cleanup = () => {
        clearTimeout(timer)
        video.removeEventListener('loadedmetadata', onLoaded)
        video.removeEventListener('error', onFailed)
      }
      const onLoaded = () => {
        cleanup()
        resolve()
      }
      const onFailed = () => {
        cleanup()
        reject(new HlsPlaybackError('原生 HLS 加载失败'))
      }

      video.addEventListener('loadedmetadata', onLoaded)
      video.addEventListener('error', onFailed)
    })

    return {
      destroy: () => {
        video.removeAttribute('src')
        video.load()
      },
      bandwidthEstimate: () => 0,
    }
  }

  throw new HlsPlaybackError('这个浏览器既不支持 MSE，也不支持原生 HLS', { unsupported: true })
}
