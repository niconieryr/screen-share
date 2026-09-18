# 一键装 OBS profile（install-obs-profile.ps1）

`deploy/obs/` 里的素材是**已经调好**的参数，但手工照着抄进 OBS 容易漏项（关键帧、
B 帧、lookahead 这些在界面上分散在三四个地方）。这个脚本把两套预设直接渲染成
OBS profile 文件装到本机，装完在 OBS 菜单里选一下就能推。

```powershell
./scripts/install-obs-profile.ps1                  # 从项目根 .env 拼推流地址
./scripts/install-obs-profile.ps1 -ShowPublishUrl  # 顺便把完整地址打出来
```

## 装出来的两个 profile

profile 的名字就是 **OBS「配置文件 / Profile」菜单里看到的名字**：

| profile 名 | 适用 | 视频 | 音频 | 关键帧 | 出口占用 |
|---|---|---|---|---|---|
| `screen-share-3-4人` | **3-4 人（默认）** | 1080p**20** CBR **700** kbps | Opus 64k | 2 秒 | ≈3.3 Mbps（4 人） |
| `screen-share-1-2人` | 1-2 人，画质优先 | 1080p**30** CBR **1400** kbps | Opus 64k | 2 秒 | ≈3.1 Mbps（2 人） |

名字里带中文是有意的：OBS 的 profile 菜单里一眼能看出**该选哪个**（OBS 自带的中文
profile 就叫「未命名」，中文名没问题）。两套预设的差别只有**帧率 + 码率**，其余完全一致：

- `Mode=Advanced` —— Simple 模式改不了关键帧间隔，默认 250 帧（20fps 下 12.5 秒），
  HLS 兜底的观众要等一个关键帧才出画
- `bf: 0` —— 浏览器实现 WebRTC 时刻意不支持 H.264 的 B 帧，开了就**只出声不出画**
- `keyint_sec: 2` —— 观众加入最多等 2 秒；比 1 秒省约 6% 码率
- `tune=ll` / `multipass=disabled` / `lookahead=false` / `psycho_aq=false` —— 低延迟取向，
  `psycho_aq` 开着屏幕文字会抖
- `repeat_headers: true` —— 中途加入的观众立刻拿到 SPS/PPS
- 音频 Opus 64 kbps @48 kHz 立体声，MediaMTX 零转码直通给观众

参数为什么是这些数，见 `docs/OBS-设置.md` 和 `deploy/obs/README.md`（出口只有 4 Mbps，
OBS 推多高每个观众就下载多高）。

## 装到哪个目录

OBS 有**两个历史布局**，写错地方 OBS 根本看不见；脚本默认自动探测，并把依据打印出来，
也可以用 `-ProfilesDir` 强制指定：

| 布局 | 路径 | 说明 |
|---|---|---|
| OBS ≤32 | `%APPDATA%\obs-studio\basic\profiles\<名字>\` | **本机 OBS 32.2.2 实测就是这个**：`obs64.exe` 里嵌的字符串是 `/obs-studio/basic/profiles/`，`user.ini` 的 `ProfileDir` 也落在这一层 |
| 新布局 | `%APPDATA%\obs-studio\profiles\<名字>\` | 存在就用；本机没有这个目录 |

探测顺序：

1. `-ProfilesDir`（命令行强制）
2. `user.ini` 里**当前选中的 profile** 落在哪个候选目录 —— 最硬的证据
3. 候选目录里 profile 文件**最新修改**的那个（OBS 退出时会回写，最能说明谁在真用）
4. `basic\profiles` 下有现成 profile 目录 → 用它
5. 只剩一个候选目录 → 用它；两个都没有 → 直接报错，**不猜**

不写死 `%APPDATA%\obs-studio\profiles\` 的原因：在没装出那个目录的机器上会装出一个
OBS 永远看不到的 profile，用户会以为脚本坏了。

`-ProfilesDir` 指向的目录必须**已经存在**（防手滑打错路径，凭空造出一个 OBS 不认的目录）。

## 推流地址和令牌

`service.json` 里的 `server` 就是推流地址，**含推流令牌**：

- `-PublishUrl 'http://host:8443/whip/<房间>?k=<令牌>'` 直接给完整地址；不给则从项目根
  `.env` 的 `PUBLIC_HOST` / `PUBLIC_PORT` / `ROOM` / `PUBLISH_TOKEN` 拼
- 协议：`-Scheme auto`（默认）时端口 443 用 `https`，其余用 `http` —— 本项目是
  **明文 http + IP 端口**（没有域名就签不了真证书，而 OBS 对 HTTPS 的 WHIP 会静默
  拒绝自签证书，见 README）
- 真实令牌**只落进 `%APPDATA%` 下的 profile**（仓库外），**不入库**；控制台默认打码
  （`k=4c36…a80e`），要看全加 `-ShowPublishUrl`。仓库里只有 `service.json.template`
  这个带 `__WHIP_URL__` 占位符的模板
- `.env` 里还是 `changeme-*` 模板值时给黄色警告（不拦），免得把推不上去的地址装进 OBS
- 轮换令牌：改 `.env` → 重跑 `deploy/deploy.ps1 -SkipBuild` → **重跑本脚本**（OBS profile
  里的地址不会自己更新）

## 它不碰什么

- 不动 `user.ini` / `global.ini`（你的当前 profile、界面布局都在里面，OBS 自己爱怎么写怎么写）
- 不动 `basic\scenes\*`（scene collection 一个字节都不改）
- 不动别的 profile 目录 —— 只写自己那两个
- 同名目录若**不是**本脚本装的（没有归属标记 `.screen-share-profile.json`），
  先把整个目录改名成 `<名字>.bak-<时间戳>` 备份，再装；绝不静默覆盖别人的东西
- **OBS 在跑就拒绝执行**（退出码 2）：OBS 退出时会把内存里的设置整个回写 profile，
  会把刚装好的参数盖掉，而且 profile 列表是 OBS **启动时**扫描的，不重启也看不见。
  先完全退出 OBS（含托盘图标）再重跑

唯一的例外：`-ProfilesDir` 指到 `%APPDATA%\obs-studio` **之外**的目录（临时目录、沙箱、
CI 里做自检）时照装不误 —— OBS 既不读也不写那里，脚本会明确提示“这种目录不会出现在
OBS 菜单里”。真正的安装永远落在 OBS 配置目录里，所以这条例外不会削弱上面的保护。

## 幂等

内容一致的文件不重写（会打印“跳过（内容已一致）”）；被 OBS 回写改掉的文件会被纠正回来
（打印“写/改：…”）。所以：**重复执行结果一致**，装完再跑一次不会多出备份目录、
也不会把时间戳刷来刷去。归属标记里不带时间戳，就是为了这个。

## 装完之后

```
OBS 菜单「配置文件 / Profile」→ screen-share-3-4人（或 -1-2人）
  → 加画面来源（窗口采集 / 桌面音频）→ 开始推流
  → node scripts/check-obs.mjs      # 从 OBS 日志核对 B 帧/码率/Opus 是不是真的生效
```

OBS 界面显示的值不一定等于真正生效的值（尤其 B 帧和关键帧间隔），所以推流后必须跑一次
`check-obs.mjs`。profile 列表是 OBS **启动时**扫描的：本脚本只在 OBS 关闭时才会执行，
所以下次打开 OBS 就能在菜单里看到这两个 profile，不需要额外重启。

卸载：关掉 OBS，删掉 `%APPDATA%\obs-studio\basic\profiles\screen-share-3-4人` 和
`...\screen-share-1-2人` 两个目录即可，你自己的 profile 和 scene collection 不受影响。
