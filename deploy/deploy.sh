#!/usr/bin/env bash
# 一键部署/重装到 Linux 服务器（Docker 版 SnowLuma）
# 用法：在项目目录（Git Bash）执行：
#   bash deploy/deploy.sh <用户@服务器IP> [SSH端口]
# 例：bash deploy/deploy.sh your-server
# 可选环境变量 SNOW_LOCAL：本机 SnowLuma 安装目录，默认 /d/SnowLuma-win-x64，按本机实际路径设置
# 首次运行需要交互输入 SSH 密码；配好免密后全程无人值守。
set -euo pipefail

DEST=${1:?用法: bash deploy/deploy.sh user@host [port]}
PORT=${2:-22}
SSHOPT=(-o StrictHostKeyChecking=accept-new -p "$PORT")
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_BOT=/opt/qq-group-bot
SNOW_DOCKER=/opt/snowluma-docker
SNOW_LEGACY=/opt/snowluma
VNC_PW=$(openssl rand -hex 5)   # noVNC 扫码桌面密码，脚本结束时会打印

step() { echo ""; echo "==== $* ===="; }

step "0/6 预检"
ssh "${SSHOPT[@]}" "$DEST" "echo SSH连接OK && uname -m && head -1 /etc/os-release 2>/dev/null || true"
[ -f "$PROJ/config.yaml" ] || { echo "缺少 config.yaml"; exit 1; }
[ -f "$PROJ/.env" ] || { echo "缺少 .env"; exit 1; }

step "1/6 上传机器人工程"
tar czf /tmp/qqbot-code.tgz -C "$PROJ" src scripts assets package.json package-lock.json tsconfig.json persona.md config.example.yaml README.md
scp -P "$PORT" /tmp/qqbot-code.tgz "$DEST:/tmp/"

step "2/6 上传配置、密钥与机器人数据"
ssh "${SSHOPT[@]}" "$DEST" "mkdir -p $REMOTE_BOT $SNOW_DOCKER"
scp -P "$PORT" "$PROJ/config.yaml" "$PROJ/.env" "$DEST:$REMOTE_BOT/"
if [ -f "$PROJ/data/bot.db" ]; then
  tar czf /tmp/qqbot-data.tgz -C "$PROJ" data
  scp -P "$PORT" /tmp/qqbot-data.tgz "$DEST:/tmp/"
  echo "（含本地消息库/记忆/日报）"
fi

