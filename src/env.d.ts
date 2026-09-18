/// <reference types="vite/client" />

/**
 * 构建时从 .env 的 ROOM 注入（见 vite.config.ts 的 define）。
 * .env 不存在或没写 ROOM 时是 'share01'。
 * 房间号是固定的，前端的 WHEP / HLS 路径全靠它。
 */
declare const __SCREEN_SHARE_ROOM__: string

/**
 * 构建时从 .env 的 VIEW_PATH 注入。发给观众的短链接就是 <origin>/<这个>。
 * .env 不存在或没写 VIEW_PATH 时是 'screen'。
 */
declare const __SCREEN_SHARE_VIEW_PATH__: string
