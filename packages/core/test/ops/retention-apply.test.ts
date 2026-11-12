import { afterEach, describe, expect, it } from 'vitest'

import type { AssetDescriptor } from '../../src/domain/asset'
import {
  asArtifactId,
  asAttemptId,
  asTargetId,
  type ArtifactId,
  type TargetId,
} from '../../src/domain/ids'
import { evaluateAssetRpo } from '../../src/ops/assets'
import {
  planRetention,
  retentionDigest,
  type RetentionPolicy,
} from '../../src/ops/retention'
import { tombstoneRetention, toRetentionArtifact } from '../../src/ops/retention-apply'
import { createSqliteRepository } from '../../src/persistence/sqlite/sqlite-repository'
import { OUTBOX_TOPIC_RUN_AUDIT } from '../../src/persistence/run-lifecycle'
import type { ArtifactRecord, Repository } from '../../src/ports/repository'

const NOW = new Date('2026-02-01T00:00:00.000Z')
const POLICY: RetentionPolicy = { daily: 1, weekly: 0, monthly: 0 }

let repo: Repository | undefined

afterEach(async () => {
  await repo?.close()
  repo = undefined
})

async function open(): Promise<Repository> {
  const created = await createSqliteRepository({ filename: ':memory:' })
  await created.migrate()
  repo = created
  return created
}

interface ArtifactOptions {
  targetId?: string
  createdAt?: string
  provider?: string
  parentId?: ArtifactId | null
  protected?: boolean
  verifiedLevel?: string | null
  verifiedAt?: string | null
  kind?: string
  sizeBytes?: number
  path?: string
}

function artifact(id: string, options: ArtifactOptions = {}): ArtifactRecord {
  const target = options.targetId ?? 'pg-dev'
  return {
    id: asArtifactId(id),
    planId: null,
    targetId: asTargetId(target),
    provider: options.provider ?? 'native-logical',
    kind: options.kind ?? 'full',
    parentId: options.parentId ?? null,
    path: options.path ?? `/backups/${target}/${id}.dump`,
    sizeBytes: options.sizeBytes ?? 100,
    checksum: null,
    verifiedLevel: options.verifiedLevel ?? null,
    verifiedAt: options.verifiedAt ?? null,
    protected: options.protected ?? false,
    createdAt: options.createdAt ?? '2026-01-01T00:00:00.000Z',
  }
}

function asset(
  targetId: string,
  environment: AssetDescriptor['environment'] = 'staging',
  protectedTarget = false,
): AssetDescriptor {
  return {
    targetId: asTargetId(targetId),
    engine: 'postgres',
    environment,
    owner: 'dba',
    criticality: 'high',
    dataClassification: 'internal',
    rpoMinutes: 60,
    rtoMinutes: 120,
    protected: protectedTarget,
  }
}

async function digestFor(
  r: Repository,
  targetId: TargetId,
  policy: RetentionPolicy = POLICY,
): Promise<string> {
  const live = await r.artifacts.list({ targetId })
  const decision = planRetention(live.map(toRetentionArtifact), policy, NOW)
  return retentionDigest({
    targetId,
    policy,
    candidateIds: [...decision.remove].sort(),
  })
}

async function approve(
  r: Repository,
  targetId: TargetId,
  digest: string,
  approver: string,
  createdAt = '2026-01-31T23:30:00.000Z',
): Promise<void> {
  await r.approvals.record({
    id: `apr_${approver}`,
    targetId,
    configDigest: digest,
    approver,
    decision: 'approve',
    reason: null,
    createdAt,
  })
}

async function expectAllLive(r: Repository, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const record = await r.artifacts.get(asArtifactId(id))
    expect(record?.lifecycleState).toBe('live')
    expect(record?.tombstonedAt).toBeNull()
  }
}

