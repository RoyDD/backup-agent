/**
 * Object-storage seam for artifact bytes.
 *
 * The port is transport-only: keys are opaque, relative object names. No
 * implementation may interpret a key as a filesystem path or a shell string,
 * and no implementation may silently degrade to a local write when a remote
 * backend is unreachable (capability failures are fatal, never degraded).
 */

export interface StorageStat {
  readonly key: string
  readonly bytes: number
  /** Content digest when the backend can provide one (fs: sha256; s3: ETag). */
  readonly digest: string | null
  readonly modifiedAt: string | null
}

export interface Storage {
  readonly id: string
  put(key: string, data: Uint8Array | string, options?: { contentType?: string }): Promise<StorageStat>
  get(key: string): Promise<Uint8Array>
  stat(key: string): Promise<StorageStat | null>
  list(prefix?: string): Promise<StorageStat[]>
  /** Returns false when the object was already absent. */
  delete(key: string): Promise<boolean>
}

export type StorageErrorCode = 'INVALID_KEY' | 'NOT_FOUND' | 'IO' | 'AUTH' | 'HTTP'

export class StorageError extends Error {
  readonly code: StorageErrorCode

  constructor(code: StorageErrorCode, message: string) {
    super(message)
    this.name = 'StorageError'
    this.code = code
  }
}

const NUL = '\u0000'

function invalidKey(key: string, reason: string): StorageError {
  // The key itself is echoed (it is caller input, not a credential) so an
  // operator can fix the call; it is JSON-quoted to keep control characters
  // and leading/trailing spaces visible.
  return new StorageError('INVALID_KEY', `invalid storage key ${JSON.stringify(key)}: ${reason}`)
}

/**
 * Reject anything that could escape the backend namespace or alias a
 * different object: keys are relative, `/`-separated, and every segment is a
 * real name.
 *
 * Rejected: empty key, leading `/`, trailing `/` (empty segment), `//`,
 * `.`/`..` segments, `\` and NUL. Returns the key unchanged, so callers can
 * validate and use in one expression.
 */
export function validateStorageKey(key: string): string {
  if (typeof key !== 'string') throw invalidKey(String(key), 'key must be a string')
  if (key === '') throw invalidKey(key, 'key is empty')
  if (key.includes(NUL)) throw invalidKey(key, 'key contains a NUL byte')
  if (key.includes('\\')) throw invalidKey(key, 'key contains a backslash')
  if (key.startsWith('/')) throw invalidKey(key, 'key must be relative')

  for (const segment of key.split('/')) {
    if (segment === '') throw invalidKey(key, 'key contains an empty segment')
    if (segment === '.' || segment === '..') throw invalidKey(key, 'key contains a relative segment')
  }
  return key
}

/**
 * Prefix validation for `list`. A prefix is not an object name: it may be
 * empty, and a trailing `/` is the normal way to scope a listing. The `..`
 * rejection still applies, because a prefix is spliced into request paths.
 */
export function validateStoragePrefix(prefix: string): string {
  if (typeof prefix !== 'string') throw invalidKey(String(prefix), 'prefix must be a string')
  if (prefix === '') return prefix
  if (prefix.includes(NUL)) throw invalidKey(prefix, 'prefix contains a NUL byte')
  if (prefix.includes('\\')) throw invalidKey(prefix, 'prefix contains a backslash')
  if (prefix.startsWith('/')) throw invalidKey(prefix, 'prefix must be relative')

  for (const segment of prefix.split('/')) {
    if (segment === '.' || segment === '..') {
      throw invalidKey(prefix, 'prefix contains a relative segment')
    }
  }
  return prefix
}
