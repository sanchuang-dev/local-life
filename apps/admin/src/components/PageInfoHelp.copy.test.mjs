import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

describe('admin informational alert presentation', () => {
  it('routes all blue informational alerts through shared header help', () => {
    for (const folder of ['../pages', '.']) {
      const directory = join(import.meta.dirname, folder)
      for (const name of readdirSync(directory).filter((name) =>
        name.endsWith('.tsx') && !name.endsWith('.test.tsx') && name !== 'PageInfoHelp.tsx'
      )) {
        const code = readFileSync(join(directory, name), 'utf8')
        // Do not introduce a full-width blue Alert back into any business UI.
        expect(code, name).not.toMatch(/<Alert\b(?:(?!\/>)[\s\S])*?\btype\s*=\s*["']info["']/)
      }
    }
    const header = readFileSync(join(import.meta.dirname, 'PageHeader.tsx'), 'utf8')
    expect(header).toContain('<PageInfoControl />')
    const shell = readFileSync(join(import.meta.dirname, '../app/shell/AppShell.tsx'), 'utf8')
    expect(shell).toContain('<PageInfoProvider key={location.pathname}><Outlet /></PageInfoProvider>')
  })
})
