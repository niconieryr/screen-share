#!/usr/bin/env bash
#
# screen-share 服务器侧安装脚本（幂等）。
# 由 deploy/deploy.ps1 推到 /srv/screen-share 后调用，也可以手动重跑。
#
# 用法: bash remote-install.sh <api_port> <public_port> <public_host> <udp_port> [--no-recreate]
#
# 原则：只新增/覆盖 screen-share 自己的文件，**不动**这台机器上任何现存服务
# （尤其 AcePanel 和它占用的 80/443/443udp），也不删改 ufw 里既有的规则。
set -euo pipefail

API_PORT="${1:?需要 api 端口}"
PUBLIC_PORT="${2:?需要对外端口}"
PUBLIC_HOST="${3:?需要对外地址}"
UDP_PORT="${4:?需要 WebRTC 媒体端口}"
NO_RECREATE=0
if [ "${5:-}" = "--no-recreate" ]; then NO_RECREATE=1; fi

APP_DIR=/srv/screen-share

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ -d "$APP_DIR" ] || die "$APP_DIR 不存在，先跑 deploy.ps1"

log "1/5 目录与权限"
mkdir -p "$APP_DIR/data"
chmod 600 "$APP_DIR/mediamtx.yml" 2>/dev/null || true
chmod 600 "$APP_DIR/nginx.conf" 2>/dev/null || true
# scp 从 Windows 推上来的目录权限是乱的（见过 drwx---rwx，other 还带写权限）。
# edge 容器里 nginx 的 worker 以 uid 101 跑，要能读到静态文件。
# 统一收敛成「目录 755 / 文件 644」——注意别用 a+rX，它只加不减，收敛不掉 other 的写权限。
chmod -R u=rwX,go=rX "$APP_DIR/www"

log "2/5 放行 WebRTC 媒体端口（只新增，不动既有规则）"
if sudo ufw status | grep -qE "^${UDP_PORT}/udp\s+ALLOW"; then
  echo "    ufw 里已有 ${UDP_PORT}/udp"
else
  sudo ufw allow "${UDP_PORT}/udp" >/dev/null
  echo "    已新增 ufw 规则 ${UDP_PORT}/udp"
fi
if ! sudo ufw status | grep -qE "^${PUBLIC_PORT}/tcp\s+ALLOW"; then
  warn "ufw 里没有 ${PUBLIC_PORT}/tcp，对外入口会连不上"
fi
# 安全组只能从控制台改，脚本看不到；这里只做提示，真正的判定交给 e2e。
echo "    提醒：腾讯云安全组入站也要放行 ${UDP_PORT}/udp，否则观众只能走 HLS 兜底（2-4 秒）"

log "3/5 启动容器"
cd "$APP_DIR"

# 先用一次性容器校验渲染出来的 nginx 配置。
# 直接 compose up 的话，配置写错的表现是「edge 起不来 → 8443 没响应」，
# 而真正的报错埋在容器日志里；在这里拦一道，报错清楚，而且现有容器不会被碰。
if ! docker run --rm -v "$APP_DIR/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
     nginx:1.27-alpine nginx -t 2>&1; then
  die "nginx 配置有问题（见上面的 nginx -t 输出），没有动任何现有容器"
fi
echo "    nginx 配置校验通过"

if [ "$NO_RECREATE" = "1" ]; then
  # 配置和上次一模一样，只有前端产物变了 —— 静态文件是 bind mount，原地替换即时生效，
  # 重建容器纯属多余，而且会把正在推的 OBS 流打断。只在容器确实没在跑时才补一次 up。
  running=$(docker compose ps --status running -q | wc -l)
  if [ "$running" = "2" ]; then
    echo "    配置未变，容器保持不动（不打断推流）"
  else
    warn "只跑着 $running 个容器，补一次 up -d"
    docker compose up -d --remove-orphans
  fi
else
  # 必须 --force-recreate：mediamtx.yml / nginx.conf 都是 bind mount，
  # 而 MediaMTX **只在启动时读配置**、nginx 也只在启动时读挂载进来的那份。
  # 不重建容器的话新配置根本不生效（日志时间戳会出卖你）。和 frpc 是同一个坑。
  docker compose up -d --force-recreate --remove-orphans
fi

log "4/5 自检"
ok=0
for _ in $(seq 1 25); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${API_PORT}/v3/paths/list" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" != "1" ]; then
  warn "控制 API 25 秒内没起来，最近日志："
  docker compose logs --tail 40 mediamtx || true
  die "MediaMTX 没起来"
fi
echo "    控制 API 正常"

for _ in $(seq 1 15); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PUBLIC_PORT}/healthz" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" != "1" ]; then
  warn "edge 的 /healthz 没通，最近日志："
  docker compose logs --tail 40 edge || true
  die "edge 没起来"
fi
echo "    edge /healthz 正常"

if ss -lun 2>/dev/null | grep -qE ":${UDP_PORT}\b"; then
  echo "    WebRTC 媒体端口 ${UDP_PORT}/udp 正在监听"
else
  warn "没有看到 ${UDP_PORT}/udp 在监听，检查 mediamtx.yml 的 webrtcLocalUDPAddress"
fi

log "5/5 房间与容器状态"
curl -fsS --max-time 3 "http://127.0.0.1:${API_PORT}/v3/paths/list" || true
echo
docker compose ps

echo
echo "完成。对外入口 http://${PUBLIC_HOST}:${PUBLIC_PORT}/"
echo "从外部验收：node scripts/e2e.mjs（本机跑）"
