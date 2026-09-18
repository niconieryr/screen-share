/**
 * 会话参数。
 *
 * 房间号是**构建时从 .env 注入的常量**（见 vite.config.ts 的 define）：
 * 只有一个人推流、只有一个房间，nginx 负责把 /whep/<房间> 改写成 MediaMTX 的
 * /r-<房间>/whep，所以前端只要认这一个常量，别处不再传房间号 ——
 * 也就不会出现「哪里填错房间导致什么都不通」。
 */

/** 房间号，来自 .env 的 ROOM，没配就是 share01 */
export const FIXED_ROOM: string = __SCREEN_SHARE_ROOM__

export interface Session {
  room: string
  token: string
}

/** 当前 origin，例如 http://43.142.33.45:8443 —— 全链路明文 http，没有域名也没有证书 */
export function origin(): string {
  return window.location.origin
}

/**
 * 地址栏里的 ?k=。
 *
 * 刻意**不落 localStorage**：这是个单页应用，令牌只从地址栏来。
 * 存起来的话「没带令牌」这个状态就永远不会出现，门禁页也就形同虚设了。
 */
export function readToken(): string {
  return (new URLSearchParams(window.location.search).get('k') ?? '').trim()
}

/**
 * 从用户粘贴的东西里抠出令牌。
 *
 * 分享链接长这样：http://43.142.33.45:8443/?k=<一串令牌>。
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

/** 拼一条能直接发出去的观看链接 */
export function buildWatchUrl(token: string): string {
  return `${origin()}/?k=${encodeURIComponent(token)}`
}
