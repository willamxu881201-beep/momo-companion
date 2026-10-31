#!/usr/bin/env bash
# Runs one browser check against a throwaway local server: a fresh database (seed.mjs),
# a random parent password, no keys, and pushes to Mom's phone going to the check.
#   tools/browser/run.sh devices      the kid screen on 11 screen sizes
#   tools/browser/run.sh mom          Mom's page: chat, look-ins, pushes while it is closed
#   tools/browser/run.sh voice        the streamed voice: seams, timing, the autoplay rule
#   tools/browser/run.sh scenes       every place by day and night; a task comes due and she speaks up
#   tools/browser/run.sh files        MoMo's files: what Mom sent her (new, told, played) and her own
#   tools/browser/run.sh listen       连续对话: she listens on after answering; stops when nobody talks, after five turns, or when turned off
#   tools/browser/run.sh docs --real  documents read and asked about, with the real models
#   tools/browser/run.sh e2e --real   everything with the real models (needs ARK_API_KEY)
# Screenshots and the server's log go to tools/browser/out/<check>/.
# Needs Playwright's Chromium: npm install --no-save playwright && npx playwright install chromium
set -euo pipefail

CHECK=${1:?"which check: devices, mom, voice, scenes, files, docs or e2e"}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
PORT=${PORT:-8091}
OUT="$HERE/out/$CHECK"
DATA=$(mktemp -d)
SP=
trap 'if [ -n "$SP" ]; then kill "$SP" 2>/dev/null || true; fi; rm -rf "$DATA"' EXIT

rm -rf "$OUT" && mkdir -p "$OUT"
export MOMO_TZ=${MOMO_TZ:-Asia/Kuala_Lumpur}
node --disable-warning=ExperimentalWarning "$HERE/seed.mjs" "$DATA/momo.db"
CHECK_PW=$(node -e "console.log(require('crypto').randomBytes(12).toString('hex'))")
export CHECK_PW CHECK_BASE="http://127.0.0.1:$PORT" CHECK_PUSH_PORT=$((PORT + 1))

# Without --real the server has no keys: the models fail fast and the browser's own
# voice (stubbed by the checks) speaks. With it, only the voice keys are left out.
UNSET=(-u ARK_API_KEY -u DOUBAO_APPID -u DOUBAO_TOKEN)
if [ "${2:-}" = "--real" ]; then
  [ -n "${ARK_API_KEY:-}" ] || { echo "--real needs ARK_API_KEY in the environment" >&2; exit 1; }
  UNSET=(-u DOUBAO_APPID -u DOUBAO_TOKEN)
fi
env "${UNSET[@]}" PORT="$PORT" HOST=127.0.0.1 DATA_DIR="$DATA" PARENT_PASSWORD="$CHECK_PW" PUBLIC_URL="$CHECK_BASE" \
  NOTIFY_URL="http://127.0.0.1:$CHECK_PUSH_PORT/push" \
  node --disable-warning=ExperimentalWarning "$ROOT/server/index.js" > "$OUT/server.log" 2>&1 &
SP=$!
for _ in $(seq 1 50); do
  curl -sf "$CHECK_BASE/healthz" > /dev/null && break
  sleep 0.2
done

node "$HERE/$CHECK.cjs" "$OUT"
