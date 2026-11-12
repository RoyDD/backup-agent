import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import {
  StorageError,
  validateStorageKey,
  validateStoragePrefix,
  type Storage,
  type StorageStat,
} from '../ports/storage'

export interface FsStorageOptions {
  /** Root directory of the object namespace. Created lazily by `put`. */
  root: string
  /** `fs` for a local disk, `nfs` for a mounted share. Only the id differs. */
  kind?: 'fs' | 'nfs'
}

/** Files written by `put` before the atomic rename. Skipped by `list`. */
const TMP_MARKER = '.tmp-'
const TMP_SUFFIX = /\.tmp-[0-9a-f]{24}$/

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function isErrno(err: unknown, ...codes: string[]): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && codes.includes(code)
}

/**
 * Object storage on a local directory tree.
 *
 * Writes are atomic (`<key>.tmp-<random>` then `rename`) and mode `0600`, so a
 * reader never observes a half-written object and a backup payload is not
 * readable by other local accounts. Every path is resolved against the root and
 * re-checked, which is defence in depth after `validateStorageKey`: a key that
 * somehow reached the filesystem layer still cannot escape the root.
 */
export class FsStorage implements Storage {
  readonly id: string
  private readonly rootDir: string
  /** Root prefix used by the containment check, tolerant of a `'/'` root. */
  private readonly rootPrefix: string

  constructor(options: FsStorageOptions) {
    const rootDir = resolve(options.root)
    this.rootDir = rootDir
    this.rootPrefix = rootDir.endsWith(sep) ? rootDir : rootDir + sep
    this.id = `${options.kind ?? 'fs'}:${rootDir}`
  }

  /** Absolute path for a key, or `INVALID_KEY` if it would leave the root. */
  private pathFor(key: string): string {
    const target = resolve(this.rootDir, key)
    if (target !== this.rootDir && !target.startsWith(this.rootPrefix)) {
      throw new StorageError('INVALID_KEY', `storage key ${JSON.stringify(key)} escapes the root`)
    }
    return target
  }

  async put(
    key: string,
    data: Uint8Array | string,
    options?: { contentType?: string },
  ): Promise<StorageStat> {
    void options
    const validKey = validateStorageKey(key)
    const target = this.pathFor(validKey)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data

    const tmp = `${target}${TMP_MARKER}${randomBytes(12).toString('hex')}`
    try {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(tmp, bytes, { mode: 0o600 })
      await rename(tmp, target)
    } catch (err) {
      // Best effort: a leftover temp file is invisible to readers but still
      // occupies space, so remove it before surfacing the failure.
      await rm(tmp, { force: true }).catch(() => undefined)
      if (err instanceof StorageError) throw err
      throw new StorageError('IO', `put ${validKey} failed: ${describe(err)}`)
    }

    return {
      key: validKey,
      bytes: bytes.byteLength,
      digest: sha256Hex(bytes),
      modifiedAt: (await stat(target)).mtime.toISOString(),
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const validKey = validateStorageKey(key)
    try {
      return await readFile(this.pathFor(validKey))
    } catch (err) {
      if (isErrno(err, 'ENOENT', 'ENOTDIR')) {
        throw new StorageError('NOT_FOUND', `get ${validKey}: object not found`)
      }
      throw new StorageError('IO', `get ${validKey} failed: ${describe(err)}`)
    }
  }

  async stat(key: string): Promise<StorageStat | null> {
    const validKey = validateStorageKey(key)
    try {
      const target = this.pathFor(validKey)
      const info = await stat(target)
      if (!info.isFile()) return null
      const bytes = await readFile(target)
      return {
        key: validKey,
        bytes: info.size,
        digest: sha256Hex(bytes),
        modifiedAt: info.mtime.toISOString(),
      }
    } catch (err) {
      if (isErrno(err, 'ENOENT', 'ENOTDIR')) return null
      throw new StorageError('IO', `stat ${validKey} failed: ${describe(err)}`)
    }
  }

  async list(prefix = ''): Promise<StorageStat[]> {
    const validPrefix = validateStoragePrefix(prefix)
    const results: StorageStat[] = []

    const walk = async (dir: string, keyPrefix: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch (err) {
        if (isErrno(err, 'ENOENT', 'ENOTDIR')) return
        throw new StorageError('IO', `list ${validPrefix} failed: ${describe(err)}`)
      }
      for (const entry of entries) {
        const key = keyPrefix === '' ? entry.name : `${keyPrefix}/${entry.name}`
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), key)
          continue
        }
        if (!entry.isFile()) continue
        // Names that look like our own in-flight writes are not objects.
        if (TMP_SUFFIX.test(entry.name)) continue
        if (!key.startsWith(validPrefix)) continue
        const target = join(dir, entry.name)
        const info = await stat(target)
        results.push({
          key,
          bytes: info.size,
          digest: sha256Hex(await readFile(target)),
          modifiedAt: info.mtime.toISOString(),
        })
      }
    }

    await walk(this.rootDir, '')
    results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    return results
  }

  async delete(key: string): Promise<boolean> {
    const validKey = validateStorageKey(key)
    const target = this.pathFor(validKey)
    try {
      // unlink, never rm -r: this storage deletes objects, not directories.
      await unlink(target)
      return true
    } catch (err) {
      if (isErrno(err, 'ENOENT', 'ENOTDIR')) return false
      throw new StorageError('IO', `delete ${validKey} failed: ${describe(err)}`)
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code === undefined ? err.message : `${code}: ${err.message}`
  }
  return String(err)
}
