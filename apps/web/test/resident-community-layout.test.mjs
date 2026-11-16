import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const home = readFileSync(join(import.meta.dirname, '../src/pages/CommunityDiscoveryPage.tsx'), 'utf8')
const styles = readFileSync(join(import.meta.dirname, '../src/pages/CommunityDiscoveryPage.css'), 'utf8')
const detail = readFileSync(join(import.meta.dirname, '../src/pages/ResidentCommunityPage.tsx'), 'utf8')
const confirm = readFileSync(join(import.meta.dirname, '../src/pages/ResidentCommunityConfirmPage.tsx'), 'utf8')
const card = readFileSync(join(import.meta.dirname, '../src/components/community/ResidentCommunityCard.tsx'), 'utf8')

test('homepage shows a browse control plus a conditional bind action above activities', () => {
  const actions = home.split('className="community-home__actions">')[1]?.split('</div>')[0]
  assert.ok(actions)
  assert.match(actions, /绑定常驻社区/)
  assert.match(actions, /查看社区/)
  assert.match(actions, /openSheet\(null, e\.currentTarget\)/)
  assert.match(styles, /\.community-home__actions\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/)
  assert.match(styles, /\.community-home__actions>:only-child\{grid-column:1\/-1\}/)
  assert.ok(home.indexOf('className="community-home__actions"') < home.indexOf('className="community-home__activities"'))
  assert.doesNotMatch(home, /className="community-home__residence"|<ResidentCommunityCard/)
})

test('binding uses server approval, a real selected community, or login return', () => {
  assert.match(home, /canOfferConfirmation\(residentStatus\)/)
  assert.match(home, /const confirmReturnTo = community/)
  assert.match(home, /residentCommunityConfirmHrefWithContext\(community\.id, routeSearch\)/)
  assert.match(home, /buildResidentLoginHref\(confirmReturnTo/)
  assert.match(home, /canBeginBinding && !community/)
  assert.match(home, /type="button" className=\{primary\} disabled/)
  assert.doesNotMatch(home, /residentCommunityConfirmHrefWithContext\(selectedId/)
  assert.match(detail, /variant="full"/)
})

test('confirmation returns to its caller with the normal compact back link', () => {
  assert.match(home, /state=\{\{ from: '\/' \}\}/)
  assert.match(card, /state=\{\{ from: '\/me\/community' \}\}/)
  assert.match(confirm, /useBackTarget\('\/', '返回'\)/)
  assert.match(confirm, /<Link to=\{backTo\}/)
  assert.match(confirm, /<ArrowLeft size=\{16\}/)
  assert.doesNotMatch(confirm, /返回我的常驻社区/)
})

test('binding is a single checked confirmation without nested warnings or next-step gate', () => {
  const form = confirm.split("{statusData && !confirmedName && confirmationOpen && lookup.status === 'ready'")[1]
  assert.ok(form)
  assert.match(form, /lookup\.community\.name/)
  assert.match(form, /type="checkbox"/)
  assert.match(form, /绑定后不可自行修改/)
  assert.match(form, /确认绑定/)
  assert.match(form, /disabled=\{acknowledgedCommunityId !== communityId \|\| submitting\}/)
  assert.match(confirm, /acknowledgedCommunityId !== communityId \|\| submitting\) return/)
  assert.match(form, /onClick=\{\(\) => void submit\(\)\}/)
  assert.doesNotMatch(form, /我已了解|继续确认|返回上一步|irreversibleWarning|PERMANENT_BINDING_NOTICE|browserShelter/)
  assert.doesNotMatch(confirm, /setStep|\[step, setStep\]/)
})

test('bound residents see their actual permanent community and only the full-width browse action', () => {
  // This must come from the server status binding, not selectedId or the browsing directory.
  assert.match(home, /residentCommunity\.state\.status === 'ready' \? residentCommunity\.state\.data : null/)
  assert.match(home, /const boundCommunityName = residentStatus\?\.binding\?\.community\.name \?\? null/)
  const banner = home.split('className="community-home__banner-title"')[1]?.split('</div>')[0]
  assert.ok(banner)
  assert.match(banner, /boundCommunityName \? \(/)
  assert.match(banner, /<MapPin size=\{14\}/)
  assert.match(banner, /<span>\{boundCommunityName\}<\/span>/)
  assert.match(banner, /: '社区活动与便民服务'/)
  const actions = home.split('className="community-home__actions">')[1]?.split('</div>')[0]
  assert.ok(actions)
  assert.match(actions, /!boundCommunityName \? \(/)
  assert.match(actions, /查看社区/)
  assert.match(styles, /\.community-home__actions>:only-child\{grid-column:1\/-1\}/)
  assert.match(styles, /\.community-home__banner-title\{[^}]*right:20px/)
})
