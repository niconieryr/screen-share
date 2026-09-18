# screen-share

OBS 推屏幕画面和声音，别人打开一条链接就能看。发起方只有你一个人，房间号是固化的。
部署在腾讯云 CVM `43.142.33.45` 上，**明文 http + IP 端口访问**，对外只有一个端口。

页面没有多余东西：一块顶栏、一块画面、一条控制栏。全部纯色块，没有阴影、没有渐变、没有弹窗。

---

## 访问地址

| 地址 | 谁用 |
|---|---|
| `http://43.142.33.45:8443/screen` | **观看链接**，打开就出画，直接发人 |
| `http://43.142.33.45:8443/whip/share01?k=<推流令牌>` | OBS 推流地址（服务选 WHIP，这条**带令牌**） |

`/` 会 302 跳到 `/screen`，别的路径一律 404（所以路径本身能挡住随手扫描的人）。
推流令牌在 `.env` 里（`.env` 不入库），`deploy/deploy.ps1` 跑完会把两条链接打印出来。

**观看是公开的，推流才受保护** —— 这是刻意的取舍：链接要能口头念、能手打，
`/screen?k=<32位随机串>` 那种没人愿意念；而推流令牌一旦泄露，别人就能顶掉你的画面，
所以它必须留着。真要给观看加锁，把 `.env` 的 `VIEW_TOKEN` 填上一串随机值重跑部署，
那时观看请求必须带 `?k=`（模板会渲染出校验），分享链接变回带令牌的长链接。

## 端口

| 位置 | 端口 | 用途 | 谁放行 |
|---|---|---|---|
| 公网 | `8443/tcp` | 唯一入口：页面 + WHIP/WHEP/HLS | 腾讯云安全组（已放行） |
| 公网 | `8189/udp` | WebRTC 媒体（DTLS-SRTP 加密） | **腾讯云安全组 + 本机 ufw** |
| 回环 | `8888` | MediaMTX HLS | 只绑 `127.0.0.1`，公网进不来 |
| 回环 | `8889` | MediaMTX WebRTC 信令（WHIP/WHEP） | 只绑 `127.0.0.1` |
| 回环 | `9996` | MediaMTX 控制 API（只用于自检排障，不反代） | 只绑 `127.0.0.1` |

**`80` / `443` / `443udp` 是 AcePanel 的**，本项目一个都不碰（`443/udp` 被面板的 HTTP/3 占着，
所以 WebRTC 媒体口只能用 8189）。

安全组放行是在**腾讯云控制台**做的，脚本改不了，属人工步骤：

```
入站规则：UDP 8189   来源 0.0.0.0/0   允许
```

不放行也能用：观众会自动落到 LL-HLS 兜底，代价是延迟从亚秒变成 2-4 秒。

## 架构

```
OBS 32 ──WHIP(http POST)──▶ nginx:8443 ──▶ 127.0.0.1:8889 MediaMTX
    └── 媒体 DTLS-SRTP / UDP 8189（用 IP，不用域名）────┘
                                                     │
观众浏览器 ◀── WHEP(http) ── nginx:8443 ◀─────────────┤ 主路径，<1s，Opus 直通
观众浏览器 ◀── LL-HLS(http) ─ nginx:8443 ◀────────────┘ 兜底，2-4s，UDP 被封时自动切
```

三个组件：**OBS**（已有）、**MediaMTX**（现成的开源媒体服务器）、**一个 nginx 容器**
（静态站 + 令牌校验 + 反代）。**没有自研后端**：状态、编解码、观众数都由 MediaMTX 提供，
少一个常驻服务就少一整类故障。

服务端只转发不转码：OBS 用 **WHIP** 推流，音轨**原生就是 Opus**，MediaMTX 原样转给 WHEP 观众，
画面 H.264 直通。

## 带宽预算（这台机器最硬的约束）

出口带宽 **4 Mbps**，而 MediaMTX 零转码 —— **OBS 推多高，每个观众就下载多高**：

```
出口占用 =（视频码率 + 音频码率）× 人数 × 1.07（RTP/SRTP/UDP 头开销）
```

预留 15% 余量，出口目标 ≤3.4 Mbps：

