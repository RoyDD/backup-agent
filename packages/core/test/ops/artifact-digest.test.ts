import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { digestArtifact } from '../../src/ops/artifact-digest'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bk-digest-'))
  dirs.push(dir)
  return dir
}

describe('digestArtifact', () => {
  it('returns sha256 of a single file and is stable', () => {
    const dir = tempDir()
    const file = join(dir, 'backup.dump')
    writeFileSync(file, 'payload bytes')

    const expected = createHash('sha256').update(Buffer.from('payload bytes')).digest('hex')
    expect(digestArtifact(file)).toBe(expected)
    expect(digestArtifact(file)).toBe(expected)
  })

  it('digests a directory tree deterministically and detects nested changes', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'tables'))
    writeFileSync(join(dir, 'tables', 'a.dat'), 'alpha')
    writeFileSync(join(dir, 'manifest.json'), '{"v":1}')

    const first = digestArtifact(dir)
    expect(first).not.toBeNull()
    // Deterministic across calls for an unchanged tree.
    expect(digestArtifact(dir)).toBe(first)

    writeFileSync(join(dir, 'tables', 'a.dat'), 'alpha changed')
    const changed = digestArtifact(dir)
    expect(changed).not.toBeNull()
    expect(changed).not.toBe(first)

    // Instruction-only verification: an empty tree still yields a digest.
    const empty = tempDir()
    expect(digestArtifact(empty)).not.toBeNull()
  })

  it('returns null for a missing path instead of throwing', () => {
    const dir = tempDir()
    expect(digestArtifact(join(dir, 'does-not-exist'))).toBeNull()
  })
})
