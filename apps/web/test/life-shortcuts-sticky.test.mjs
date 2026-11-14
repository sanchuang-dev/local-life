import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '../src')
const page = readFileSync(join(root, 'pages/LifePage.tsx'), 'utf8')
const css = readFileSync(join(root, 'pages/LifePage.css'), 'utf8')
const shellCss = readFileSync(join(root, 'index.css'), 'utf8')

test('惠生活 uses one real sticky shortcut row above the content', () => {
  assert.equal((page.match(/className="life-market__shortcuts"/g) ?? []).length, 1)
  const shortcutStyle = css.split('.life-market__shortcuts {')[1]?.split('}')[0]
  assert.ok(shortcutStyle)
  assert.match(shortcutStyle, /position:\s*sticky/)
  assert.match(shortcutStyle, /top:\s*calc\(12px \+ env\(safe-area-inset-top, 0px\)\)/)
  assert.match(shortcutStyle, /z-index:\s*20/)
  assert.match(shortcutStyle, /background:\s*#fff/)
  assert.ok(page.indexOf('life-market__hero') < page.indexOf('life-market__shortcuts'))
  assert.ok(page.indexOf('life-market__shortcuts') < page.indexOf('life-market__content'))
  assert.match(shellCss, /Normal document scrolling/)
})

test('the shortcut scroll targets clear its sticky height and retain their actions', () => {
  assert.match(page, /scrollIntoView\(\{/)
  for (const id of ['life-local', 'life-offers', 'life-deals']) {
    assert.ok(page.includes(`jumpTo('${id}')`))
  }
  const shelfStyle = css.split('.life-shelf-card,')[1]?.split('}')[0]
  assert.match(shelfStyle ?? '', /scroll-margin-top:\s*calc\(134px \+ env\(safe-area-inset-top, 0px\)\)/)
  assert.match(page, /to="\/me\/orders"/)
  assert.match(page, /to="\/"/)
})
