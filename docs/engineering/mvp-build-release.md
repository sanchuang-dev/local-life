# Local Life MVP · independent build and release contract

The authoritative environment decision is [mvp-online-preview.md](mvp-online-preview.md).
This document describes **artifacts**, not a successful host deployment.

## Build contract

Source: a reviewed commit on `local-life@mvp` (promoted from `dev` through PR). Use Node 22 and pnpm 10.19.0:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --filter @sanchuang-dev/local-life-web build:mvp
pnpm --filter @sanchuang-dev/local-life-admin build:mvp
node scripts/mvp/verify-build.mjs
docker build -f apps/api/Dockerfile -t local-life-api:<sha> .
```

- `apps/web/dist`: static resident site at `https://local.proto.3cgroup.cn/`, Vite base `/`.
- `apps/admin/dist`: static admin site at `https://local-admin.proto.3cgroup.cn/`, Vite base `/`.
- Docker image: **one** Node 22/Hono service, runs `node dist/index.js`, includes workspace contracts, native SQLite binding and the migrations journal. Build with Debian Linux/amd64 to match the inspected server.
- Existing Pages `dev` (/local-life/) and `prod` (/local-life/prod/) builds and workflows are not changed.

## Runtime boundary

Production Hono environment (the host owns its private env file, which is **not** checked in):

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=4080
DATABASE_PATH=/data/local-life.sqlite
WEB_BASE_URL=https://local.proto.3cgroup.cn/
TRUSTED_ORIGINS=https://local.proto.3cgroup.cn,https://local-admin.proto.3cgroup.cn
AUTH_DEV_ENABLED=false
```

Do not set `COOKIE_DOMAIN`. Absence of WeChat or CRMEB credentials must keep those integrations unavailable, not simulate success. Never put production passwords, SQLite data or OAuth secrets in GitHub artifacts or the repository.

The host's reviewed Caddy routes (owned by `sanchuang-dev/proto-infra`) have **two independent** root directories, strip `/api` and proxy both to a private loopback port `127.0.0.1:18081` bound by the container. API process port in the container is 4080.

The SQLite file lives outside immutable release directories under `/srv/proto/local-life-mvp/data/` with separate restricted backups. The application sets WAL and migrates at startup. Before each schema-changing release use SQLite's online `.backup`, verify its `PRAGMA quick_check`, and test a migrated **copy** before promoting the new version. Do not copy only the active main SQLite file when WAL is enabled.

The release gate must stop the old writer before launching the new writer, smoke check both site origins and `/api/healthz`, verify old site health, and only then record live SHA. If a migration is not backwards compatible, do not silently restore an older DB backup or start an incompatible former API; leave it stopped and escalate.

## Deployment responsibility

- `local-life` owns builds, API image, persistent schema and `dev → mvp` promotion.
- `proto-infra` owns trusted SSH access to the shared host, bounded Caddy ingress and the host publisher.
- No `PROTO_*` SSH secret is copied from infra to the application repository.
- The first online release is not proof that public WeChat OAuth, CRMEB sales, rewards or accounting are usable. Those need their own real E2E checks.

## Post-release evidence

Record exact `mvp` SHA, CI run, image digest, HTTPS codes from both hostnames, actual API health response, migration journal version, database backup/restore check, server restart persistence and compatibility with the old static `local-life.proto.3cgroup.cn` site. If any of those are not checked, say so.