describe('tombstoneRetention', () => {
  it('tombstones eligible managed metadata while keeping row, path and lineage', async () => {
    const r = await open()
    await r.assets.upsert(asset('pg-dev'))
    await r.artifacts.insert(artifact('art_new', { createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(artifact('art_mid', { createdAt: '2026-01-20T00:00:00.000Z' }))
    await r.artifacts.insert(artifact('art_old', { createdAt: '2026-01-10T00:00:00.000Z' }))
    await r.lineage.append({
      fromKind: 'attempt',
      fromId: 'att_1',
      toKind: 'artifact',
      toId: 'art_old',
      relation: 'produced',
      createdAt: '2026-01-10T00:00:00.000Z',
    })
    const targetId = asTargetId('pg-dev')
    const digest = await digestFor(r, targetId)

    const outcome = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })

    expect(outcome.kind).toBe('tombstoned')
    if (outcome.kind !== 'tombstoned') return
    expect(outcome.summary.artifactIds).toEqual(['art_mid', 'art_old'])
    expect(outcome.summary.bytesNotReclaimed).toBe(200)
    expect(outcome.summary.providerClasses).toEqual({
      managed: 2,
      'provider-owned': 0,
      unknown: 0,
    })

    const tombstone = await r.artifacts.get(asArtifactId('art_old'))
    expect(tombstone?.lifecycleState).toBe('tombstoned')
    expect(tombstone?.tombstonedAt).toBe(NOW.toISOString())
    expect(tombstone?.path).toBe('/backups/pg-dev/art_old.dump')
    expect(tombstone?.sizeBytes).toBe(100)

    // Normal catalog reads ignore tombstones; history reads keep them.
    expect((await r.artifacts.list({ targetId })).map((row) => row.id)).toEqual(['art_new'])
    expect(await r.artifacts.list({ targetId, lifecycle: 'any' })).toHaveLength(3)
    expect((await r.artifacts.list({ targetId, lifecycle: 'tombstoned' })).map((row) => row.id).sort()).toEqual([
      'art_mid',
      'art_old',
    ])

    // Lineage survives the tombstone so trace can still resolve the artifact.
    expect(await r.lineage.listFor('attempt', 'att_1')).toHaveLength(1)

    const pending = await r.outbox.countByStatus('pending')
    expect(pending).toBe(1)
  })

  it('appends one retained audit event describing the tombstone', async () => {
    const r = await open()
    await r.assets.upsert(asset('pg-dev'))
    await r.artifacts.insert(artifact('art_new', { createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(artifact('art_old', { createdAt: '2026-01-10T00:00:00.000Z' }))
    const targetId = asTargetId('pg-dev')
    const digest = await digestFor(r, targetId)

    await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })

    const batch = await r.outbox.claim({ now: NOW.toISOString(), limit: 10, leaseMs: 60_000 })
    expect(batch).toHaveLength(1)
    expect(batch[0]?.topic).toBe(OUTBOX_TOPIC_RUN_AUDIT)
    const payload = batch[0]?.payload as Record<string, unknown>
    expect(payload['event']).toBe('retention.tombstoned')
    expect(payload['artifactIds']).toEqual(['art_old'])
    expect(payload['bytesNotReclaimed']).toBe(100)
    expect(payload['tombstoneOnly']).toBe(true)
  })

  it('refuses when the candidate set changed and reports the new digest', async () => {
    const r = await open()
    await r.assets.upsert(asset('pg-dev'))
    await r.artifacts.insert(artifact('art_new', { createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(artifact('art_old', { createdAt: '2026-01-10T00:00:00.000Z' }))
    const targetId = asTargetId('pg-dev')
    const reviewed = await digestFor(r, targetId)
    expect(reviewed.length).toBeGreaterThan(0)

    // A new backup lands between the dry run and the apply: the decision moved.
    await r.artifacts.insert(artifact('art_newer', { createdAt: '2026-01-31T12:00:00.000Z' }))
    const outcome = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: reviewed,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })

    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('candidate-set-changed')
    expect(outcome.digest).toBeDefined()
    expect(outcome.digest).not.toBe(reviewed)
    expect(outcome.message).toContain('No rows were changed')
    await expectAllLive(r, ['art_new', 'art_newer', 'art_old'])
    expect(await r.outbox.countByStatus('pending')).toBe(0)
  })

  it('refuses without --yes', async () => {
    const r = await open()
    await r.assets.upsert(asset('pg-dev'))
    await r.artifacts.insert(artifact('art_new', { createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(artifact('art_old', { createdAt: '2026-01-10T00:00:00.000Z' }))
    const targetId = asTargetId('pg-dev')
    const digest = await digestFor(r, targetId)

    const outcome = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: false,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })

    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('confirmation-required')
    await expectAllLive(r, ['art_new', 'art_old'])
  })

  it('refuses when the target has no registered asset', async () => {
    const r = await open()
    await r.artifacts.insert(artifact('art_new', { createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(artifact('art_old', { createdAt: '2026-01-10T00:00:00.000Z' }))
    const targetId = asTargetId('pg-dev')
    const digest = await digestFor(r, targetId)

    const outcome = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })

    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('asset-unregistered')
    expect(outcome.message).toContain('bkagent asset-set')
    await expectAllLive(r, ['art_new', 'art_old'])
  })

  it('requires two distinct approvals on production and excludes the requester', async () => {
    const r = await open()
    await r.assets.upsert(asset('pg-prod', 'production'))
    await r.artifacts.insert(artifact('art_new', { targetId: 'pg-prod', createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(artifact('art_old', { targetId: 'pg-prod', createdAt: '2026-01-10T00:00:00.000Z' }))
    const targetId = asTargetId('pg-prod')
    const digest = await digestFor(r, targetId)

    // The requester and the OS principal cannot approve their own tombstone.
    await approve(r, targetId, digest, 'alice')
    await approve(r, targetId, digest, 'os:roy')

    const denied = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })
    expect(denied.kind).toBe('refused')
    if (denied.kind !== 'refused') return
    expect(denied.reason).toBe('approvals-insufficient')
    expect(denied.message).toContain('ignored self-approval from requester: alice')
    await expectAllLive(r, ['art_new', 'art_old'])

    await approve(r, targetId, digest, 'bob')
    const stillDenied = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })
    expect(stillDenied.kind).toBe('refused')
    await expectAllLive(r, ['art_new', 'art_old'])

    await approve(r, targetId, digest, 'carol')
    const allowed = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })
    expect(allowed.kind).toBe('tombstoned')
    if (allowed.kind !== 'tombstoned') return
    expect(allowed.summary.approvals).toEqual(['bob', 'carol'])
    expect((await r.artifacts.list({ targetId })).map((row) => row.id)).toEqual(['art_new'])
  })

  it('refuses the whole apply for provider-owned artifacts and names the provider command', async () => {
    const r = await open()
    await r.assets.upsert(asset('pg-dev'))
    await r.artifacts.insert(artifact('art_new', { createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(
      artifact('art_pgbr', {
        createdAt: '2026-01-10T00:00:00.000Z',
        provider: 'pgbackrest',
      }),
    )
    const targetId = asTargetId('pg-dev')
    const digest = await digestFor(r, targetId)

    const outcome = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })

    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('provider-owned')
    expect(outcome.message).toContain('pgbackrest expire')
    expect(outcome.message).toContain('No rows were changed')
    await expectAllLive(r, ['art_new', 'art_pgbr'])
    expect(await r.outbox.countByStatus('pending')).toBe(0)
  })

  it('refuses unknown providers instead of guessing ownership', async () => {
    const r = await open()
    await r.assets.upsert(asset('pg-dev'))
    await r.artifacts.insert(artifact('art_new', { createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(
      artifact('art_barman', {
        createdAt: '2026-01-10T00:00:00.000Z',
        provider: 'barman',
      }),
    )
    const targetId = asTargetId('pg-dev')
    const digest = await digestFor(r, targetId)

    const outcome = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })

    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.reason).toBe('unknown-provider')
    expect(outcome.message).toContain('no retention command is known')
    await expectAllLive(r, ['art_new', 'art_barman'])
  })

  it('is a no-op second time when the reviewed candidate set is gone', async () => {
    const r = await open()
    await r.assets.upsert(asset('pg-dev'))
    await r.artifacts.insert(artifact('art_new', { createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(artifact('art_old', { createdAt: '2026-01-10T00:00:00.000Z' }))
    const targetId = asTargetId('pg-dev')
    const digest = await digestFor(r, targetId)

    const first = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })
    expect(first.kind).toBe('tombstoned')

    const second = await tombstoneRetention(r, {
      targetId,
      policy: POLICY,
      expectedDigest: digest,
      confirmed: true,
      requester: 'alice',
      osPrincipal: 'os:roy',
      now: NOW,
    })
    expect(second.kind).toBe('refused')
    if (second.kind !== 'refused') return
    expect(second.reason).toBe('candidate-set-changed')
    expect(second.digest).not.toBe(digest)
    expect(await r.outbox.countByStatus('pending')).toBe(1)
    expect(await r.artifacts.list({ targetId, lifecycle: 'any' })).toHaveLength(2)
  })

  it('refuses any tombstone for an asset-protected target even with a stale digest', async () => {
    const r = await open()
    await r.assets.upsert(asset('pg-dev', 'staging', true))
    await r.artifacts.insert(artifact('art_new', { createdAt: '2026-01-31T00:00:00.000Z' }))
    await r.artifacts.insert(artifact('art_old', { createdAt: '2026-01-10T00:00:00.000Z' }))
    const targetId = asTargetId('pg-dev')
    const valid = await digestFor(r, targetId)
    const stale = 'f'.repeat(64)

    for (const expectedDigest of [stale, valid]) {
      const outcome = await tombstoneRetention(r, {
        targetId,
        policy: POLICY,
        expectedDigest,
        confirmed: true,
        requester: 'alice',
        osPrincipal: 'os:roy',
        now: NOW,
      })
      expect(outcome.kind).toBe('refused')
      if (outcome.kind !== 'refused') continue
      expect(outcome.reason).toBe('asset-protected')
      expect(outcome.message).toContain('asset-protected')
      expect(outcome.message).toContain('No rows were changed')
    }

    await expectAllLive(r, ['art_new', 'art_old'])
    expect(await r.outbox.countByStatus('pending')).toBe(0)
  })

  it('hides tombstoned artifacts from RPO while keeping them addressable', async () => {
    const r = await open()
    await r.artifacts.insert(
      artifact('art_verified', {
        createdAt: '2026-01-10T00:00:00.000Z',
        verifiedLevel: 'V2',
        verifiedAt: '2026-01-10T01:00:00.000Z',
      }),
    )
    const targetId = asTargetId('pg-dev')

    const tombstone = await r.artifacts.tombstone([asArtifactId('art_verified')], NOW.toISOString())
    expect(tombstone.tombstoned).toEqual([asArtifactId('art_verified')])

    const live = await r.artifacts.list({ targetId })
    expect(live).toHaveLength(0)
    expect(evaluateAssetRpo([asset('pg-dev')], live, NOW)[0]?.lastVerifiedAt).toBeNull()

    // History reads still prove what was verified before the tombstone.
    const history = await r.artifacts.list({ targetId, lifecycle: 'any' })
    expect(evaluateAssetRpo([asset('pg-dev')], history, NOW)[0]?.lastVerifiedAt).toBe(
      '2026-01-10T01:00:00.000Z',
    )
    expect((await r.artifacts.get(asArtifactId('art_verified')))?.lifecycleState).toBe('tombstoned')
  })
})

describe('per-target retention', () => {
  it('keeps each target’s own GFS roots', () => {
    const artifacts = [
      { id: 'a-new', targetId: 'pg-a', parentId: null, createdAt: '2026-01-31T00:00:00.000Z', kind: 'full' },
      { id: 'a-old', targetId: 'pg-a', parentId: null, createdAt: '2026-01-10T00:00:00.000Z', kind: 'full' },
      { id: 'b-new', targetId: 'pg-b', parentId: null, createdAt: '2026-01-20T00:00:00.000Z', kind: 'full' },
      { id: 'b-old', targetId: 'pg-b', parentId: null, createdAt: '2026-01-05T00:00:00.000Z', kind: 'full' },
    ]
    const decision = planRetention(artifacts, { daily: 1, weekly: 0, monthly: 0 }, NOW)
    expect(decision.keep).toEqual(new Set(['a-new', 'b-new']))
    expect(decision.remove).toEqual(new Set(['a-old', 'b-old']))
  })

  it('keeps the latest V2/V3 Verified Restore Point per target and its ancestors', () => {
    const artifacts = [
      {
        id: 'a-v2',
        targetId: 'pg-a',
        parentId: 'a-full',
        createdAt: '2026-01-01T00:00:00.000Z',
        kind: 'incr',
        verifiedLevel: 'V2',
        verifiedAt: '2026-01-02T00:00:00.000Z',
      },
      { id: 'a-full', targetId: 'pg-a', parentId: null, createdAt: '2025-12-31T00:00:00.000Z', kind: 'full' },
      { id: 'a-new', targetId: 'pg-a', parentId: null, createdAt: '2026-01-31T00:00:00.000Z', kind: 'full' },
      {
        id: 'b-v3',
        targetId: 'pg-b',
        parentId: null,
        createdAt: '2025-06-01T00:00:00.000Z',
        kind: 'full',
        verifiedLevel: 'V3',
        verifiedAt: '2025-06-02T00:00:00.000Z',
      },
      { id: 'b-new', targetId: 'pg-b', parentId: null, createdAt: '2026-01-31T00:00:00.000Z', kind: 'full' },
    ]
    const decision = planRetention(artifacts, { daily: 1, weekly: 0, monthly: 0 }, NOW)

    expect(decision.keep.has('a-v2')).toBe(true)
    expect(decision.keep.has('a-full')).toBe(true)
    expect(decision.reasons.get('a-v2')).toBe('vrp-latest')
    expect(decision.reasons.get('a-full')).toBe('ancestor-of:a-v2')
    expect(decision.keep.has('b-v3')).toBe(true)
    expect(decision.reasons.get('b-v3')).toBe('vrp-latest')
    expect(decision.remove).toEqual(new Set())
  })

  it('keeps every artifact of an asset-protected target with asset-protected reason', () => {
    const artifacts = [
      { id: 'a-new', targetId: 'pg-a', parentId: null, createdAt: '2026-01-31T00:00:00.000Z', kind: 'full' },
      { id: 'a-old', targetId: 'pg-a', parentId: null, createdAt: '2026-01-10T00:00:00.000Z', kind: 'full' },
      { id: 'b-new', targetId: 'pg-b', parentId: null, createdAt: '2026-01-31T00:00:00.000Z', kind: 'full' },
      { id: 'b-old', targetId: 'pg-b', parentId: null, createdAt: '2026-01-10T00:00:00.000Z', kind: 'full' },
    ]
    const decision = planRetention(artifacts, { daily: 1, weekly: 0, monthly: 0 }, NOW, {
      protectedTargets: ['pg-a'],
    })
    expect(decision.keep.has('a-new')).toBe(true)
    expect(decision.keep.has('a-old')).toBe(true)
    expect(decision.reasons.get('a-old')).toBe('asset-protected')
    // Protection is target-scoped: pg-b still follows GFS.
    expect(decision.keep.has('b-new')).toBe(true)
    expect(decision.remove).toEqual(new Set(['b-old']))
  })

  it('digests only the target, policy and sorted candidate ids', () => {
    const base = { targetId: 'pg-a', policy: POLICY }
    const one = retentionDigest({ ...base, candidateIds: ['b', 'a'] })
    const reordered = retentionDigest({ ...base, candidateIds: ['a', 'b'] })
    expect(one).toBe(reordered)
    expect(retentionDigest({ ...base, candidateIds: ['a'] })).not.toBe(one)
    expect(
      retentionDigest({ ...base, targetId: 'pg-b', candidateIds: ['a', 'b'] }),
    ).not.toBe(one)
    expect(
      retentionDigest({ ...base, policy: { daily: 2, weekly: 0, monthly: 0 }, candidateIds: ['a', 'b'] }),
    ).not.toBe(one)
  })
})
