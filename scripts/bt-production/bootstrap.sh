#!/usr/bin/env bash
# First-run only: unpack a reviewed release, initialize a fresh SQLite database.
# Does not modify existing BT websites, Nginx or other applications.
set -euo pipefail
[[ "$EUID" = 0 ]] || { echo 'Requires root on target BT server' >&2; exit 1; }
sha="${1:?usage: bootstrap.sh <source-sha>}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 1
base=/www/local-life
incoming="$base/incoming/$sha"
release="$base/releases/$sha"
db="$base/shared/data/local-life.sqlite"
config="$base/shared/config/api.env"
key="$base/shared/config/wechat-master-key.b64"
node=/www/server/nodejs/v24.22.1/bin/node
test -d "$incoming" && test -x "$node"
test ! -e "$base/current" && test ! -e "$db" && test ! -e "$release" || { echo 'Existing deployment/data: refusing first-run bootstrap' >&2; exit 1; }
cd "$incoming"
test "$(cat SOURCE_SHA)" = "$sha"
sha256sum -c SHA256SUMS
tmp="$base/releases/.extract-$sha"
test ! -e "$tmp"
install -d -m 0755 "$tmp"/{web,admin,api}
trap 'test ! -d "$tmp" || rm -rf -- "$tmp"' EXIT
for name in web admin api; do
  tar -xzf "$incoming/$name.tar.gz" -C "$tmp/$name" --no-same-owner --no-same-permissions
done
test -s "$tmp/web/index.html" && test -s "$tmp/admin/index.html"
test -s "$tmp/api/dist/index.js" && test -d "$tmp/api/db/migrations"
test -d "$tmp/api/node_modules/better-sqlite3"
test -s "$tmp/api/verify-db.mjs"
chown -R www:www "$tmp"
chmod -R u=rwX,g=rX,o= "$tmp"
install -d -m 0750 -o www -g www "$base/shared/data"
install -d -m 0750 -o root -g www "$base/shared/config"
install -d -m 0700 -o root -g root "$base/backups"
if test ! -e "$key"; then
  umask 077
  openssl rand -base64 32 > "$key"
  chown root:www "$key"
  chmod 0440 "$key"
fi
if test ! -e "$config"; then
  umask 077
  cat > "$config" <<'ENV'
NODE_ENV=production
HOST=127.0.0.1
PORT=18081
DATABASE_PATH=/www/local-life/shared/data/local-life.sqlite
WEB_BASE_URL=https://local-life.3cgroup.cn/
TRUSTED_ORIGINS=https://local-life.3cgroup.cn,https://local-admin.3cgroup.cn
AUTH_DEV_ENABLED=false
WECHAT_CONFIG_MASTER_KEY_FILE=/www/local-life/shared/config/wechat-master-key.b64
ENV
  chown root:www "$config"
  chmod 0440 "$config"
fi
ln -s "$config" "$tmp/api/.env"
mv "$tmp" "$release"
trap - EXIT
# Incoming archives are root-only (0700); www must run from its accessible release cwd.
cd "$release/api"
runuser -u www -- "$node" -e 'const D=require(process.argv[1]); const x=new D(":memory:"); x.close()' "$release/api/node_modules/better-sqlite3"
runuser -u www -- env DATABASE_PATH="$db" bash -c '
set -euo pipefail
cd "$1"
"$2" --input-type=module -e '\''
  import { createDatabase } from "./dist/db/client.js";
  const { sqlite } = createDatabase(process.env.DATABASE_PATH, "./db/migrations");
  if (sqlite.pragma("quick_check", { simple: true }) !== "ok") process.exit(1);
  sqlite.close();
'\''' _ "$release/api" "$node"
runuser -u www -- "$node" "$release/api/verify-db.mjs" verify "$db"
# SQLite Online Backup API, no dependency on sqlite3 shell utility.
# A temporary www-writable snapshot is immediately copied into root-owned backups.
tmpbackup="$base/shared/data/.initial-$sha.sqlite"
test ! -e "$tmpbackup" || { echo 'Refusing to overwrite existing temporary snapshot' >&2; exit 1; }
trap 'rm -f -- "$tmpbackup"' EXIT
runuser -u www -- "$node" "$release/api/verify-db.mjs" backup "$db" "$tmpbackup"
test ! -e "$base/backups/initial-$sha.sqlite"
install -m 0600 -o root -g root "$tmpbackup" "$base/backups/initial-$sha.sqlite"
rm -f -- "$tmpbackup"
trap - EXIT
ln -s "$release" "$base/current"
printf 'BT_DATABASE_INITIALIZED_SHA=%s\n' "$sha"
