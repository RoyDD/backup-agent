import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const root = new URL('../../../presets/pg-dba/skills/', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('MANIFEST.json', root), 'utf8'))

describe('skill manifest', () => {
  it('lists every skill with a matching hash', () => {
    expect(manifest.version).toBe(1)
    expect(manifest.entries.length).toBeGreaterThanOrEqual(6)
    for (const entry of manifest.entries) {
      const body = readFileSync(new URL(entry.path, root), 'utf8')
      const hash = createHash('sha256').update(body).digest('hex')
      expect(hash).toBe(entry.sha256)
    }
  })

  it('gives every skill a name and description', () => {
    for (const entry of manifest.entries) {
      const body = readFileSync(new URL(entry.path, root), 'utf8')
      expect(body).toMatch(/^---\n/)
      expect(body).toMatch(/\nname: /)
      expect(body).toMatch(/\ndescription: /)
    }
  })
})
