/**
 * 会话参数。
 *
 * 房间号和观看路径都是**构建时从 .env 注入的常量**（见 vite.config.ts 的 define）：
 * 只有一个人推流、只有一个房间，nginx 负责把 /whep/<房间> 改写成 MediaMTX 的
 * /r-<房间>/whep，所以前端只要认这两个常量，别处不再传。
 *
 * 观看地址是**短链接** <origin>/<VIEW_PATH>（默认 /screen），默认不带令牌 ——
 * 服务端默认是开放模式，谁拿到链接谁就能看，点进去就该直接出画。
 * 将来把 VIEW_TOKEN 填上、服务端切成受控模式，观众就得用带 ?k= 的地址；
 * 所以这里一直保留「页面 URL 上有 ?k= 就透传到 WHEP / HLS」的能力，
 * 换模式不用改前端代码。
 */

/** 房间号，来自 .env 的 ROOM，没配就是 share01 */
export const FIXED_ROOM: string = __SCREEN_SHARE_ROOM__

/** 观看路径（不带首尾斜杠），来自 .env 的 VIEW_PATH，没配就是 screen */
export const VIEW_PATH: string = __SCREEN_SHARE_VIEW_PATH__

export interface Session {
  room: string
  token: string
}

/** 当前 origin，例如 http://43.142.33.45:8443 —— 全链路明文 http，没有域名也没有证书 */
export function origin(): string {
  return window.location.origin
}

/**
 * 地址栏里的 ?k=。默认（开放模式）是空串，请求就干干净净不带任何 query。
 *
 * 刻意**不落 localStorage**：令牌只从地址栏来，免得「没带令牌」这个状态
 * 被一个记下来的旧令牌悄悄顶掉。
 */
export function readToken(): string {
  return (new URLSearchParams(window.location.search).get('k') ?? '').trim()
}

/**
 * 把令牌拼到请求地址上 —— **只有真的带了令牌才拼**。
 *
 * 不做成「永远带一个空的 k=」：受控模式下 nginx 是 $arg_k != $token 就 401，
 * 空串一样会被拒，只是白白多出一堆没意义的参数。
 */
export function withToken(url: string, token: string): string {
  if (!token) return url
  return `${url}${url.includes('?') ? '&' : '?'}k=${encodeURIComponent(token)}`
}

/**
 * 发给观众的链接。
 *
 * 默认就是短链接 <origin>/<VIEW_PATH>，不带任何 query —— 拿到链接点开就能看。
 * 只有在受控模式下（页面地址栏里本来就带 ?k=）才把令牌一起带上，
 * 否则分享出去的那条链接对别人没用。
 */
export function buildWatchUrl(token = ''): string {
  return withToken(`${origin()}/${VIEW_PATH}`, token)
}

/**
 * 从用户粘贴的东西里抠出令牌 —— 只有受控模式下的门禁会用到。
 *
 * 分享链接长这样：http://43.142.33.45:8443/screen?k=<一串令牌>。
 * 但不是所有人都会整条复制：有人只复制 ?k= 后面那一段，
 * 有人从聊天软件里连首尾的尖括号 / 引号一起复制进来。
 * 所以先当链接解，解不出来再当裸令牌收。
 */
export function parseToken(input: string): string {
  const text = input.trim()
  if (!text) return ''

  const fromUrl = /[?&#]k=([^&\s#]+)/.exec(text)
  if (fromUrl) return decodeURIComponent(fromUrl[1])

  const bare = text.replace(/^[<"'`]+|[>"'`]+$/g, '').trim()
  return /^[A-Za-z0-9._~+/=-]{8,}$/.test(bare) ? bare : ''
}
