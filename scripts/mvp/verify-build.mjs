import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const sites = [
  ['resident', 'apps/web/dist/index.html'],
  ['admin', 'apps/admin/dist/index.html'],
]
for (const [name, page] of sites) {
  const path = resolve(repositoryRoot, page)
  assert.ok(existsSync(path), `Missing ${name} page: ${path}`)
  const html = readFileSync(path, 'utf8')
  assert.match(html, /(?:src|href)="\/assets\//, `${name} assets must load from the origin root`)
  assert.doesNotMatch(html, /(?:src|href)="\/local-life\//, `${name} must not reference the GitHub Pages prefix`)
  console.log(`MVP_ROOT_BUILD_OK=${name}`)
}
const migrations = resolve(repositoryRoot, 'apps/api/db/migrations/meta/_journal.json')
assert.ok(existsSync(migrations), 'API migration journal must be bundled')
console.log('MVP_API_MIGRATIONS_PRESENT=yes')