step "3/6 上传 SnowLuma 旧配置（迁移 OneBot token 等）"
SNOW_LOCAL=${SNOW_LOCAL:-/d/SnowLuma-win-x64}   # 本机 SnowLuma 安装路径；默认 /d/SnowLuma-win-x64，按本机实际路径用 SNOW_LOCAL=... 覆盖
if [ -d "$SNOW_LOCAL" ]; then
  STAGE=$(mktemp -d)
  mkdir -p "$STAGE/config"
  cp "$SNOW_LOCAL"/config/*.json "$STAGE/config/" 2>/dev/null || true
  node -e '
    const fs = require("fs");
    const dir = process.argv[1];
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith("onebot_")) continue;
      const p = dir + "/" + f;
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      j.networks.wsClients = [];  // 清掉遗留的反向 WS 客户端
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    }
  ' "$STAGE/config"
  tar czf /tmp/snowluma-state.tgz -C "$STAGE" config
  scp -P "$PORT" /tmp/snowluma-state.tgz "$DEST:/tmp/"
  if [ -d "$SNOW_LOCAL/data" ]; then
    tar czf /tmp/snowluma-data.tgz -C "$SNOW_LOCAL" data
    scp -P "$PORT" /tmp/snowluma-data.tgz "$DEST:/tmp/"
  fi
  rm -rf "$STAGE"
fi

step "4/6 服务器端安装（Docker、机器人依赖、官方 SnowLuma 容器）"
ssh "${SSHOPT[@]}" "$DEST" VNC_PW=$VNC_PW REMOTE_BOT=$REMOTE_BOT 'bash -s' <<'REMOTE_SCRIPT'
set -euo pipefail

# --- Docker（官方镜像要求；与 K3s 可共存）---
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# --- Node >= 22（机器人本体不用容器，直接跑）---
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  [ "$major" -ge 22 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  else
    echo "!! 请手动安装 Node>=22 后重跑"; exit 1
  fi
fi
NODE_BIN=$(command -v node)

# --- 机器人 ---
cd "$REMOTE_BOT"
tar xzf /tmp/qqbot-code.tgz -C "$REMOTE_BOT"
[ -f /tmp/qqbot-data.tgz ] && tar xzf /tmp/qqbot-data.tgz -C "$REMOTE_BOT"
npm install --no-audit --no-fund || npm install --no-audit --no-fund --registry=https://registry.npmmirror.com

# --- 旧版 tarball 安装清理（如有）---
systemctl disable --now snowluma 2>/dev/null || true
rm -f /etc/systemd/system/snowluma.service; systemctl daemon-reload

# --- SnowLuma 官方容器（QQ+Xvfb+noVNC 全内置）---
mkdir -p "$SNOW_DOCKER/data" "$SNOW_DOCKER/client-config" "$SNOW_DOCKER/client-data"
[ -f /tmp/snowluma-state.tgz ] && tar xzf /tmp/snowluma-state.tgz -C "$SNOW_DOCKER/data"
[ -f /tmp/snowluma-data.tgz ] && mkdir -p "$SNOW_DOCKER/data/data" && tar xzf /tmp/snowluma-data.tgz -C "$SNOW_DOCKER/data/data"
docker rm -f snowluma 2>/dev/null || true
docker run -d --name snowluma --restart unless-stopped \
  --shm-size=1g --ulimit nofile=65536:1048576 \
  --cap-add=SYS_PTRACE --security-opt seccomp=unconfined \
  -e VNC_PASSWD="$VNC_PW" -e SNOWLUMA_HOOK_AUTOLOAD=1 -e SNOWLUMA_WEBUI_HOST=0.0.0.0 \
  -p 127.0.0.1:6081:6081 -p 127.0.0.1:5099:5099 \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 \
  -v "$SNOW_DOCKER/data:/app/data" \
  -v "$SNOW_DOCKER/client-config:/app/.config" \
  -v "$SNOW_DOCKER/client-data:/app/.local/share" \
  motricseven7/snowluma:latest
echo "[server] SnowLuma 容器已启动（noVNC 密码: $VNC_PW）"

# --- 机器人 systemd ---
cat > /etc/systemd/system/qq-group-bot.service <<EOF
[Unit]
Description=QQ group bot (OneBot gateway + memory + reports)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_BOT
ExecStart=$NODE_BIN --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs src/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
echo "[server] 安装完成"
REMOTE_SCRIPT

step "5/6 启动机器人"
ssh "${SSHOPT[@]}" "$DEST" "systemctl enable --now qq-group-bot && sleep 6 && systemctl --no-pager -n 5 status qq-group-bot | head -10 || true"

step "6/6 完成 —— 你要做的"
cat <<NOTES
VNC 扫码密码: $VNC_PW   （已设为环境变量，重装不会变）
1. 停掉本机的 SnowLuma 和机器人（同一 QQ 只能一处在线）！
2. 首次登录：浏览器打开远程桌面扫码——
     ssh -N -L 6081:127.0.0.1:6081 -L 5099:127.0.0.1:5099 $DEST
     本机打开 http://127.0.0.1:6081 输 VNC 密码 → QQ 窗口里扫码
3. 验证：ssh $DEST "journalctl -u qq-group-bot -n 5"   出现「QQ 已登录」即上线
4. 机器人面板：隧道 -L 8642:127.0.0.1:8642 后开 http://127.0.0.1:8642
NOTES
