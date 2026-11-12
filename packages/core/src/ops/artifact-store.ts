import { readFile, rm, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import type { Storage } from '../ports/storage'
import { FsStorage } from '../storage/fs-storage'
import { S3Storage, type S3StorageOptions } from '../storage/s3-storage'
import { digestArtifact } from './artifact-digest'

export type ArtifactStoreErrorCode = 'DIRECTORY_UNSUPPORTED' | 'NOT_FOUND' | 'IO'

export class ArtifactStoreError extends Error {
  readonly code: ArtifactStoreErrorCode

  constructor(code: ArtifactStoreErrorCode, message: string) {
    super(message)
    this.name = 'ArtifactStoreError'
    this.code = code
  }
}

export interface ArtifactSinkInput {
  readonly targetId: string
  readonly kind: string
  readonly planId: string
  /** Local staging file, as produced by the provider tool. */
  readonly localPath: string
}

/**
 * Where artifact bytes are stored, and how the catalog row names them.
 *
 * A sink is a policy object, not a transport: the `Storage` port does the
 * writing, and the sink only decides the object key and the location string
 * recorded on the artifact row. That keeps the catalog backend-agnostic (an
 * `s3://` location is as valid as an absolute path) without teaching the
 * deterministic core anything about S3 signing or fs layouts.
 */
export interface ArtifactSink {
  /** Display identity, e.g. `fs:/srv/backups` or `s3:bucket`. */
  readonly id: string
  readonly storage: Storage
  /** When false, the local staging file is removed after a successful store. */
  readonly keepsLocalCopy: boolean
  keyFor(input: ArtifactSinkInput): string
  /** Location recorded on the artifact row (`/abs/path` for fs, `s3://bucket/key` for s3). */
  locationFor(key: string): string
}

export interface StoredArtifact {
  readonly location: string
  readonly key: string
  readonly bytes: number
  readonly digest: string
  /** True only when the staging file was actually unlinked. */
  readonly removedLocal: boolean
}

/** s3 object keys have no `..` semantics, but the fs root does. */
function hasParentSegment(key: string): boolean {
  return key.includes('..')
}

/**
 * One key segment: lowercase, every run of characters outside
 * `[a-z0-9._-]` collapsed to a single `_`, edges trimmed, `target` when empty.
 *
 * Target ids are operator- and inventory-supplied (`127.0.0.1:55416/app`), so
 * the mapping must be total and stable rather than validating the input.
 */
function slug(value: string): string {
  const mapped = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return mapped === '' ? 'target' : mapped
}

/**
 * `<target>/<kind>/<planId>-<basename>`.
 *
 * `planId` and the basename travel verbatim (they are already opaque ids and a
 * file name the provider chose); the assembled key is rejected if it still
 * contains `..`, because a sink root is a real directory and a key is spliced
 * into it as a relative path.
 */
function artifactKey(input: ArtifactSinkInput): string {
  const key = `${slug(input.targetId)}/${slug(input.kind)}/${input.planId}-${basename(input.localPath)}`
  if (hasParentSegment(key)) {
    throw new ArtifactStoreError('IO', `artifact key ${JSON.stringify(key)} contains a parent segment`)
  }
  return key
}

export function fsArtifactSink(options: {
  root: string
  kind?: 'fs' | 'nfs'
  keepsLocalCopy?: boolean
}): ArtifactSink {
  const root = resolve(options.root)
  const kind = options.kind ?? 'fs'
  return {
    id: `${kind}:${root}`,
    storage: new FsStorage({ root, kind }),
    keepsLocalCopy: options.keepsLocalCopy ?? true,
    keyFor: artifactKey,
    // FsStorage resolves the same way, so the recorded location is the real path.
    locationFor: (key) => join(root, key),
  }
}

export function s3ArtifactSink(options: S3StorageOptions & { keepsLocalCopy?: boolean }): ArtifactSink {
  const { keepsLocalCopy, ...storageOptions } = options
  return {
    id: `s3:${options.bucket}`,
    // Constructing the storage performs no network call; the first one happens
    // on `put`, so building a sink is safe during plan building.
    storage: new S3Storage(storageOptions),
    keepsLocalCopy: keepsLocalCopy ?? true,
    keyFor: artifactKey,
    locationFor: (key) => `s3://${options.bucket}/${key}`,
  }
}

function isErrno(err: unknown, ...codes: string[]): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && codes.includes(code)
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    return code === undefined ? err.message : `${code}: ${err.message}`
  }
  return String(err)
}

/**
 * Copies one staging file into the sink's storage and describes the result.
 *
 * The source is unlinked only after a successful `put` and only when the sink
 * does not keep local copies; a failed copy leaves the staging file intact so
 * the caller can retry. Directories are refused rather than walked: a
 * `pg_basebackup -Fp`/`pg_dump -Fd` tree has no single object identity, so
 * callers must use tar or custom formats.
 */
export async function storeArtifact(
  sink: ArtifactSink,
  input: ArtifactSinkInput,
): Promise<StoredArtifact> {
  let info
  try {
    info = await stat(input.localPath)
  } catch (err) {
    if (isErrno(err, 'ENOENT', 'ENOTDIR')) {
      throw new ArtifactStoreError('NOT_FOUND', `artifact source not found: ${input.localPath}`)
    }
    throw new ArtifactStoreError('IO', `stat ${input.localPath} failed: ${describe(err)}`)
  }

  if (info.isDirectory()) {
    throw new ArtifactStoreError(
      'DIRECTORY_UNSUPPORTED',
      'directory artifacts (pg_basebackup -Fp, pg_dump -Fd) cannot be stored yet; use tar/custom formats',
    )
  }
  if (!info.isFile()) {
    throw new ArtifactStoreError('IO', `artifact source is not a regular file: ${input.localPath}`)
  }

  const key = sink.keyFor(input)
  const location = sink.locationFor(key)
  // A staging file that already sits where the sink would put it is the same
  // bytes; copying it onto itself would only churn the file.
  const alreadyInPlace = resolve(location) === resolve(input.localPath)

  let digest: string
  if (alreadyInPlace) {
    const local = digestArtifact(input.localPath)
    if (local === null) {
      throw new ArtifactStoreError('IO', `failed to digest ${input.localPath}`)
    }
    digest = local
  } else {
    let bytes: Uint8Array
    try {
      bytes = await readFile(input.localPath)
    } catch (err) {
      throw new ArtifactStoreError('IO', `read ${input.localPath} failed: ${describe(err)}`)
    }

    const stored = await sink.storage.put(key, bytes)
    // fs hashes the bytes it wrote; s3 only reports an ETag, which is a digest
    // of the upload but not necessarily sha256, so fall back to the local hash.
    const local = stored.digest ?? digestArtifact(input.localPath)
    if (local === null) {
      throw new ArtifactStoreError('IO', `failed to digest ${input.localPath}`)
    }
    digest = local
  }

  let removedLocal = false
  if (!sink.keepsLocalCopy && !alreadyInPlace) {
    try {
      await rm(input.localPath)
      removedLocal = true
    } catch {
      // The bytes are already durable in storage; a leftover staging file is
      // reported, never treated as a store failure.
      removedLocal = false
    }
  }

  return { location, key, bytes: info.size, digest, removedLocal }
}
