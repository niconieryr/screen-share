/// <reference types="vite/client" />

/**
 * 构建时从 .env 的 ROOM 注入（见 vite.config.ts 的 define）。
 * .env 不存在或没写 ROOM 时是 'share01'。
 * 房间号是固定的，前端的 WHEP / HLS 路径全靠它。
 */
declare const __SCREEN_SHARE_ROOM__: string