| 现场人数 | 视频（NVENC CBR） | 音频 | 每人在线 | 出口合计 |
|---|---|---|---|---|
| 1 人 | 1080p30 @ 2500 kbps | Opus 64k | ≈2.74 Mbps | 2.7 Mbps |
| 2 人 | 1080p30 @ 1400 kbps | Opus 64k | ≈1.57 Mbps | 3.1 Mbps |
| 3 人 | 1080p20 @ 950 kbps | Opus 64k | ≈1.08 Mbps | 3.3 Mbps |
| **4 人（默认）** | **1080p20 @ 700 kbps** | **Opus 64k** | **≈0.82 Mbps** | **≈3.3 Mbps** |
| 5-10 人 | 每人只剩 ≤320 kbps | — | — | 屏幕文字会糊，不建议 |

要真上 10 人，只有三条路：

1. **把这台实例改成按流量计费**（峰值一般 100 Mbps，10 人 1 Mbps 看 1 小时约 4.5 GB ≈ ¥3.6）——推荐
2. 继续降码率/降帧率/降分辨率
3. 自研 P2P 中继（观众之间互相转发）——唯一不花钱的扩容办法，但要自研信令，且 NAT 穿透失败时
   流量还是回到服务器；3-4 人的规模不值得

> 注意：本机**入向**不受 4 Mbps 限制（实测国内下载 138 Mbps），所以 OBS 推流本身不受限；
> 受限的是每个观众的下载。

## 部署与更新

```powershell
# 一次性
Copy-Item .env.example .env      # 然后把两个 token 改成随机值

# 之后每次
./deploy/deploy.ps1              # 构建 → 渲染配置 → 推主机 → 起容器 → 自检
./deploy/deploy.ps1 -SkipBuild   # 只改了 token / 端口，不重新构建前端
```

脚本是幂等的：只覆盖本项目自己的文件，`/srv/screen-share` 之外不动任何东西
（`AcePanel` 和它的 80/443 完全不碰）。起容器前会先用一次性容器跑 `nginx -t`，
配置有问题就直接退出，现有容器保持原样。

> **部署不会随便打断直播**：脚本先比对渲染结果的 md5 和主机上那份，一致就只原地替换
> 前端产物（`find -delete` + `cp -a`，保持目录 inode，bind mount 才不会失效），
> 容器一动不动；只有 `mediamtx.yml` / `nginx.conf` 真的变了才 `--force-recreate`
> （MediaMTX 只在启动时读配置，不重建等于没改），那一刻会有 2-5 秒中断，
> OBS 一般会自动重连，没接上就点一下「开始推流」。

轮换与开关（都改 `.env` 后重跑 `deploy.ps1 -SkipBuild`）：

| 想做什么 | 改哪个键 | 效果 |
|---|---|---|
| 换推流地址（怀疑泄露） | `PUBLISH_TOKEN` | OBS 里那条 URL 立刻失效，要重新填 |
| 收回观看链接 | `VIEW_PATH` | 旧地址 404，新地址可用 |
| 给观看加锁 | `VIEW_TOKEN` 填随机串 | 观看必须带 `?k=`，分享链接变长 |
| 解锁观看 | `VIEW_TOKEN` 留空 | 回到 `/screen` 打开就能看 |

房间号和端口同理（房间号同时写在 nginx 的 location、MediaMTX 的 paths 和前端构建里，
三处都从 `.env` 取值，所以只能通过重新部署来改）。

## 验收

```powershell
node scripts/e2e.mjs             # 端到端：合成推流 → 出画 → 音轨 → 降级 → 越权
node scripts/load-test.mjs       # 并发：N 路只收不渲染，量出口占用和可支撑人数
node scripts/check-obs.mjs       # 从 OBS 日志核对 B 帧/码率/Opus 是否真的生效
```

`e2e.mjs` 用真实浏览器自己合成一路 WHIP 推流（canvas 画方块 + 振荡器出 440Hz，
强制 H.264 + Opus，和 OBS 的路径一致），不碰你的屏幕，也不需要 OBS 在场。

