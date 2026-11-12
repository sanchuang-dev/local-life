import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
  API_ERROR_CODES,
  crmebIdentityBindResponseSchema,
  crmebIdentityRevokeResponseSchema,
  crmebIdentityStatusResponseSchema,
  crmebPurchaseLinkResponseSchema,
} from '@sanchuang-dev/local-life-contracts'
import {
  ADMIN_PASSWORD,
  GRID_PASSWORD,
  OPERATOR_PASSWORD,
  api,
  createCommunity,
  createDraftActivity,
  createPublishedActivity,
  createStaffAccount,
  createTestContext,
  csrf,
  errorEnvelope,
  residentSession,
  seedAdmin,
  staffSession,
} from './crmeb-test-helpers.js'
import {
  auditLogs,
  crmebClickAttributions,
  crmebIdentities,
} from '../src/db/schema.js'
import { startSimulatedCrmeb } from './crmeb-simulated-server.js'
import { SIMULATED_PRODUCTS } from './crmeb-fixtures.js'

async function configuredContext() {
  const simulated = await startSimulatedCrmeb({ products: SIMULATED_PRODUCTS })
  const context = createTestContext({ crmeb: { baseUrl: simulated.baseUrl } })
  return { simulated, context }
}

test('identity mapping is writable only by an audited admin staff session', async () => {
  const { simulated, context } = await configuredContext()
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '身份映射社区')
    await createStaffAccount(app, admin, {
      username: 'operator1',
      displayName: '运营员',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityId],
    })
    const operator = await staffSession(app, 'operator1', OPERATOR_PASSWORD)
    const resident = await residentSession(app, '待绑定居民', communityId)

    const path = '/admin/integrations/crmeb/identities'
    const unauthenticated = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(unauthenticated.status, 401)

    const operatorAttempt = await api(app, 'POST', path, {
      session: operator,
      body: {
        platformUserId: resident.userId,
        crmebUid: 5001,
        verificationMethod: 'manual_verified',
      },
    })
    assert.equal(operatorAttempt.status, 403)
    assert.equal(
      (await errorEnvelope(operatorAttempt)).error.code,
      API_ERROR_CODES.forbidden,
    )

    // A resident session cannot reach the admin binding endpoint at all.
    const residentAttempt = await api(app, 'POST', path, {
      session: resident,
      body: {
        platformUserId: resident.userId,
        crmebUid: 5001,
        verificationMethod: 'manual_verified',
      },
    })
    assert.equal(residentAttempt.status, 401)

    const noCsrf = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: admin.cookies,
      },
      body: JSON.stringify({
        platformUserId: resident.userId,
        crmebUid: 5001,
        verificationMethod: 'manual_verified',
      }),
    })
    assert.equal(noCsrf.status, 403)
    assert.equal((await errorEnvelope(noCsrf)).error.code, API_ERROR_CODES.forbidden)

    const forgedFields = await api(app, 'POST', path, {
      session: admin,
      body: {
        platformUserId: resident.userId,
        crmebUid: 5001,
        verificationMethod: 'manual_verified',
        confirmed: true,
      },
    })
    assert.equal(forgedFields.status, 400)
    assert.equal(
      (await errorEnvelope(forgedFields)).error.code,
      API_ERROR_CODES.invalidRequest,
    )

    assert.equal(db.select().from(crmebClickAttributions).all().length, 0)

    const before = await api(app, 'GET', '/integrations/crmeb/identity/me', {
      session: resident,
    })
    assert.equal(before.status, 200)
    assert.deepEqual(await before.json(), { linked: false })

    const bound = await api(app, 'POST', path, {
      session: admin,
      body: {
        platformUserId: resident.userId,
        crmebUid: 5001,
        verificationMethod: 'manual_verified',
        note: '电话人工核对',
      },
    })
    assert.equal(bound.status, 201)
    const binding = crmebIdentityBindResponseSchema.parse(await bound.json())
    assert.equal(binding.identity.crmebUid, 5001)
    assert.equal(binding.identity.platformUserId, resident.userId)
    assert.equal(binding.identity.status, 'active')
    assert.equal(binding.identity.verificationMethod, 'manual_verified')

    const audit = db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, 'crmeb.identity.bound'))
      .all()
    assert.equal(audit.length, 1)
    assert.equal(audit[0]?.targetId, resident.userId)
    assert.deepEqual(JSON.parse(audit[0]?.metadata ?? '{}'), {
      crmebUid: '5001',
      verificationMethod: 'manual_verified',
    })

    const after = await api(app, 'GET', '/integrations/crmeb/identity/me', {
      session: resident,
    })
    assert.equal(after.status, 200)
    const afterText = await after.text()
    assert.ok(!afterText.includes('电话人工核对'), 'admin notes must not leak to residents')
    assert.ok(!afterText.includes('5001'), 'residents must not receive their CRMEB uid')
    const status = crmebIdentityStatusResponseSchema.parse(JSON.parse(afterText))
    assert.equal(status.linked, true)
    assert.equal(status.identity?.status, 'active')
    assert.equal(status.identity?.verificationMethod, 'manual_verified')
    assert.ok(status.identity && !('crmebUid' in status.identity))

    const duplicatePlatform = await api(app, 'POST', path, {
      session: admin,
      body: {
        platformUserId: resident.userId,
        crmebUid: 5002,
        verificationMethod: 'manual_verified',
      },
    })
    assert.equal(duplicatePlatform.status, 409)
    assert.equal(
      (await errorEnvelope(duplicatePlatform)).error.code,
      API_ERROR_CODES.conflict,
    )

    const otherResident = await residentSession(app, '另一居民', communityId)
    const duplicateUid = await api(app, 'POST', path, {
      session: admin,
      body: {
        platformUserId: otherResident.userId,
        crmebUid: 5001,
        verificationMethod: 'manual_verified',
      },
    })
    assert.equal(duplicateUid.status, 409)

    const unknownUser = await api(app, 'POST', path, {
      session: admin,
      body: {
        platformUserId: '00000000-0000-4000-8000-000000000000',
        crmebUid: 5003,
        verificationMethod: 'manual_verified',
      },
    })
    assert.equal(unknownUser.status, 404)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('purchase link requires a resident session, a published same-community activity and explicit configuration', async () => {
  const { simulated, context } = await configuredContext()
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityA = await createCommunity(app, admin, 'A 社区')
    const communityB = await createCommunity(app, admin, 'B 社区')
    const publishedA = await createPublishedActivity(app, admin, communityA, 'A 社区活动')
    const publishedB = await createPublishedActivity(app, admin, communityB, 'B 社区活动')
    const draftA = await createDraftActivity(app, admin, communityA, 'A 社区草稿')
    const residentA = await residentSession(app, '居民 A', communityA)

    const body = { activityId: publishedA, crmebProductId: 101 }
    const anonymous = await app.request('/integrations/crmeb/purchase-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(anonymous.status, 401)

    const noCsrf = await app.request('/integrations/crmeb/purchase-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: residentA.cookies },
      body: JSON.stringify(body),
    })
    assert.equal(noCsrf.status, 403)
    assert.equal((await errorEnvelope(noCsrf)).error.code, API_ERROR_CODES.forbidden)

    const draft = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
      session: residentA,
      body: { activityId: draftA.id, crmebProductId: 101 },
    })
    assert.equal(draft.status, 404)

    // #171 LL-IDENTITY-001: the purchase link is a community-scoped write, and its
    // authority is the resident's own CONFIRMED binding. Resident A confirmed
    // community A, so an activity of community B is refused by the shared guard —
    // explicitly as `resident_community_conflict`, which the H5 can tell apart from
    // a generic `forbidden`, and the message names the bound community.
    const otherCommunity = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
      session: residentA,
      body: { activityId: publishedB, crmebProductId: 101 },
    })
    assert.equal(otherCommunity.status, 403)
    const otherCommunityError = (await errorEnvelope(otherCommunity)).error
    assert.equal(otherCommunityError.code, API_ERROR_CODES.residentCommunityConflict)
    assert.match(
      otherCommunityError.message,
      /A 社区/,
      'the refusal must name the community the resident actually confirmed',
    )

    const unknownActivity = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
      session: residentA,
      body: { activityId: '00000000-0000-4000-8000-000000000000', crmebProductId: 101 },
    })
    assert.equal(unknownActivity.status, 404)

    const missingProduct = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
      session: residentA,
      body: { activityId: publishedA },
    })
    assert.equal(missingProduct.status, 400)

    // The client cannot inject a staff id, confirmation state or CRMEB uid.
    for (const forged of [
      { ...body, gridWorkerId: '00000000-0000-4000-8000-000000000000' },
      { ...body, confirmed: true },
      { ...body, claimState: 'confirmed' },
      { ...body, crmebUid: 5001 },
    ]) {
      const response = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
        session: residentA,
        body: forged,
      })
      assert.equal(response.status, 400)
      assert.equal(
        (await errorEnvelope(response)).error.code,
        API_ERROR_CODES.invalidRequest,
      )
    }
    assert.equal(db.select().from(crmebClickAttributions).all().length, 0)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('natural purchase without an activity succeeds but its referral cannot upgrade attribution', async () => {
  const { simulated, context } = await configuredContext()
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '自然购买社区')
    const gridWorkerId = await createStaffAccount(app, admin, {
      username: 'gridnatural',
      displayName: '自然购买网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityId],
    })
    const resident = await residentSession(app, '自然购买居民', communityId)

    // No activity context at all: the natural flow from a product page.
    const natural = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
      session: resident,
      body: { crmebProductId: 101 },
    })
    assert.equal(natural.status, 201, await natural.clone().text())
    const naturalLink = crmebPurchaseLinkResponseSchema.parse(await natural.json())
    assert.equal(naturalLink.claim.activityId, null)
    assert.equal(naturalLink.claim.claimState, 'unconfirmed')
    assert.equal(naturalLink.claim.claimedStaffId, null)
    assert.equal(naturalLink.claim.crmebProductId, 101)
    const naturalUrl = new URL(naturalLink.url)
    assert.equal(naturalUrl.origin, simulated.baseUrl)
    assert.equal(naturalUrl.pathname, '/pages/goods_details/index')
    assert.equal(naturalUrl.searchParams.get('id'), '101')

    // A valid in-community grid-worker code must NOT become claimed without an
    // activity to scope it: hash only, no staff, still a successful purchase.
    const naturalWithReferral = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
      session: resident,
      body: { crmebProductId: 101, referralCode: gridWorkerId },
    })
    assert.equal(naturalWithReferral.status, 201)
    const referralLink = crmebPurchaseLinkResponseSchema.parse(
      await naturalWithReferral.json(),
    )
    assert.equal(referralLink.claim.activityId, null)
    assert.equal(referralLink.claim.claimState, 'unconfirmed')
    assert.equal(referralLink.claim.claimedStaffId, null)

    // Login and CSRF are still mandatory for the natural flow.
    const anonymous = await app.request('/integrations/crmeb/purchase-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ crmebProductId: 101 }),
    })
    assert.equal(anonymous.status, 401)
    const noCsrf = await app.request('/integrations/crmeb/purchase-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: resident.cookies },
      body: JSON.stringify({ crmebProductId: 101 }),
    })
    assert.equal(noCsrf.status, 403)

    for (const forged of [
      { crmebProductId: 101, gridWorkerId },
      { crmebProductId: 101, confirmed: true },
      { crmebProductId: 101, crmebUid: 5001 },
      { crmebProductId: 101, claimState: 'confirmed' },
    ]) {
      const response = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
        session: resident,
        body: forged,
      })
      assert.equal(response.status, 400)
      assert.equal(
        (await errorEnvelope(response)).error.code,
        API_ERROR_CODES.invalidRequest,
      )
    }

    const claims = db.select().from(crmebClickAttributions).all()
    assert.equal(claims.length, 2)
    assert.ok(claims.every((claim) => claim.activityId === null))
    assert.ok(claims.every((claim) => claim.claimState === 'unconfirmed'))
    assert.ok(claims.every((claim) => claim.claimedStaffId === null))
    assert.equal(claims[0]?.referralCodeHash, null)
    assert.match(claims[1]?.referralCodeHash ?? '', /^[a-f0-9]{64}$/)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('referral attribution is resolved server-side and never confirmed by the browser path', async () => {
  const { simulated, context } = await configuredContext()
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityA = await createCommunity(app, admin, 'A 社区')
    const communityB = await createCommunity(app, admin, 'B 社区')
    const activityA = await createPublishedActivity(app, admin, communityA)
    const gridA = await createStaffAccount(app, admin, {
      username: 'grida',
      displayName: 'A 社区网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityA],
    })
    const gridB = await createStaffAccount(app, admin, {
      username: 'gridb',
      displayName: 'B 社区网格员',
      password: GRID_PASSWORD,
      role: 'grid_worker',
      communityIds: [communityB],
    })
    const residentA = await residentSession(app, '居民 A', communityA)

    async function purchase(referralCode?: string) {
      const response = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
        session: residentA,
        body: {
          activityId: activityA,
          crmebProductId: 101,
          ...(referralCode ? { referralCode } : {}),
        },
      })
      assert.equal(response.status, 201, await response.clone().text())
      return crmebPurchaseLinkResponseSchema.parse(await response.json())
    }

    const inCommunity = await purchase(gridA)
    const url = new URL(inCommunity.url)
    assert.equal(url.origin, simulated.baseUrl)
    assert.equal(url.pathname, '/pages/goods_details/index')
    assert.equal(url.searchParams.get('id'), '101')
    assert.equal(url.searchParams.has('spread'), false, 'spread is a distributor uid, not a source')
    assert.equal(inCommunity.claim.claimState, 'claimed')
    assert.equal(inCommunity.claim.claimedStaffId, gridA)
    assert.equal(inCommunity.claim.activityId, activityA)
    assert.equal(inCommunity.warnings.length, 3)

    const outOfCommunity = await purchase(gridB)
    assert.equal(outOfCommunity.claim.claimState, 'unconfirmed')
    // The attempted staff id stays in the DB/hash for audit only; it must not be
    // echoed to the browser as if it were an accepted claim.
    assert.equal(outOfCommunity.claim.claimedStaffId, null)

    const unknownCode = await purchase('00000000-0000-4000-8000-000000000000')
    assert.equal(unknownCode.claim.claimState, 'unconfirmed')
    assert.equal(unknownCode.claim.claimedStaffId, null)

    const organic = await purchase()
    assert.equal(organic.claim.claimState, 'unconfirmed')

    const malformedCode = await api(app, 'POST', '/integrations/crmeb/purchase-link', {
      session: residentA,
      body: { activityId: activityA, crmebProductId: 101, referralCode: 'x'.repeat(65) },
    })
    assert.equal(malformedCode.status, 400)

    const claims = db.select().from(crmebClickAttributions).all()
    assert.equal(claims.length, 4)
    assert.deepEqual(
      claims.map((claim) => claim.claimState).sort(),
      ['claimed', 'unconfirmed', 'unconfirmed', 'unconfirmed'],
    )
    assert.equal(
      claims.some((claim) => claim.claimState === 'confirmed'),
      false,
      'the public purchase path must never write a confirmed attribution',
    )
    assert.equal(new Set(claims.map((claim) => claim.clickId)).size, 4)
    assert.ok(claims.every((claim) => claim.referralCodeHash === null || claim.referralCodeHash.length === 64))
    assert.ok(
      claims
        .filter((claim) => claim.claimState === 'unconfirmed')
        .every((claim) => claim.claimedStaffId === null),
    )
    const claimed = claims.find((claim) => claim.claimState === 'claimed')
    assert.equal(claimed?.claimedStaffId, gridA)
    if (claimed) {
      assert.throws(
        () =>
          db
            .update(crmebClickAttributions)
            .set({ claimState: 'unconfirmed' })
            .where(eq(crmebClickAttributions.id, claimed.id))
            .run(),
        /CHECK|constraint/i,
      )
    }
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('an admin can revoke a CRMEB identity and explicitly rebind it later', async () => {
  const { simulated, context } = await configuredContext()
  const { db, app } = context
  try {
    await seedAdmin(db)
    const admin = await staffSession(app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(app, admin, '撤销社区')
    await createStaffAccount(app, admin, {
      username: 'operator1',
      displayName: '运营员',
      password: OPERATOR_PASSWORD,
      role: 'operator',
      communityIds: [communityId],
    })
    const operator = await staffSession(app, 'operator1', OPERATOR_PASSWORD)
    const resident = await residentSession(app, '撤销居民', communityId)
    const bindPath = '/admin/integrations/crmeb/identities'
    const revokePath = `${bindPath}/${resident.userId}/revoke`

    const bound = await api(app, 'POST', bindPath, {
      session: admin,
      body: {
        platformUserId: resident.userId,
        crmebUid: 5001,
        verificationMethod: 'manual_verified',
      },
    })
    assert.equal(bound.status, 201)
    const boundBody = crmebIdentityBindResponseSchema.parse(await bound.json())

    const operatorRevoke = await api(app, 'POST', revokePath, {
      session: operator,
      body: {},
    })
    assert.equal(operatorRevoke.status, 403)
    assert.equal(
      (await errorEnvelope(operatorRevoke)).error.code,
      API_ERROR_CODES.forbidden,
    )

    const noCsrf = await api(app, 'POST', revokePath, {
      session: admin,
      body: {},
      csrf: false,
    })
    assert.equal(noCsrf.status, 403)

    const unknown = await api(
      app,
      'POST',
      `/admin/integrations/crmeb/identities/00000000-0000-4000-8000-000000000000/revoke`,
      { session: admin, body: {} },
    )
    assert.equal(unknown.status, 404)

    const revoked = await api(app, 'POST', revokePath, { session: admin, body: {} })
    assert.equal(revoked.status, 200)
    const revokedBody = crmebIdentityRevokeResponseSchema.parse(await revoked.json())
    assert.equal(revokedBody.identity.id, boundBody.identity.id)
    assert.equal(revokedBody.identity.status, 'revoked')

    const revokedRow = db
      .select()
      .from(crmebIdentities)
      .where(eq(crmebIdentities.platformUserId, resident.userId))
      .get()
    assert.equal(revokedRow?.status, 'revoked')
    assert.ok(
      (revokedRow?.updatedAt.getTime() ?? 0) >= (revokedRow?.verifiedAt.getTime() ?? 0),
    )

    const revokeAudit = db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, 'crmeb.identity.revoked'))
      .all()
    assert.equal(revokeAudit.length, 1)
    assert.deepEqual(JSON.parse(revokeAudit[0]?.metadata ?? '{}'), {
      previousCrmebUid: '5001',
    })

    const afterRevoke = await api(app, 'GET', '/integrations/crmeb/identity/me', {
      session: resident,
    })
    assert.deepEqual(await afterRevoke.json(), { linked: false })

    // A revoked row can be explicitly rebound, including to a new CRMEB uid.
    const rebound = await api(app, 'POST', bindPath, {
      session: admin,
      body: {
        platformUserId: resident.userId,
        crmebUid: 5002,
        verificationMethod: 'manual_verified',
        note: '撤销后重新人工核实',
      },
    })
    assert.equal(rebound.status, 201)
    const reboundBody = crmebIdentityBindResponseSchema.parse(await rebound.json())
    assert.equal(reboundBody.identity.id, boundBody.identity.id)
    assert.equal(reboundBody.identity.crmebUid, 5002)
    assert.equal(reboundBody.identity.status, 'active')

    const rebindAudit = db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.event, 'crmeb.identity.rebound'))
      .all()
    assert.equal(rebindAudit.length, 1)
    assert.deepEqual(JSON.parse(rebindAudit[0]?.metadata ?? '{}'), {
      previousCrmebUid: '5001',
      crmebUid: '5002',
      verificationMethod: 'manual_verified',
    })
    const afterRebind = await api(app, 'GET', '/integrations/crmeb/identity/me', {
      session: resident,
    })
    const afterRebindBody = crmebIdentityStatusResponseSchema.parse(
      await afterRebind.json(),
    )
    assert.equal(afterRebindBody.linked, true)
  } finally {
    await simulated.close()
    context.sqlite.close()
  }
})

test('purchase link reports not_configured instead of returning a fake link', async () => {
  const context = createTestContext()
  try {
    await seedAdmin(context.db)
    const admin = await staffSession(context.app, 'admin', ADMIN_PASSWORD)
    const communityId = await createCommunity(context.app, admin, '未配置社区')
    const activityId = await createPublishedActivity(context.app, admin, communityId)
    const resident = await residentSession(context.app, '居民', communityId)
    const response = await api(context.app, 'POST', '/integrations/crmeb/purchase-link', {
      session: resident,
      body: { activityId, crmebProductId: 101 },
    })
    assert.equal(response.status, 503)
    assert.equal((await errorEnvelope(response)).error.code, API_ERROR_CODES.notConfigured)
    assert.equal(context.db.select().from(crmebClickAttributions).all().length, 0)
  } finally {
    context.sqlite.close()
  }
})

test('csrf helper is usable for the admin routes', async () => {
  const context = createTestContext()
  try {
    const state = await csrf(context.app)
    assert.ok(state.token.length >= 20)
    assert.ok(state.cookie.startsWith('ll_csrf='))
  } finally {
    context.sqlite.close()
  }
})
