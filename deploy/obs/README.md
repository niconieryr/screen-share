# OBS profile 素材

这里放的是**已经调好**的 OBS 参数，配合 `docs/OBS-设置.md` 使用。
出发点是这台机器的硬约束：**出口带宽只有 4 Mbps**，而 MediaMTX 全程零转码，
所以 OBS 推多高的码率，每个观众就下载多高的码率。

出口占用 = （视频码率 + 音频码率）× 人数 × 1.07（RTP/SRTP/UDP 头开销）。

| 文件 | 场景 | 视频 | 音频 | 每人在线 | 4 人合计 |
|---|---|---|---|---|---|
| `streamEncoder.default.json` | **3-4 人（默认）** | 1080p20 CBR 700 kbps | Opus 64k | ≈0.82 Mbps | ≈3.3 Mbps |
| `streamEncoder.quality.json` | 1-2 人，画质优先 | 1080p30 CBR 1400 kbps | Opus 64k | ≈1.57 Mbps | （2 人 3.1 Mbps） |

两个文件里都必须是这几条，**改之前先看 `docs/OBS-设置.md` 的解释**：

- `bf: 0` —— 浏览器实现 WebRTC 时**刻意不支持 H.264 的 B 帧**，开了就只出声不出画
- `keyint_sec: 2` —— 关键帧间隔 2 秒。比 1 秒省约 6% 码率，代价是观众加入时要多等最多 2 秒
- `profile: high` / `tune: ll` / `multipass: disabled` / `lookahead: false` / `psycho_aq: false`
  —— 低延迟取向，和旧项目实测过的一致
- `repeat_headers: true` —— 新观众中途加入时能立刻拿到 SPS/PPS

`basic.ini` 是输出/视频/音频的公共部分（1080p20、Opus、断流自动重连）。

`service.json.template` 里的推流地址含**推流令牌**，所以入库的是模板；
真实值由 `deploy/deploy.ps1` 跑完打印，或看项目根目录的 `.env`。