> ⚠️ **正在直播时 e2e 会拒绝运行**：MediaMTX 的 `overridePublisher` 默认是 true，
> 合成推流会把正在推的 OBS **顶下线**（实测约 2 秒后 OBS 才自动重连，观众会断一下）。
> 脚本会先探一下房间里有没有流，有就退出并提示；确实要顶掉时加 `--force`。
> `load-test.mjs` 只收不推，不受影响。

**实测结果（2026-09-19）**：

| 项 | 实测 |
|---|---|
| `GET /screen` 零点击出画 | **1.5 秒**出 1920×1080，全程 0 次点击，起播即静音 |
| 「点击开启声音」 | 点一下 → `video.muted=false`，画面不中断 |
| 走的路径 | WebRTC（整段没有任何 `.m3u8` 请求） |
| WHIP 推流 / 观众页 WHEP | PeerConnection connected / 2.3 秒出画 |
| 拦掉 WHEP 自动降级 HLS | 3.0 秒出画，随后持续推进（3 秒推进 3.49 秒） |
| 服务端转码 | 无：推流端 1920×1080 H264+Opus → 收看端一致 |
| 越权 | 推流令牌错/缺 401、房间名错 404、观看侧**不校验令牌** |
| 4 路并发（压测） | 每路 0.27 Mbps，合计 1.07 Mbps，占 4 Mbps 预算 **28.6%** |

> 压测那个 0.27 Mbps 是**合成画面**（大片纯色）的码率，压缩率远高于真实屏幕内容，
> 只用来证明「服务端扛得住 N 路并发」。真实码率按 OBS 的 CBR 预设估，见上面的预算表。
> e2e 共 29 条断言（开放观看模式）。

## 踩过的坑

这一节是部署时真踩出来的，改配置前先看一眼：

1. **MediaMTX 1.21 的 HLS 要保留 `session` 参数。** master 播放列表里的变体地址是
   `video1_stream.m3u8?session=<uuid>`，变体和分片都靠它认会话。照抄旧项目
   （跑的是 1.17.1）那种「把 query 整个换成 `cookieCheck=1`」的写法，表现是
   **master 正常、变体一律 401**，而那个 401 是 MediaMTX 用 JSON 回的，很容易误判成
   令牌问题。现在 nginx 里是「先快照 `$arg_session`，再钉死 `cookieCheck` 并拼回
   session」。注意顺序不能反：`set $args` 之后再读 `$arg_session` 永远是空的。
2. **OBS 静默拒绝自签证书的 WHIP**，所以没有域名就别做自签 HTTPS，直接明文 http。
3. **OBS 必须关 B 帧**，否则浏览器只出声不出画。
4. **MediaMTX 会把收到的 query 原样拼进播放列表的子地址**，nginx 要是再补参数就会
   一轮轮累积（旧项目实测 init 分片堆到 3 个 `cookieCheck`、4 个 `k`），所以要用
   `set $args` 钉死，**不能**在 rewrite 的替换串里带参数。
5. **WebRTC 的 ICE 候选用 IP 不用域名**，而且腾讯云 CVM 的公网 IP 是 NAT 映射，
   必须 `webrtcAdditionalHosts` 写死 + `webrtcIPsFromInterfaces: no`。
6. **MediaMTX 只在启动时读配置**，改了 `mediamtx.yml` 必须 `--force-recreate`
   （`docker compose up -d` 看配置没变就不会重建容器，改了等于没改）。
7. **控制 API 的权限是独立的 `api` action**，`authInternalUsers` 里少写一个就是 401。
8. **官方镜像是 distroless**，连 `sh` 都没有，所以那个容器加不了 healthcheck。


## 明文 http 的代价

没有域名就签不了真证书，而 **OBS 对 HTTPS 的 WHIP 会静默拒绝自签证书**
（握手失败但不给像样的提示），所以干脆不做自签 HTTPS：

- 浏览器地址栏显示「不安全」（功能不受影响：WHEP 播放不要求安全上下文）
- 页面的「复制链接」按钮在非安全上下文下拿不到 `navigator.clipboard`，
  前端已降级成 textarea + `execCommand`，并且始终显示一份可手动选中的链接
