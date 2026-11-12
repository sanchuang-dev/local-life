import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { publicCommunityListSchema } from '@sanchuang-dev/local-life-contracts'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/db/client.js'
import { communities } from '../src/db/schema.js'
import { haversineDistanceMeters } from '../src/communities/discovery.js'

const migrations = fileURLToPath(new URL('../db/migrations', import.meta.url))

test('community distance is zero at same point, positive and symmetric elsewhere', () => {
  assert.equal(haversineDistanceMeters(24.8, 113.6, 24.8, 113.6), 0)
  const a = haversineDistanceMeters(24.8, 113.6, 24.9, 113.6)
  assert.ok(a > 10000 && a < 12000)
  assert.equal(a, haversineDistanceMeters(24.9, 113.6, 24.8, 113.6))
})

test('public community discovery is real, permission-free, ordered and excludes resident data', async () => {
  const { db, sqlite } = createDatabase(':memory:', migrations)
  try {
    const now = new Date()
    const idNear = randomUUID()
    const idFar = randomUUID()
    const idUnset = randomUUID()
    db.insert(communities).values([
      { id: idFar, name: '外城社区', address: '城北服务点', latitudeGcj02: 25.3, longitudeGcj02: 113.6, createdAt: now },
      { id: idUnset, name: '无坐标社区', address: null, latitudeGcj02: null, longitudeGcj02: null, createdAt: now },
      { id: idNear, name: '幸福社区', address: '韶关市服务点', latitudeGcj02: 24.8, longitudeGcj02: 113.6, createdAt: now },
    ]).run()
    const app = createApp({
      db,
      config: loadConfig({ NODE_ENV: 'test', AUTH_DEV_ENABLED: 'true' }),
      logRequests: false,
    })
    const response = await app.request('/communities/public?latitude=24.8&longitude=113.6')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const parsed = publicCommunityListSchema.parse(await response.json())
    assert.deepEqual(parsed.items.map((i) => i.id), [idNear, idFar, idUnset])
    assert.equal(parsed.items[0]?.distanceMeters, 0)
    assert.equal(parsed.items[0]?.nearby, true)
    assert.equal(parsed.items[1]?.nearby, false)
    assert.equal(parsed.items[2]?.distanceMeters, null)
    assert.equal(JSON.stringify(parsed).includes('latitudeGcj02'), false)
    assert.equal(JSON.stringify(parsed).includes('longitudeGcj02'), false)
    assert.equal((await app.request('/communities/public?q=%E5%B9%B8%E7%A6%8F')).status, 200)
    const searched = publicCommunityListSchema.parse(
      await (await app.request('/communities/public?q=%E5%B9%B8%E7%A6%8F')).json(),
    )
    assert.deepEqual(searched.items.map((i) => i.id), [idNear])
    const invalid = [
      '/communities/public?latitude=24.8',
      '/communities/public?longitude=113.6',
      '/communities/public?latitude=999&longitude=1',
      '/communities/public?latitude=abc&longitude=113.6',
      '/communities/public?q=' + 'x'.repeat(61),
    ]
    for (const path of invalid) {
      const result = await app.request(path)
      assert.equal(result.status, 400, path)
      assert.equal((await result.json() as { error: { code: string } }).error.code, 'invalid_request')
    }
  } finally {
    sqlite.close()
  }
})
