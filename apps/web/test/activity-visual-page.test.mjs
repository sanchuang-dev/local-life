import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

const page = read('src/pages/SilverNeighborhoodCampaignPage.tsx')
const poster = read('src/components/activity/ActivitySharePoster.tsx')
const image = read('src/components/activity/ActivityImage.tsx')
const artwork = read('src/components/activity/ActivityArtwork.tsx')
const discovery = read('src/pages/CommunityDiscoveryPage.tsx')
const themeCss = read('src/components/activity/activityTheme.css')
const wechatShare = read('src/components/activity/wechatShare.ts')
const shareHook = read('src/hooks/useWechatActivityShare.ts')
const visual = read('src/components/activity/activityVisual.ts')

test('activity detail page owns the scoped theme root and consumes visualConfig', () => {
  assert.match(page, /style=\{themeStyle\}/)
  assert.match(page, /data-activity-theme=\{themeName\}/)
  assert.match(page, /activityThemeStyle\(activity\?\.visualConfig\.themeKey\)/)
  assert.match(page, /resolveActivityHeroImageCandidates\(\s*activity\?\.visualConfig/)
  assert.match(page, /resolveActivityPromoCopy\(activity\?\.visualConfig\)/)
  assert.match(page, /className="activity-theme-hero/)
  assert.match(page, /className="activity-theme-body/)
  assert.match(page, /activity-theme-countdown/)
  // The page reads the shared projection instead of hard-coding the old artwork.
  assert.doesNotMatch(page, /silver-neighborhood-hero\.webp/)
  assert.doesNotMatch(page, /QRCodeSVG/)
})

test('theme variables are scoped to the activity page, never :root/body', () => {
  assert.doesNotMatch(themeCss, /(^|\n)\s*:root\b/)
  assert.doesNotMatch(themeCss, /(^|\n)\s*(html|body)\b/)
  assert.match(themeCss, /--activity-primary/)
  assert.match(themeCss, /--activity-bg/)
  assert.match(themeCss, /--activity-surface/)
  assert.match(themeCss, /--activity-border/)
  assert.match(themeCss, /--activity-button/)
  // Only the activity page dialog eyebrow is re-coloured; status copy is not.
  assert.match(themeCss, /\.activity-page \[role='dialog'\]/)
  // Primary CTAs have fallback values so reused components stay usable elsewhere.
  assert.match(themeCss, /var\(--activity-button, #0f766e\)/)
})

test('hero has a real candidate chain and keeps the historical fallback last', () => {
  assert.match(page, /<ActivityImage/)
  assert.match(page, /candidates=\{heroCandidates\}/)
  assert.match(page, /key=\{`hero:/)
  assert.match(image, /onError=\{\(\) => setFailedCount/)
  assert.match(image, /candidates\[failedCount\]/)
  assert.match(image, /activity-image-fallback/)
  assert.match(visual, /resolveActivityHeroImageCandidates/)
  assert.match(visual, /activityFallbackImageUrl\(baseUrl, activityTitle\)/)
})

test('share poster is one real poster image with a fixed separate white QR area', () => {
  assert.match(page, /<ActivitySharePoster/)
  assert.match(page, /shareUrl=\{shareUrl\}/)
  // The QR value is the shared invite URL built from the real activity id.
  assert.match(page, /buildActivityShareUrl\(shareableActivity\.id, team\.inviteCode\)/)
  assert.match(poster, /resolveActivityPosterImageCandidates/)
  assert.match(poster, /resolveActivityPosterCopy/)
  assert.match(poster, /<QRCodeSVG\s+value=\{shareUrl\}/)
  // The QR code is the generated activity URL, never the poster image.
  assert.doesNotMatch(poster, /<QRCodeSVG[\s\S]{0,200}value=\{candidates/)
  // Artwork and copy come first; the QR sits in its own area below them.
  assert.ok(poster.indexOf('aspect-[3/4]') < poster.indexOf('activity-poster__qr'))
  assert.ok(poster.indexOf('activity-poster__qr') < poster.indexOf('<QRCodeSVG'))
  assert.match(themeCss, /\.activity-poster__qr\s*\{[^}]*background-color: #ffffff/)
  // 320px viewport: sheet padding + poster max width + QR size all fit.
  assert.match(poster, /max-w-\[300px\]/)
  assert.match(poster, /max-w-full/)
  assert.match(poster, /size=\{148\}/)
  // No arbitrary poster coordinate editor and no fake screenshot download.
  assert.doesNotMatch(poster, /draggable|截图|download/i)
  assert.match(page, /截图保存暂未开放/)
})

test('WeChat share metadata comes from the current activity visual projection', () => {
  assert.match(shareHook, /createWechatActivityShareData\(\s*activity,/)
  assert.match(wechatShare, /resolveActivityPromoCopy\(activity\.visualConfig\)/)
  assert.match(wechatShare, /resolveWechatShareImageUrl\(activity\.visualConfig/)
  assert.doesNotMatch(wechatShare, /silver-neighborhood-hero\.webp/)
})

test('activity list reuses the same ActivityArtwork projection and fallback', () => {
  assert.match(discovery, /<ActivityArtwork\s+imageUrl=\{resolveActivityArtworkImageUrl\(activity\.visualConfig\)\}/)
  assert.match(discovery, /alt=\{`\$\{activity\.title\}活动头图`\}/)
  assert.match(artwork, /imageUrl\?: string \| null/)
  assert.match(artwork, /onError=\{showPhoto \?/)
  assert.match(artwork, /aria-hidden=\{showPhoto \? undefined : 'true'\}/)
  assert.match(artwork, /community-activity-artwork\.webp/)
})
