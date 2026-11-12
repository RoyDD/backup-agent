import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FsStorage } from '../../src/storage/fs-storage'
import { StorageError, type StorageErrorCode } from '../../src/ports/storage'

const roots: string[] = []

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bk-fs-storage-'))
  roots.push(dir)
  return dir
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex')
}

async function expectCode(promise: Promise<unknown>, code: StorageErrorCode): Promise<StorageError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError)
    const storageError = err as StorageError
    expect(storageError.code).toBe(code)
    return storageError
  }
  throw new Error(`expected StorageError(${code})`)
}

function allFiles(root: string): string[] {
  const names: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else names.push(full)
    }
  }
  walk(root)
  return names
}

describe('FsStorage key validation', () => {
  it.each(['../x', 'a/../../b', '/abs', 'a//b', 'a\\b', '', 'a/./b', 'a/'])(
    'rejects %j',
    async (key) => {
      const storage = new FsStorage({ root: tempRoot() })
      // Every entry point validates, not just put.
      await expectCode(storage.put(key, 'x'), 'INVALID_KEY')
      await expectCode(storage.get(key), 'INVALID_KEY')
      await expectCode(storage.stat(key), 'INVALID_KEY')
      await expectCode(storage.delete(key), 'INVALID_KEY')
    },
  )

  it('rejects a traversal prefix but accepts an empty one', async () => {
    const storage = new FsStorage({ root: tempRoot() })
    await expectCode(storage.list('../x'), 'INVALID_KEY')
    await expect(storage.list('')).resolves.toEqual([])
    await expect(storage.list('backups/')).resolves.toEqual([])
  })
})

describe('FsStorage objects', () => {
  it('round-trips bytes with size, sha256 and mtime', async () => {
    const root = tempRoot()
    const storage = new FsStorage({ root })
    const payload = 'backup payload bytes'

    const stat = await storage.put('target/2024/base.dump', payload)
    expect(stat.key).toBe('target/2024/base.dump')
    expect(stat.bytes).toBe(Buffer.byteLength(payload))
    expect(stat.digest).toBe(sha256(payload))
    expect(stat.modifiedAt).not.toBeNull()

    const bytes = await storage.get('target/2024/base.dump')
    expect(Buffer.from(bytes).toString('utf8')).toBe(payload)

    const again = await storage.stat('target/2024/base.dump')
    expect(again).toEqual(stat)
  })

  it('writes atomically and leaves no temp file behind', async () => {
    const root = tempRoot()
    const storage = new FsStorage({ root })
    await storage.put('a/one.bin', 'first')
    await storage.put('a/one.bin', 'second')

    const files = allFiles(root)
    expect(files.some((file) => /\.tmp-[0-9a-f]+$/.test(file))).toBe(false)
    expect(files).toHaveLength(1)
    expect(Buffer.from(await storage.get('a/one.bin')).toString('utf8')).toBe('second')
  })

  it('restricts written objects to mode 0600', async () => {
    const root = tempRoot()
    const storage = new FsStorage({ root })
    await storage.put('secret.dump', 'x')
    expect(statSync(join(root, 'secret.dump')).mode & 0o777).toBe(0o600)
  })

  it('lists recursively, sorted by key, ignoring our temp files', async () => {
    const root = tempRoot()
    const storage = new FsStorage({ root })
    await storage.put('b.txt', 'b')
    await storage.put('a/x.txt', 'x')
    await storage.put('a.txt', 'a')
    // A stray temp file from a killed writer is not an object.
    writeFileSync(join(root, 'b.txt.tmp-0123456789abcdef01234567'), 'partial')

    const listed = await storage.list()
    expect(listed.map((entry) => entry.key)).toEqual(['a.txt', 'a/x.txt', 'b.txt'])
    expect(listed[0]?.digest).toBe(sha256('a'))

    const scoped = await storage.list('a/')
    expect(scoped.map((entry) => entry.key)).toEqual(['a/x.txt'])
  })

  it('returns null from stat and NOT_FOUND from get for a missing object', async () => {
    const storage = new FsStorage({ root: tempRoot() })
    await expect(storage.stat('nope.bin')).resolves.toBeNull()
    await expectCode(storage.get('nope.bin'), 'NOT_FOUND')
  })

  it('deletes idempotently and never removes directories', async () => {
    const storage = new FsStorage({ root: tempRoot() })
    await storage.put('dir/obj.bin', 'x')

    await expect(storage.delete('dir/obj.bin')).resolves.toBe(true)
    await expect(storage.delete('dir/obj.bin')).resolves.toBe(false)
    // The containing directory survives.
    await expect(storage.stat('dir/obj.bin')).resolves.toBeNull()
    await expect(storage.list('dir/')).resolves.toEqual([])
  })
})

describe('FsStorage identity', () => {
  it('reports fs and nfs ids for the same root', () => {
    const root = tempRoot()
    const fsStorage = new FsStorage({ root })
    const nfsStorage = new FsStorage({ root, kind: 'nfs' })
    expect(fsStorage.id).toBe(`fs:${root}`)
    expect(nfsStorage.id).toBe(`nfs:${root}`)
    expect(fsStorage.id).not.toBe(nfsStorage.id)
  })
})
