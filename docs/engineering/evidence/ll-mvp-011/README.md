# LL-MVP-011 — resident WeChat profile consent evidence

This evidence covers the optional, resident-initiated synchronization of WeChat nickname and avatar. It does not change the existing `snsapi_base` login purpose.

## Evidence boundary

- `wechat-profile-network-e2e.test.ts` starts the production Hono app on a real TCP listener with a real SQLite database and applies the repository migrations. Only the remote WeChat HTTP boundary is replaced with deterministic provider responses. The test exercises the real OAuth state, cookies, callback, identity lookup, persistence, and API responses.
- `browser-verify.mjs` drives the real H5 and API in Chrome using an iPhone WeChat user agent. The resident clicks the visible consent button; the resulting `open.weixin.qq.com` request is intercepted before network access. No real WeChat authorization is attempted.
- Browser display fixtures use a local development resident, a test nickname, and the site's `favicon.svg` as an image URL. They are not real resident or WeChat profile data.
- Real WeChat authorization on a WeChat client remains a separate acceptance step because this repository run has no real official-account credentials or authorization account.

## Results

- Real HTTP + SQLite: default login requests `snsapi_base` and never calls `sns/userinfo`; passive profile status also never calls it.
- Explicit consent: the browser click requests `snsapi_userinfo`; OAuth state records `purpose=profile`, the logged-in user, and the initiating WeChat config version.
- Callback: only an already-bound OpenID belonging to the initiating user can update the existing identity row. A different user's OpenID, an unbound OpenID, a mismatched `sns/userinfo` OpenID, or a provider error cannot write profile data.
- Persistence: nickname, avatar URL, and authorization time are saved on the existing `wechat_identities` row. The platform `users.display_name` remains unchanged. No sex, province, city, country, or location columns are introduced.
- Safety: cancellation, session switching, expired state, replay, and nonce/state failures do not create or merge identities; cancellation leaves the existing session and saved profile intact. API responses and database contents do not expose or persist access tokens or AppSecrets.
- Browser: 17 checks passed at 375px and 320px CSS viewports. The 320px page has no horizontal overflow. The cancellation result is displayed and its one-off query marker is removed while the resident remains logged in.

## Screenshots

- `01-profile-consent-375.png` — explicit consent before authorization.
- `02-profile-authorized-375.png` — persisted nickname and avatar URL displayed; platform display name remains separate.
- `03-profile-authorized-320.png` — narrow viewport, no horizontal overflow.
- `04-profile-cancelled-375.png` — cancellation feedback with the existing session still active.
- `browser-results.json` — machine-readable browser assertions.

The screenshot avatar is a local brand-mark fixture used only to verify that the H5 renders a persisted avatar URL. The HTTP + SQLite test separately verifies persistence of the provider-shaped WeChat avatar URL.

## Repository verification

- `pnpm lint`: passed with 0 errors and 38 warnings.
- `pnpm typecheck`: passed.
- `drizzle-kit check`: passed; migration journal and snapshots are consistent.
- `pnpm build`: passed for contracts, API, H5 and Admin. Vite emitted bundle-size warnings for the existing large H5/Admin bundles.
- `pnpm check`: lint, typecheck and the 192-test Admin suite passed. The API suite reported 353 passed / 1 failed: unchanged `apps/api/test/ledger-reconciliation-service.test.ts:1007` expected 3 reconciliation rows but observed 4. This is outside the files changed by LL-MVP-011; it was not modified as part of this task.
- Targeted OAuth return, migration and profile-consent tests passed; the final profile HTTP + SQLite test passed again after the last assertion was added.

## Reproduction (macOS example)

Run from the repository root after `pnpm install --frozen-lockfile`. Use a disposable database and a newly generated test-only key; never use production credentials.

```sh
mkdir -p .data
export DATABASE_PATH="$PWD/.data/ll-mvp-011-browser.sqlite"
export LL_EVIDENCE_DATABASE="$DATABASE_PATH"
export WECHAT_CONFIG_MASTER_KEY="$(openssl rand -base64 32 | tr -d '\n')"
export WECHAT_CONFIG_KEY_ID=ll-mvp-011-evidence
export NODE_ENV=development
export HOST=127.0.0.1
export PORT=4181
export WEB_BASE_URL=http://127.0.0.1:5181/
export TRUSTED_ORIGINS=http://127.0.0.1:5181,http://localhost:5181
export AUTH_DEV_ENABLED=true
export LOCAL_LIFE_API_PORT=4181
export LOCAL_LIFE_WEB_PORT=5181
export LOCAL_LIFE_ADMIN_PORT=5182

# Seed a fake, encrypted official-account provider and disposable activities.
apps/api/node_modules/.bin/tsx docs/engineering/evidence/ll-mvp-012/seed-browser-db.ts
```

In separate terminals, with the same environment:

```sh
pnpm --dir apps/api exec tsx src/index.ts
```

```sh
pnpm --dir apps/web exec vite --host 127.0.0.1 --port 5181 --strictPort --base /
```

Then run the browser evidence. Set `CHROME_PATH` if Chrome is installed elsewhere. `NO_PROXY` keeps the local API and DevTools traffic off any configured HTTP proxy.

```sh
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  node docs/engineering/evidence/ll-mvp-011/browser-verify.mjs
```
