import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const source = join(import.meta.dirname, '..', 'src')
const css = readFileSync(join(source, 'index.css'), 'utf8')

test('H5 radii share one compact Tailwind and CSS token scale', () => {
  for (const [name, value] of Object.entries({
    '--radius-sm': 4,
    '--radius-md': 6,
    '--radius-lg': 6,
    '--radius-xl': 8,
    '--radius-2xl': 10,
    '--radius-3xl': 12,
    '--app-radius-sm': 4,
    '--app-radius-control': 6,
    '--app-radius-card': 10,
    '--app-radius-panel': 12,
  })) {
    assert.ok(css.includes(`${name}: ${value}px;`), `${name} should be ${value}px`)
  }
})

test('H5 JSX uses semantic radius classes instead of arbitrary pixel values', () => {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.tsx')) {
        const text = readFileSync(path, 'utf8')
        assert.doesNotMatch(text, /rounded(?:-[a-z]+)?-\[\d+px\]/, path)
      }
    }
  }
  walk(source)
})
