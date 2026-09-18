import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

/** 房间号的形状，要和 nginx 里的路径、MediaMTX 的 r-<房间> 一致：小写字母 + 数字，6-32 位 */
const ROOM_RE = /^[a-z0-9]{6,32}$/
/** .env 还没写出来（部署脚本首次构建）时用它，保证前端永远有个能用的房间号 */
const DEFAULT_ROOM = 'share01'

/** 观看路径的形状：不带首尾斜杠，可以多段，例如 screen、watch/room1 */
const VIEW_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
/** 短链接走 /screen，和 nginx 里那个 location 对齐 */
const DEFAULT_VIEW_PATH = 'screen'

export default defineConfig(({ mode }) => {
  // 房间号和观看路径都固化：构建时从 .env 读进来注入前端。
  // 服务端（nginx 的 location 路径、MediaMTX 的 paths）也只认这一个房间，两边必须一致，
  // 所以这里读的就是部署脚本渲染配置时用的同一个 .env。
  //
  // 没有 .env、或者 .env 里没有 ROOM / VIEW_PATH 时**静默**回退到默认值：
  // 首次构建时 .env 可能还没生成，那不是错误，不该刷一堆警告出来。
  const env = loadEnv(mode, process.cwd(), '')

  const configuredRoom = (env.ROOM ?? '').trim()
  const room = configuredRoom || DEFAULT_ROOM

  // 只有「写了但写歪了」才值得说一句：这种值服务端不会认，
  // 前端会一直停在「等待主播开播」，很难查。
  if (configuredRoom && !ROOM_RE.test(configuredRoom)) {
    console.warn(
      `[screen-share] .env 里的 ROOM="${configuredRoom}" 不合法（只允许 6-32 位小写字母和数字）；` +
        `服务端不会认这个房间，改成合法值后再构建。`,
    )
  }

  const configuredPath = (env.VIEW_PATH ?? '').trim().replace(/^\/+|\/+$/g, '')
  const viewPath = configuredPath || DEFAULT_VIEW_PATH

  if (configuredPath && !VIEW_PATH_RE.test(configuredPath)) {
    console.warn(
      `[screen-share] .env 里的 VIEW_PATH="${configuredPath}" 看起来不像一条路径；` +
        `观众链接会拼成 /${configuredPath}，确认 nginx 里也有对应的 location。`,
    )
  }

  return {
    plugins: [vue()],
    define: {
      __SCREEN_SHARE_ROOM__: JSON.stringify(room),
      __SCREEN_SHARE_VIEW_PATH__: JSON.stringify(viewPath),
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    build: {
      // 产物直接落到 www/，部署脚本整个目录推到服务器
      outDir: 'www',
      emptyOutDir: true,
      // 观看页首屏越短越好：媒体页不需要 prefetch 花活
      target: 'es2022',
      assetsInlineLimit: 2048,
      // hls.js 本来就大（590 KB），而且已经改成动态 import 了，别为它刷警告
      chunkSizeWarningLimit: 700,
    },
  }
})
