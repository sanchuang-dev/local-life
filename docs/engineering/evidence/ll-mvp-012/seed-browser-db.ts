/**
 * Seed the disposable browser-verification database for LL-MVP-012 (#123).
 *
 * Run with the API's tsx from the repository root:
 *
 *   WECHAT_CONFIG_MASTER_KEY=<base64 of 32 random bytes> \
 *     apps/api/node_modules/.bin/tsx docs/engineering/evidence/ll-mvp-012/seed-browser-db.ts
 *
 * It creates the communities and the published / paused / draft activities used by
 * `browser-verify.mjs`, plus an active WeChat provider row so `/auth/methods`
 * reports `wechat: true` and the login card renders a real button. The provider is
 * encrypted with the same master key the API process receives; the AppID/secret
 * below are obvious fakes and are never sent to WeChat, because the harness stops
 * at the authorize redirect and never completes a real authorization.
 *
 * Everything here uses production code paths (`createDatabase`,
 * `encryptWechatSecret`, the repository transitions) — no test fixture is imported.
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../../../../apps/api/src/config.js'
import { createDatabase } from '../../../../apps/api/src/db/client.js'
import { activities, communities, users } from '../../../../apps/api/src/db/schema.js'
import { encryptWechatSecret } from '../../../../apps/api/src/wechat/crypto.js'
import {
  activateWechatConfig,
  markWechatConfigVerified,
  saveWechatConfigCandidate,
} from '../../../../apps/api/src/wechat/repository.js'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const DATABASE_PATH = process.env.LL_EVIDENCE_DATABASE ?? join(REPO_ROOT, '.data', 'll-mvp-012-browser.sqlite')
const MIGRATIONS = join(REPO_ROOT, 'apps', 'api', 'db', 'migrations')

const APP_ID = 'wx1234567890abcdef'
const APP_SECRET = 'evidence-only-wechat-secret-0123456789'

const PUBLIC_RULES_JSON = JSON.stringify({
  eligibility: '本社区 60 岁以上居民',
  checkin: '到社区服务中心签到并领取参与卡',
  purchase: '现场购买指定套餐一份',
  prizeClaim: '凭核销码领取，每人限一次',
  notes: '活动最终解释权归社区所有',
})

const now = new Date()
const config = loadConfig(process.env)
if (!config.wechatConfigMasterKey) {
  throw new Error('WECHAT_CONFIG_MASTER_KEY must be set for the seeded provider to be decryptable')
}
const masterKey = { key: config.wechatConfigMasterKey.key, keyId: config.wechatConfigMasterKey.keyId }

const { db, sqlite } = createDatabase(DATABASE_PATH, MIGRATIONS)

function addActivity(options: {
  id: string
  communityId: string
  title: string
  status: 'published' | 'paused' | 'draft'
  createdByUserId: string
}): void {
  db.insert(activities)
    .values({
      id: options.id,
      communityId: options.communityId,
      title: options.title,
      summary: '秋季社区敬老活动',
      description: '面向本社区 60 岁以上居民的线下活动',
      status: options.status,
      startsAt: new Date(now.getTime() - 60 * 60 * 1000),
      endsAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      location: '幸福社区党群服务中心',
      budgetCapCents: 100_000,
      prizeQuantityCap: 100,
      publicRulesJson: PUBLIC_RULES_JSON,
      currentRuleVersionId: null,
      createdByUserId: options.createdByUserId,
      createdAt: now,
      updatedAt: now,
      publishedAt: options.status === 'draft' ? null : now,
      pausedAt: options.status === 'paused' ? now : null,
      endedAt: null,
    })
    .run()
}

try {
  const creatorId = randomUUID()
  db.insert(users)
    .values({ id: creatorId, displayName: '活动运营', createdAt: now, updatedAt: now })
    .run()

  const communityId = randomUUID()
  db.insert(communities).values({ id: communityId, name: '幸福社区', createdAt: now }).run()
  const otherCommunityId = randomUUID()
  db.insert(communities).values({ id: otherCommunityId, name: '阳光社区', createdAt: now }).run()

  const publishedActivityId = randomUUID()
  addActivity({ id: publishedActivityId, communityId, title: '银发社区欢乐季', status: 'published', createdByUserId: creatorId })
  const pausedActivityId = randomUUID()
  addActivity({ id: pausedActivityId, communityId: otherCommunityId, title: '阳光社区暂停活动', status: 'paused', createdByUserId: creatorId })
  const draftActivityId = randomUUID()
  addActivity({ id: draftActivityId, communityId, title: '尚未发布的活动', status: 'draft', createdByUserId: creatorId })

  const encrypted = encryptWechatSecret(APP_SECRET, { appId: APP_ID, accountType: 'official' }, masterKey)
  const saved = saveWechatConfigCandidate(db, {
    appId: APP_ID,
    accountType: 'official',
    encrypted,
    createdByUserId: null,
  })
  const verified = markWechatConfigVerified(db, saved.id)
  const active = activateWechatConfig(db, verified.id).active

  console.log(
    JSON.stringify(
      {
        database: DATABASE_PATH,
        communityId,
        otherCommunityId,
        publishedActivityId,
        pausedActivityId,
        draftActivityId,
        wechatConfigId: active.id,
        wechatConfigStatus: active.status,
        appId: APP_ID,
        masterKeyId: masterKey.keyId,
      },
      null,
      2,
    ),
  )
} finally {
  sqlite.close()
}
