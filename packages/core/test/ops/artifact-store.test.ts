import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ArtifactStoreError,
  fsArtifactSink,
  s3ArtifactSink,
  storeArtifact,
  type ArtifactSink,
  type ArtifactSinkInput,
} from '../../src/ops/artifact-store'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix = 'bk-artifact-store-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function input(overrides: Partial<ArtifactSinkInput> = {}): ArtifactSinkInput {
  return {
    targetId: '127.0.0.1:55416/app',
    kind: 'full',
    planId: 'pln_1',
    localPath: '/tmp/a.dump',
    ...overrides,
  }
}

describe('fsArtifactSink.keyFor', () => {
  it('sanitises the target id and is deterministic', () => {
    const root = tempDir()
    const sink = fsArtifactSink({ root })
    const key = sink.keyFor(input())

    expect(key).toBe('127.0.0.1_55416_app/full/pln_1-a.dump')
    expect(sink.keyFor(input())).toBe(key)
    expect(sink.locationFor(key)).toBe(join(resolve(root), key))
    expect(sink.id).toBe(`fs:${resolve(root)}`)
    expect(sink.storage.id).toBe(`fs:${resolve(root)}`)
    expect(sink.keepsLocalCopy).toBe(true)
  })
})

describe('storeArtifact', () => {
  it('copies the file into the root and reports its size and digest', async () => {
    const root = tempDir()
    const staging = tempDir('bk-artifact-staging-')
    const file = join(staging, 'payload.dump')
    writeFileSync(file, 'backup payload')

    const sink = fsArtifactSink({ root })
    const stored = await storeArtifact(sink, input({ localPath: file }))

    const expectedKey = '127.0.0.1_55416_app/full/pln_1-payload.dump'
    expect(stored.key).toBe(expectedKey)
    expect(stored.location).toBe(join(resolve(root), expectedKey))
    expect(stored.location.startsWith(resolve(root))).toBe(true)
    expect(stored.digest).toBe(sha256('backup payload'))
    expect(stored.bytes).toBe(Buffer.byteLength('backup payload'))
    expect(stored.removedLocal).toBe(false)

    // The staging file survives the default sink and the object reads back.
    expect(existsSync(file)).toBe(true)
    const roundTrip = await sink.storage.get(stored.key)
    expect(Buffer.from(roundTrip).toString('utf8')).toBe('backup payload')
  })

  it('removes the staging file when the sink does not keep a local copy', async () => {
    const root = tempDir()
    const staging = tempDir('bk-artifact-staging-')
    const file = join(staging, 'payload.dump')
    writeFileSync(file, 'backup payload')

    const sink = fsArtifactSink({ root, keepsLocalCopy: false })
    const stored = await storeArtifact(sink, input({ localPath: file }))

    expect(stored.removedLocal).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(Buffer.from(await sink.storage.get(stored.key)).toString('utf8')).toBe('backup payload')
  })

  it('refuses a directory and explains which formats to use instead', async () => {
    const root = tempDir()
    const staging = tempDir('bk-artifact-staging-')
    const tree = join(staging, 'base')
    mkdirSync(tree)
    writeFileSync(join(tree, 'PG_VERSION'), '16\n')

    const sink = fsArtifactSink({ root })
    const error = await storeArtifact(sink, input({ localPath: tree })).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ArtifactStoreError)
    expect((error as ArtifactStoreError).code).toBe('DIRECTORY_UNSUPPORTED')
    expect((error as ArtifactStoreError).message).toMatch(/tar|custom/)
    expect(await sink.storage.list()).toHaveLength(0)
  })

  it('throws NOT_FOUND for a missing source and stores nothing', async () => {
    const root = tempDir()
    const staging = tempDir('bk-artifact-staging-')
    const missing = join(staging, 'nope.dump')

    const sink = fsArtifactSink({ root })
    const error = await storeArtifact(sink, input({ localPath: missing })).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ArtifactStoreError)
    expect((error as ArtifactStoreError).code).toBe('NOT_FOUND')
    expect(await sink.storage.list()).toHaveLength(0)
  })

  it('does not duplicate a file that already sits inside the root', async () => {
    const root = tempDir()
    const base = fsArtifactSink({ root })
    // The generated key always prefixes the plan id, so an in-place source only
    // arises when the object name is already the file name (a re-adopted,
    // already-stored artifact). Pin the key to the existing name to drive that
    // branch: the storage, location mapping and `keepsLocalCopy` stay the real
    // fs sink's.
    const sink: ArtifactSink = { ...base, keyFor: () => 'in-place.dump' }

    const localPath = join(resolve(root), 'in-place.dump')
    writeFileSync(localPath, 'already here')

    const before = readFileSync(localPath, 'utf8')
    const stored = await storeArtifact(sink, input({ localPath }))

    expect(stored.key).toBe('in-place.dump')
    expect(stored.location).toBe(localPath)
    expect(stored.removedLocal).toBe(false)
    expect(stored.bytes).toBe(Buffer.byteLength(before))
    expect(stored.digest).toBe(sha256(before))
    expect(Buffer.from(await sink.storage.get(stored.key)).toString('utf8')).toBe(before)
    // Only the in-place object exists; nothing was written beside it.
    expect((await sink.storage.list()).map((entry) => entry.key)).toEqual([stored.key])
  })
})

describe('s3ArtifactSink', () => {
  it('builds keys and locations without touching the network', () => {
    const sink = s3ArtifactSink({
      endpoint: 'http://127.0.0.1:59000',
      region: 'us-east-1',
      bucket: 'backups',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      // A fetch that would fail the test if a call were attempted.
      fetchImpl: () => {
        throw new Error('no network call expected while constructing a sink')
      },
    })

    const key = sink.keyFor(input())
    expect(key).toBe('127.0.0.1_55416_app/full/pln_1-a.dump')
    expect(sink.locationFor(key)).toBe('s3://backups/127.0.0.1_55416_app/full/pln_1-a.dump')
    expect(sink.id).toBe('s3:backups')
    expect(sink.storage.id).toBe('s3:backups')
    expect(sink.keepsLocalCopy).toBe(true)
  })
})
