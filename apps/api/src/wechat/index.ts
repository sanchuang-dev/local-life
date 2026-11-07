/**
 * WeChat public-account admin configuration (#113 LL-SYS-001).
 *
 * - `crypto`: AES-256-GCM secret envelope (random 12-byte IV, 16-byte tag, AAD
 *   bound to appId+accountType, fail-closed decryption).
 * - `repository`: versioned config rows, single-active activation and the admin
 *   status summary (never exposes secret material).
 * - `runtime`: the single runtime resolution primitive reused by the admin
 *   verification API and by resident OAuth start/callback.
 * - `verify`: the real `cgi-bin/token` connection check with redacted failures.
 * - `service`: admin use cases (status/save/verify/activate) and audit writes.
 * - `routes`: the admin-only Hono routes registered from `createApp`.
 */
export * from './crypto.js'
export * from './repository.js'
export * from './runtime.js'
export * from './verify.js'
export * from './service.js'
export * from './routes.js'
