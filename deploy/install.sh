#!/usr/bin/env bash
# 在服务器上安装/更新 MoMo 伙伴（Ubuntu 24.04，用 root 运行）。
# 用法：bash /opt/momo-companion/deploy/install.sh 你的域名
#   例：bash /opt/momo-companion/deploy/install.sh 101-47-157-111.sslip.io
# 可以重复运行：已经填好的密码和 Key 不会被覆盖。
set -euo pipefail

DOMAIN="${1:-}"
APP_DIR=/opt/momo-companion
DATA_DIR=/var/lib/momo
ENV_DIR=/etc/momo
ENV_FILE=$ENV_DIR/momo.env

if [ -z "$DOMAIN" ]; then
  echo "请在命令后面写上域名，例如：bash $APP_DIR/deploy/install.sh 101-47-157-111.sslip.io" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/server/index.js" ]; then
  echo "没找到代码，请先把仓库拉到 $APP_DIR" >&2
  exit 1
fi

node_ok=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);console.log(a>22||(a===22&&b>=13)?1:0)' 2>/dev/null || echo 0)
if [ "$node_ok" != "1" ]; then
  echo "需要 Node.js 22.13 或更新的版本，请先按 README 第 1 步安装" >&2
  exit 1
fi
if ! command -v caddy >/dev/null; then
  echo "没找到 Caddy，请先按 README 第 1 步安装" >&2
  exit 1
fi

echo "== 1/5 创建运行账号和数据目录"
id momo >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin momo
mkdir -p "$DATA_DIR" "$ENV_DIR"
chown momo:momo "$DATA_DIR"
chmod 700 "$DATA_DIR"
# 读 PDF（比如课程表文件）要用 poppler 的 pdftoppm；拍照和截图用不到它。
if ! command -v pdftoppm >/dev/null; then
  echo "   安装 poppler-utils（读 PDF 用）"
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq poppler-utils >/dev/null 2>&1 || { apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq poppler-utils >/dev/null 2>&1; } ||
    echo "   没装上 poppler-utils：发 PDF 会读不了，拍照和截图不受影响"
fi

echo "== 2/5 配置文件 $ENV_FILE"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# MoMo 伙伴的配置。改完后运行：systemctl restart momo
PORT=8080
DATA_DIR=$DATA_DIR
MOMO_TZ=Asia/Kuala_Lumpur
PUBLIC_URL=https://$DOMAIN

# ---- 下面这几项请你自己填 ----
# 家长后台的登录密码（自己想一个，至少 8 位）
PARENT_PASSWORD=
# 火山方舟的 API Key（ark- 开头）
ARK_API_KEY=
# 豆包语音 2.0 的 APP ID 和 Access Token（不填就用平板自带的声音）
DOUBAO_APPID=
DOUBAO_TOKEN=
EOF
  echo "   已创建。请填写密码和 Key：nano $ENV_FILE"
else
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" "$ENV_FILE"
  echo "   已存在，保留你填过的内容（只更新了域名）"
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "== 3/5 网络设置（BBR：到北京的线路会丢包，语音上传快很多）"
echo tcp_bbr > /etc/modules-load.d/momo-bbr.conf
modprobe tcp_bbr 2>/dev/null || true
install -m 644 "$APP_DIR/deploy/sysctl-momo.conf" /etc/sysctl.d/90-momo.conf
sysctl -q -p /etc/sysctl.d/90-momo.conf || echo "   没能打开 BBR，不影响使用，只是语音识别会慢一些"

echo "== 4/5 后台服务"
install -m 644 "$APP_DIR/deploy/momo.service" /etc/systemd/system/momo.service
systemctl daemon-reload
systemctl enable momo >/dev/null
systemctl restart momo

echo "== 5/5 网页和 HTTPS 证书（Caddy）"
sed "s/{{DOMAIN}}/$DOMAIN/g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy

sleep 2
if curl -fsS http://127.0.0.1:8080/healthz >/dev/null; then
  echo
  echo "装好了。"
  echo "家长后台：https://$DOMAIN/parent"
  if grep -qE '^(PARENT_PASSWORD|ARK_API_KEY)=$' "$ENV_FILE"; then
    echo "还差一步：nano $ENV_FILE 填好密码和 Key，再运行 systemctl restart momo"
  fi
else
  echo "服务没有起来，看看日志：journalctl -u momo -n 50 --no-pager" >&2
  exit 1
fi
