#!/usr/bin/env bash
# R2 验收环境重建脚本（从零建库 → 交互式 bootstrap-admin → 启动真实 API）。
#
# 为什么必须从零建库：Drizzle 迁移器只按 journal 里的时间戳判断迁移是否已应用，
# 不比对 SQL 文本。一个曾套用过旧版 0006 的库会静默保留过期约束（见
# docs/engineering/evidence/ll-mvp-006/migration-upgrade.md §3）。
#
# 用法：bash docs/engineering/evidence/ll-mvp-006/r2/reset-env.sh
# 环境变量：PORT(默认 4091) DB(默认 /tmp/ll-mvp-006-r2/verify.sqlite)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)"
PORT="${PORT:-4091}"
DB="${DB:-/tmp/ll-mvp-006-r2/verify.sqlite}"
PASS_FILE="${PASS_FILE:-/tmp/ll-mvp-006-r2/admin-pass.txt}"
LOG="${LOG:-/tmp/ll-mvp-006-r2/api.log}"

cd "$REPO"

echo "== 1. stop any listener on :$PORT"
for pid in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
sleep 1

echo "== 2. drop the old database (fresh build, no legacy migration state)"
rm -f "$DB" "$DB-shm" "$DB-wal"

echo "== 3. start the real API (applies 0000..0006 at startup)"
NODE_ENV=development HOST=127.0.0.1 PORT="$PORT" DATABASE_PATH="$DB" \
  AUTH_DEV_ENABLED=true SESSION_TTL_HOURS=24 \
  TRUSTED_ORIGINS="http://localhost:5241,http://127.0.0.1:5241,http://localhost:5242,http://127.0.0.1:5242" \
  WEB_BASE_URL="http://localhost:5241/local-life/" \
  nohup "$REPO/apps/api/node_modules/.bin/tsx" apps/api/src/index.ts >"$LOG" 2>&1 &
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" || true)" = "200" ]; then break; fi
  sleep 0.5
done
echo "   api=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz")"

if [ ! -s "$PASS_FILE" ]; then
  echo "== 4. no saved admin password at $PASS_FILE — refusing to invent one."
  echo "    Create it first:  openssl rand -base64 24 > $PASS_FILE && chmod 600 $PASS_FILE"
  exit 1
fi

echo "== 5. bootstrap the first admin through the repository's interactive script"
if [ "$(node -e "
const D=require('$REPO/apps/api/node_modules/better-sqlite3');
const db=new D('$DB',{readonly:true});
process.stdout.write(String(db.prepare('SELECT count(*) n FROM staff_accounts').get().n));
")" = "0" ]; then
  expect -f "$REPO/docs/engineering/evidence/ll-mvp-006/r2/bootstrap-admin.expect" \
    "$DB" r2.verify "R2 验收管理员" "$(cat "$PASS_FILE")" "$REPO" >/tmp/ll-mvp-006-r2/bootstrap.log 2>&1
  echo "   $(tail -2 /tmp/ll-mvp-006-r2/bootstrap.log | tr -d '\r' | tail -1)"
else
  echo "   staff_accounts already populated, skipping bootstrap"
fi

echo "== done: api=http://127.0.0.1:$PORT db=$DB"
