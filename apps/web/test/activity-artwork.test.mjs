import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const page = readFileSync(join(root, 'src/pages/CommunityDiscoveryPage.tsx'), 'utf8')
const artwork = readFileSync(join(root, 'src/components/activity/ActivityArtwork.tsx'), 'utf8')
const emptyState = readFileSync(join(root, 'src/components/common/EmptyState.tsx'), 'utf8')
const image = join(root, 'public/images/community-activity-artwork.webp')

test('one shared transparent WebP illustration is small and base-path-safe', () => {
  const binary = readFileSync(image)
  assert.ok(statSync(image).size < 50_000)
  assert.equal(binary.toString('ascii', 0, 4), 'RIFF')
  assert.equal(binary.toString('ascii', 8, 12), 'WEBP')
  assert.match(artwork, /import\.meta\.env\.BASE_URL/)
  assert.match(artwork, /alt=""/)
  assert.match(artwork, /aria-hidden="true"/)
})

test('the shared illustration replaces repeated activity-cover icons and empty-list graphics', () => {
  assert.match(page, /<ActivityArtwork \/>/)
  assert.equal((page.match(/<ActivityArtwork variant="empty" \/>/g) ?? []).length, 2)
  assert.equal((page.match(/<EmptyState\b/g) ?? []).length, 2)
  assert.doesNotMatch(page, /community-home__thumbnail|community-home__empty-icon/)
  assert.match(emptyState, /illustration\?: ReactNode/)
  assert.match(emptyState, /action\?: ReactNode/)
  assert.match(page, /重新读取活动/)
  assert.match(page, /activityDetailHref\(activity\.id\)/)
})
