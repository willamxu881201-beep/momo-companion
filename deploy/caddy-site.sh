#!/usr/bin/env bash
# MoMo 在 Caddy 里的网站配置。这台服务器上的约定（可以和别的网站、工具共用）：
#   /etc/caddy/Caddyfile        只放全局设置和一行  import /etc/caddy/sites/*.caddy
#   /etc/caddy/sites/<名字>.caddy 每个网站各管自己的一个文件（MoMo 用 momo.caddy）
# 这个脚本只写 sites/momo.caddy。主文件只在两种情况下才动（先备份）：缺 import 那行时补上；
# 里面还留着旧版安装脚本写的 MoMo 那一段时删掉那一段（否则同一个域名出现两次）。其余内容、
# 其他网站的文件一律不碰。检查不通过就恢复原样、不重新加载，正在运行的网站不受影响。
# 用法：bash caddy-site.sh 域名 [端口，默认 8080]
# （测试用：CADDY_ETC=临时目录 CADDY_RELOAD=0）
set -euo pipefail

DOMAIN=${1:?"用法：bash caddy-site.sh 域名 [端口]"}
PORT=${2:-8080}
ETC=${CADDY_ETC:-/etc/caddy}
MAIN=$ETC/Caddyfile
SITES=$ETC/sites
OURS=$SITES/momo.caddy
IMPORT="import $SITES/*.caddy"
HERE=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$SITES"
chmod 755 "$SITES"
STASH=$(mktemp -d)
trap 'rm -rf "$STASH"' EXIT
[ -f "$MAIN" ] && cp -p "$MAIN" "$STASH/main"
[ -f "$OURS" ] && cp -p "$OURS" "$STASH/ours"

# 出错时：放回这次动过的两个文件。
restore() {
  if [ -f "$STASH/main" ]; then cp -p "$STASH/main" "$MAIN"; else rm -f "$MAIN"; fi
  if [ -f "$STASH/ours" ]; then cp -p "$STASH/ours" "$OURS"; else rm -f "$OURS"; fi
}

# 1. MoMo 自己的文件
sed -e "s/{{DOMAIN}}/$DOMAIN/g" -e "s/{{PORT}}/$PORT/g" "$HERE/momo.caddy" > "$OURS.new"
chmod 644 "$OURS.new"
mv "$OURS.new" "$OURS"

# 2. 主文件：有 import 那行，没有旧版写进去的 MoMo 那一段
IMPORT="$IMPORT" SITES="$SITES" node - "$MAIN" "$STASH/main.next" <<'JS'
const fs = require('node:fs');
const [file, out] = process.argv.slice(2);
const line = process.env.IMPORT;
const sites = process.env.SITES.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
let s = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
// What older versions of install.sh wrote here: MoMo's own site, exactly.
s = s.replace(/^[ \t]*\S+[ \t]*\{[ \t]*\r?\n[ \t]*encode gzip[ \t]*\r?\n[ \t]*reverse_proxy 127\.0\.0\.1:\d+[ \t]*\{[ \t]*\r?\n[ \t]*flush_interval -1[ \t]*\r?\n[ \t]*\}[ \t]*\r?\n[ \t]*\}[ \t]*(\r?\n|$)/gm, '');
// The Caddy package's own welcome page on :80 is nobody's site: it goes.
if (s.replace(/#.*$/gm, '').replace(/\s+/g, ' ').trim() === ':80 { root * /usr/share/caddy file_server }') s = '';
// The import line, unless it is there already (written this way or a near one).
const has = new RegExp(`^[ \\t]*import[ \\t]+(${sites}|\\.?/?sites)/\\*(\\.caddy)?[ \\t]*$`, 'm');
if (!has.test(s)) s = s.trim() ? `${s.replace(/\s*$/, '')}\n\n${line}\n` : `${line}\n`;
fs.writeFileSync(out, s);
JS
if [ -f "$STASH/main" ] && cmp -s "$STASH/main" "$STASH/main.next"; then
  echo "   $MAIN 不用改"
else
  if [ -f "$STASH/main" ]; then
    BACKUP="$MAIN.bak-momo-$(date +%Y%m%d-%H%M%S)"
    cp -p "$STASH/main" "$BACKUP"
    echo "   $MAIN 改成了约定的样子（原来的备份在 $BACKUP）"
  else
    echo "   新建了 $MAIN"
  fi
  install -m 644 "$STASH/main.next" "$MAIN.new"
  mv "$MAIN.new" "$MAIN"
fi
echo "   MoMo 的网站：$OURS"

# 3. 整份配置（连同别的网站的文件）检查通过才重新加载。检查不写任何东西（状态目录指到临时目录）。
check() { XDG_CONFIG_HOME=$STASH XDG_DATA_HOME=$STASH caddy adapt --config "$1" --adapter caddyfile > /dev/null 2> "$STASH/err"; }
if ! check "$MAIN"; then
  cp "$STASH/err" "$STASH/err.all"
  # 一个文件少了 }，Caddy 会把错算到后面的文件头上：每个文件再单独查一遍，指出是哪个。
  bad=""
  for f in "$SITES"/*.caddy; do
    [ -f "$f" ] && ! check "$f" && bad="$bad $(basename "$f")"
  done
  restore
  echo "Caddy 配置没通过检查，已恢复原样，正在运行的网站不受影响：" >&2
  sed -n -e 's/.*"level":"error".*"msg":"\(.*\)"}$/   \1/p' -e 's/^Error: /   /p' "$STASH/err.all" | tail -n 3 >&2
  if [ -n "$bad" ]; then echo "   单独检查也没通过的文件：${bad# }" >&2; fi
  exit 1
fi
if [ "${CADDY_RELOAD:-1}" = 1 ] && ! systemctl reload caddy; then
  restore
  systemctl reload caddy || true
  echo "Caddy 重新加载失败，已恢复原样：journalctl -u caddy -n 30 --no-pager" >&2
  exit 1
fi
