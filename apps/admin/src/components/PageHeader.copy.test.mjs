import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

describe('admin page header copy hygiene', () => {
  it('rejects promotional badges on every business page', () => {
    // Actual business states such as 已锁定、待核验、已启用 and 无权限 stay.
    const pagesDir = join(import.meta.dirname, '../pages')
    const pageSources = readdirSync(pagesDir)
      .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
    for (const name of pageSources) {
      const source = readFileSync(join(pagesDir, name), 'utf8')
      expect(source, name).not.toMatch(/status=\{\s*<Tag[^>]*>(?:真实数据|已验证身份|开发预览)<\/Tag>\s*\}/)
    }
  })
})