- 观看链接本身**不保密**（`/screen` 打开就能看）。想加锁就把 `VIEW_TOKEN` 填上，
  代价是分享链接变长；推流令牌任何时候都不能外发
- 将来要 HTTPS：加一条 DNS 记录 + 面板签证书即可，反代结构不用改

## 已知限制

- **出口只有 4 Mbps**，所以同时观看人数与画质是此消彼长的，见上面的预算表。这是唯一的硬约束。
- **MediaMTX 容器没有 healthcheck**：官方镜像是 distroless，里面连 `sh` 都没有
  （`docker run --entrypoint sh` 直接 exec 失败），放不进任何探针。补偿手段是
  `restart: unless-stopped` + 部署脚本从宿主机打控制 API 自检。别为了凑一个 healthcheck
  往容器里挂 busybox，那只会让排障更绕。
- **WebRTC 媒体走 IP 不走域名**（`ADVERTISE_IP`）：ICE 候选本质上是 IP，写域名要靠进程
  启动时解析，DNS 一抖就连不上；而且这条链路跟 http 入口本来也没关系。
- **UDP 被封的观众会自动降到 HLS**，延迟变成 2-4 秒。这是设计里的兜底，不是故障。
- **LL-HLS 的分片时长会被 MediaMTX 按帧率微调**，日志里可能出现
  `part duration changed from 200ms to 234ms - this will cause an error in iOS clients`。
  桌面浏览器（hls.js）不受影响；真遇到 iPhone/Safari 播不了，把 `mediamtx.yml.template`
  里的 `hlsVariant` 从 `lowLatency` 改成 `fmp4` 重跑部署即可，代价是延迟涨到 3-6 秒。
- **非 443 端口**：运营商和校园网有时对非标准端口做限速或降优先级，8443 属于这种。
  真遇到明显抖动，唯一的解法是把域名加回来走 443（结构不用改）。
- **WHEP 的 PATCH（补候选）会被 MediaMTX 回 400**，前端已经刻意忽略它（控制台里是
  `[whep] 补候选被拒（HTTP 400），忽略`）。无影响：本方案没有 STUN/TURN，
  客户端能拿到的候选在首次 offer 里就已经齐了，PATCH 那条路本来就是次要路径。
  真要加 TURN 才需要回头看这条。
- **单房间**：房间号固化在 `.env`，服务端只认这一个路径，别的路径一律 404。
  改房间号要重跑 `deploy.ps1`。

## 目录

```
docker-compose.yml                 mediamtx + edge 两个容器（host 网络，各自内存上限）
.env.example                       固化参数：房间、端口、两个令牌
deploy/
  mediamtx.yml.template            MediaMTX 配置模板（占位符由 .env 填充）
  nginx.conf.template              edge 的 nginx 配置模板
  deploy.ps1                       本地：构建 → 渲染 → 推送 → 调用远端脚本
  remote-install.sh                服务器侧：ufw → 校验 nginx → 起容器 → 自检
  obs/                             OBS profile 素材（两套码率预设）
docs/
  OBS-设置.md                       OBS 怎么配，以及每个选项为什么
  OBS-profile-安装.md              用脚本把预设装进本机 OBS（含目录探测依据）
scripts/
  e2e.mjs                          端到端验收（23 条断言）
  load-test.mjs                    并发压测（只收不渲染）+ 出口预算报告
  check-obs.mjs                    从 OBS 日志核对实际生效的参数
  install-obs-profile.ps1          把 deploy/obs 的两套预设装进本机 OBS
  lib/harness.mjs                  共用：合成推流、统计采样、HLS 三级探针
src/                               Vue 3 + Vite + TS（观看页）
```

本仓库**没有 Dockerfile**：前端在本地构建、主机只跑上游镜像，符合工作区规范里
「不在主机上重编译、编译型项目优先在本地出产物」。镜像版本在 compose 里钉死。

## 设计约定

扁平化不是口号，是写进 CSS 的约束：`box-shadow: none` 和 `background-image: none` 全局生效；
层级只靠纯色块 + 1px 分隔线，圆角只有 2px / 4px；图标是内联 SVG，不用 emoji；
过渡只动 `opacity / color / transform`，`prefers-reduced-motion` 下归零；触控目标最小 44×44。
