import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_CORPUS_DIR, DEFAULT_DB_PATH, PACKAGE_ROOT, REPO_ROOT } from '../src/corpus/sources'

describe('workspace paths', () => {
  it('discovers the workspace root from source and from the bundle', () => {
    // The bundle lives in dist/, one level under the root, so a hard-coded
    // `../..` silently resolved to /home/roy. The marker file is the contract.
    expect(existsSync(join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('keeps derived paths inside the workspace', () => {
    expect(DEFAULT_DB_PATH.startsWith(join(REPO_ROOT, 'var'))).toBe(true)
    expect(DEFAULT_CORPUS_DIR.startsWith(join(REPO_ROOT, 'knowledge-corpus'))).toBe(true)
    expect(existsSync(join(PACKAGE_ROOT, 'eval'))).toBe(true)
  })
})
