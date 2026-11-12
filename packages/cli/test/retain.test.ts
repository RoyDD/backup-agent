import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { asArtifactId, asPlanId, asTargetId } from '@backup-agent/core'
import { createSqliteRepository } from '@backup-agent/core/persistence'

import { runCli } from '../src/cli'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function capture(): {
  stdout: string[]
  stderr: string[]
  write: (text: string) => void
  writeError: (text: string) => void
} {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, write: (text) => stdout.push(text), writeError: (text) => stderr.push(text) }
}

interface SeedArtifact {
  id: string
  targetId?: string
  createdAt?: string
  provider?: string
  verifiedLevel?: string | null
  planId?: string | null
  lifecycleState?: 'live' | 'tombstoned'
  tombstonedAt?: string | null
}

interface SeedOptions {
  artifacts: SeedArtifact[]
  asset?: { targetId: string; environment: 'production' | 'staging'; protected?: boolean } | null
  approvals?: Array<{ targetId: string; digest: string; approver: string }>
}

async function seed(options: SeedOptions): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bk-retain-'))
  dirs.push(dir)
  const db = join(dir, 'control.db')
  const repo = await createSqliteRepository({ filename: db })
  await repo.migrate()
  for (const artifact of options.artifacts) {
    await repo.artifacts.insert({
      id: asArtifactId(artifact.id),
      planId: artifact.planId === undefined || artifact.planId === null ? null : asPlanId(artifact.planId),
      targetId: asTargetId(artifact.targetId ?? 'pg-dev'),
      provider: artifact.provider ?? 'native-logical',
      kind: 'full',
      parentId: null,
      path: `/backups/${artifact.targetId ?? 'pg-dev'}/${artifact.id}.dump`,
      sizeBytes: 100,
      checksum: null,
      verifiedLevel: artifact.verifiedLevel ?? null,
      verifiedAt: null,
      protected: false,
      createdAt: artifact.createdAt ?? '2026-01-01T00:00:00.000Z',
      lifecycleState: artifact.lifecycleState ?? 'live',
      tombstonedAt: artifact.tombstonedAt ?? null,
    })
  }
  if (options.asset !== undefined && options.asset !== null) {
    await repo.assets.upsert({
      targetId: asTargetId(options.asset.targetId),
      engine: 'postgres',
      environment: options.asset.environment,
      owner: 'dba',
      criticality: 'high',
      dataClassification: 'internal',
      rpoMinutes: 60,
      rtoMinutes: 120,
      protected: options.asset.protected ?? false,
    })
  }
  for (const approval of options.approvals ?? []) {
    await repo.approvals.record({
      id: `apr_${approval.approver}`,
      targetId: asTargetId(approval.targetId),
      configDigest: approval.digest,
      approver: approval.approver,
      decision: 'approve',
      reason: null,
      createdAt: new Date().toISOString(),
    })
  }
  await repo.close()
  return db
}

async function allArtifacts(db: string): Promise<Array<{ id: string; lifecycleState?: string }>> {
  const repo = await createSqliteRepository({ filename: db })
  try {
    return await repo.artifacts.list({ lifecycle: 'any' })
  } finally {
    await repo.close()
  }
}

async function outboxPending(db: string): Promise<number> {
  const repo = await createSqliteRepository({ filename: db })
  try {
    return await repo.outbox.countByStatus('pending')
  } finally {
    await repo.close()
  }
}

const POLICY_ARGS = ['--daily', '1', '--weekly', '0', '--monthly', '0']

function dailyDryRun(db: string, extra: string[] = []): string[] {
  return ['retain', '--db', db, ...POLICY_ARGS, '--target', 'pg-dev', ...extra]
}

describe('retain dry run', () => {
  it('is a non-mutating decision with a deterministic digest', async () => {
    const db = await seed({
      artifacts: [
        { id: 'art_new', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'art_old', createdAt: '2026-01-10T00:00:00.000Z' },
      ],
    })
    const out = capture()
    const code = await runCli(dailyDryRun(db), {
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })

    expect(code).toBe(0)
    const payload = JSON.parse(out.stdout.join('')) as Record<string, unknown>
    expect(payload['applied']).toBe(false)
    expect(payload['tombstoneOnly']).toBe(true)
    expect(payload['bytesReclaimed']).toBe(0)
    expect(payload['targetId']).toBe('pg-dev')
    expect(payload['digest']).toMatch(/^[0-9a-f]{64}$/)
    expect(payload['remove']).toEqual(['art_old'])
    expect(payload['notice']).toContain('NOT reclaimed')

    // Second dry run is byte-identical: the digest is deterministic.
    const second = capture()
    await runCli(dailyDryRun(db), { stdout: second.write, stderr: second.writeError, env: { USER: 'roy' } })
    expect(second.stdout.join('')).toBe(out.stdout.join(''))

    const rows = await allArtifacts(db)
    expect(rows.map((row) => row.lifecycleState)).toEqual(['live', 'live'])
  })

  it('is per target even without --target', async () => {
    const db = await seed({
      artifacts: [
        { id: 'a_new', targetId: 'pg-a', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'a_old', targetId: 'pg-a', createdAt: '2026-01-10T00:00:00.000Z' },
        { id: 'b_new', targetId: 'pg-b', createdAt: '2026-01-20T00:00:00.000Z' },
        { id: 'b_old', targetId: 'pg-b', createdAt: '2026-01-05T00:00:00.000Z' },
      ],
    })
    const out = capture()
    const code = await runCli(['retain', '--db', db, ...POLICY_ARGS], {
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })
    expect(code).toBe(0)
    const payload = JSON.parse(out.stdout.join('')) as {
      targetId: string | null
      digest: string | null
      targets: Array<{ targetId: string; digest: string; keep: string[]; remove: string[] }>
    }
    expect(payload.targetId).toBeNull()
    expect(payload.digest).toBeNull()
    expect(payload.targets.map((entry) => entry.targetId)).toEqual(['pg-a', 'pg-b'])
    // Each target keeps its own newest artifact; one target's root cannot keep
    // the other target's older artifact alive.
    expect(payload.targets[0]?.keep).toEqual(['a_new'])
    expect(payload.targets[0]?.remove).toEqual(['a_old'])
    expect(payload.targets[1]?.keep).toEqual(['b_new'])
    expect(payload.targets[1]?.remove).toEqual(['b_old'])
    expect(payload.targets[0]?.digest).not.toBe(payload.targets[1]?.digest)
  })
})

describe('retain --apply', () => {
  it('requires --target, --yes and the reviewed digest', async () => {
    const db = await seed({ artifacts: [] })

    const noTarget = capture()
    expect(
      await runCli(['retain', '--db', db, ...POLICY_ARGS, '--apply', '--yes', '--digest', 'x'], {
        stdout: noTarget.write,
        stderr: noTarget.writeError,
        env: { USER: 'roy' },
      }),
    ).toBe(2)
    expect(noTarget.stderr.join('')).toContain('requires exactly one --target')

    const noYes = capture()
    expect(await runCli(dailyDryRun(db, ['--apply', '--digest', 'x']), {
      stdout: noYes.write,
      stderr: noYes.writeError,
      env: { USER: 'roy' },
    })).toBe(2)
    expect(noYes.stderr.join('')).toContain('requires --yes')

    const noDigest = capture()
    expect(await runCli(dailyDryRun(db, ['--apply', '--yes']), {
      stdout: noDigest.write,
      stderr: noDigest.writeError,
      env: { USER: 'roy' },
    })).toBe(2)
    expect(noDigest.stderr.join('')).toContain('requires --digest')
  })

  it('refuses provider-owned candidates for the whole apply with no mutation', async () => {
    const db = await seed({
      artifacts: [
        { id: 'art_new', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'art_pgbr', createdAt: '2026-01-10T00:00:00.000Z', provider: 'pgbackrest' },
      ],
      asset: { targetId: 'pg-dev', environment: 'staging' },
    })
    const dry = capture()
    await runCli(dailyDryRun(db), { stdout: dry.write, stderr: dry.writeError, env: { USER: 'roy' } })
    const digest = (JSON.parse(dry.stdout.join('')) as { digest: string }).digest

    const out = capture()
    const code = await runCli(dailyDryRun(db, ['--apply', '--yes', '--digest', digest]), {
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })
    expect(code).toBe(2)
    const message = out.stderr.join('')
    expect(message).toContain('provider-owned')
    expect(message).toContain('pgbackrest expire')
    expect(message).toContain('No rows were changed')
    expect((await allArtifacts(db)).every((row) => row.lifecycleState === 'live')).toBe(true)
    expect(await outboxPending(db)).toBe(0)
  })

  it('tombstones managed metadata and says bytes were not reclaimed', async () => {
    const db = await seed({
      artifacts: [
        { id: 'art_new', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'art_old', createdAt: '2026-01-10T00:00:00.000Z' },
      ],
      asset: { targetId: 'pg-dev', environment: 'staging' },
    })
    const dry = capture()
    await runCli(dailyDryRun(db), { stdout: dry.write, stderr: dry.writeError, env: { USER: 'roy' } })
    const digest = (JSON.parse(dry.stdout.join('')) as { digest: string }).digest

    const out = capture()
    const code = await runCli(dailyDryRun(db, ['--apply', '--yes', '--digest', digest]), {
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })
    expect(code).toBe(0)
    const payload = JSON.parse(out.stdout.join('')) as Record<string, unknown>
    expect(payload['applied']).toBe(true)
    expect(payload['bytesReclaimed']).toBe(0)
    expect(payload['bytesNotReclaimed']).toBe(100)
    expect(payload['tombstoned']).toEqual(['art_old'])
    expect(payload['notice']).toContain('NOT reclaimed')

    const rows = await allArtifacts(db)
    expect(rows).toHaveLength(2)
    const old = rows.find((row) => row.id === 'art_old')
    expect(old?.lifecycleState).toBe('tombstoned')

    // The normal catalog no longer shows it.
    const catalog = capture()
    expect(await runCli(['catalog', '--db', db], {
      stdout: catalog.write,
      stderr: catalog.writeError,
      env: { USER: 'roy' },
    })).toBe(0)
    const listed = JSON.parse(catalog.stdout.join('')) as Array<{ id: string }>
    expect(listed.map((row) => row.id)).toEqual(['art_new'])
    expect(await outboxPending(db)).toBe(1)
  })

  it('keeps tombstoned artifacts visible to trace', async () => {
    const db = await seed({
      artifacts: [
        {
          id: 'art_old',
          createdAt: '2026-01-10T00:00:00.000Z',
          planId: 'pln_1',
          lifecycleState: 'tombstoned',
          tombstonedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    })
    const out = capture()
    const code = await runCli(['trace', '--db', db, '--plan', 'pln_1'], {
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })
    expect(code).toBe(0)
    const payload = JSON.parse(out.stdout.join('')) as {
      artifacts: Array<{ id: string; lifecycleState: string }>
    }
    expect(payload.artifacts.map((row) => row.id)).toEqual(['art_old'])
    expect(payload.artifacts[0]?.lifecycleState).toBe('tombstoned')
  })

  it('refuses a production target without two approvals and excludes the requester', async () => {
    const db = await seed({
      artifacts: [
        { id: 'art_new', targetId: 'pg-prod', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'art_old', targetId: 'pg-prod', createdAt: '2026-01-10T00:00:00.000Z' },
      ],
      asset: { targetId: 'pg-prod', environment: 'production' },
    })
    const dry = capture()
    await runCli(['retain', '--db', db, ...POLICY_ARGS, '--target', 'pg-prod'], {
      stdout: dry.write,
      stderr: dry.writeError,
      env: { USER: 'roy' },
    })
    const digest = (JSON.parse(dry.stdout.join('')) as { digest: string }).digest

    // Approval by the OS principal is a self-approval and does not count.
    const selfDb = await seed({
      artifacts: [
        { id: 'art_new', targetId: 'pg-prod', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'art_old', targetId: 'pg-prod', createdAt: '2026-01-10T00:00:00.000Z' },
      ],
      asset: { targetId: 'pg-prod', environment: 'production' },
      approvals: [{ targetId: 'pg-prod', digest, approver: 'os:roy' }],
    })
    const denied = capture()
    const deniedCode = await runCli(
      ['retain', '--db', selfDb, ...POLICY_ARGS, '--target', 'pg-prod', '--apply', '--yes', '--digest', digest],
      { stdout: denied.write, stderr: denied.writeError, env: { USER: 'roy' } },
    )
    expect(deniedCode).toBe(2)
    expect(denied.stderr.join('')).toContain('ignored self-approval from requester: os:roy')
    expect((await allArtifacts(selfDb)).every((row) => row.lifecycleState === 'live')).toBe(true)

    // Two other approvers authorize the same decision.
    const approvedDb = await seed({
      artifacts: [
        { id: 'art_new', targetId: 'pg-prod', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'art_old', targetId: 'pg-prod', createdAt: '2026-01-10T00:00:00.000Z' },
      ],
      asset: { targetId: 'pg-prod', environment: 'production' },
      approvals: [
        { targetId: 'pg-prod', digest, approver: 'alice' },
        { targetId: 'pg-prod', digest, approver: 'bob' },
      ],
    })
    const allowed = capture()
    const allowedCode = await runCli(
      ['retain', '--db', approvedDb, ...POLICY_ARGS, '--target', 'pg-prod', '--apply', '--yes', '--digest', digest],
      { stdout: allowed.write, stderr: allowed.writeError, env: { USER: 'roy' } },
    )
    expect(allowedCode).toBe(0)
    const old = (await allArtifacts(approvedDb)).find((row) => row.id === 'art_old')
    expect(old?.lifecycleState).toBe('tombstoned')
  })

  it('refuses when the target has no registered asset', async () => {
    const db = await seed({
      artifacts: [
        { id: 'art_new', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'art_old', createdAt: '2026-01-10T00:00:00.000Z' },
      ],
    })
    const dry = capture()
    await runCli(dailyDryRun(db), { stdout: dry.write, stderr: dry.writeError, env: { USER: 'roy' } })
    const digest = (JSON.parse(dry.stdout.join('')) as { digest: string }).digest

    const out = capture()
    expect(await runCli(dailyDryRun(db, ['--apply', '--yes', '--digest', digest]), {
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })).toBe(2)
    expect(out.stderr.join('')).toContain('asset-unregistered')
    expect((await allArtifacts(db)).every((row) => row.lifecycleState === 'live')).toBe(true)
  })

  it('is not repeatable with a stale digest and not a data loss operation', async () => {
    const db = await seed({
      artifacts: [
        { id: 'art_new', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'art_old', createdAt: '2026-01-10T00:00:00.000Z' },
      ],
      asset: { targetId: 'pg-dev', environment: 'staging' },
    })
    const dry = capture()
    await runCli(dailyDryRun(db), { stdout: dry.write, stderr: dry.writeError, env: { USER: 'roy' } })
    const digest = (JSON.parse(dry.stdout.join('')) as { digest: string }).digest

    const first = capture()
    expect(await runCli(dailyDryRun(db, ['--apply', '--yes', '--digest', digest]), {
      stdout: first.write,
      stderr: first.writeError,
      env: { USER: 'roy' },
    })).toBe(0)

    const second = capture()
    expect(await runCli(dailyDryRun(db, ['--apply', '--yes', '--digest', digest]), {
      stdout: second.write,
      stderr: second.writeError,
      env: { USER: 'roy' },
    })).toBe(2)
    expect(second.stderr.join('')).toContain('candidate-set-changed')
    expect(await outboxPending(db)).toBe(1)
    expect(await allArtifacts(db)).toHaveLength(2)

    // A fresh dry run of the remaining live rows has nothing to tombstone.
    const fresh = capture()
    await runCli(dailyDryRun(db), { stdout: fresh.write, stderr: fresh.writeError, env: { USER: 'roy' } })
    const freshDigest = (JSON.parse(fresh.stdout.join('')) as { digest: string }).digest
    const noop = capture()
    expect(await runCli(dailyDryRun(db, ['--apply', '--yes', '--digest', freshDigest]), {
      stdout: noop.write,
      stderr: noop.writeError,
      env: { USER: 'roy' },
    })).toBe(2)
    expect(noop.stderr.join('')).toContain('nothing-to-tombstone')
    expect(await allArtifacts(db)).toHaveLength(2)
  })
})

describe('asset protection', () => {
  it('keeps every artifact in the dry run and refuses apply', async () => {
    const db = await seed({
      artifacts: [
        { id: 'art_new', createdAt: '2026-01-31T00:00:00.000Z' },
        { id: 'art_old', createdAt: '2026-01-10T00:00:00.000Z' },
      ],
      asset: { targetId: 'pg-dev', environment: 'staging', protected: true },
    })
    const dry = capture()
    expect(await runCli(dailyDryRun(db), {
      stdout: dry.write,
      stderr: dry.writeError,
      env: { USER: 'roy' },
    })).toBe(0)
    const payload = JSON.parse(dry.stdout.join('')) as {
      digest: string
      keep: string[]
      remove: string[]
      reasons: Record<string, string>
      targets: Array<{ targetId: string; assetProtected: boolean; keep: string[]; remove: string[] }>
    }
    expect(payload.keep).toEqual(['art_new', 'art_old'])
    expect(payload.remove).toEqual([])
    expect(payload.reasons['art_new']).toBe('asset-protected')
    expect(payload.reasons['art_old']).toBe('asset-protected')
    expect(payload.targets[0]?.assetProtected).toBe(true)
    expect(payload.targets[0]?.keep).toEqual(['art_new', 'art_old'])

    const out = capture()
    expect(await runCli(dailyDryRun(db, ['--apply', '--yes', '--digest', payload.digest]), {
      stdout: out.write,
      stderr: out.writeError,
      env: { USER: 'roy' },
    })).toBe(2)
    const message = out.stderr.join('')
    expect(message).toContain('asset-protected')
    expect(message).toContain('No rows were changed')
    expect((await allArtifacts(db)).every((row) => row.lifecycleState === 'live')).toBe(true)
    expect(await outboxPending(db)).toBe(0)
  })
})

describe('catalog history', () => {
  it('shows plan-less tombstones only with --history and marks lifecycle', async () => {
    const db = await seed({
      artifacts: [
        { id: 'art_live', createdAt: '2026-01-31T00:00:00.000Z' },
        {
          id: 'art_gone',
          createdAt: '2026-01-10T00:00:00.000Z',
          lifecycleState: 'tombstoned',
          tombstonedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    })

    const liveCatalog = capture()
    expect(await runCli(['catalog', '--db', db, '--format', 'text'], {
      stdout: liveCatalog.write,
      stderr: liveCatalog.writeError,
      env: { USER: 'roy' },
    })).toBe(0)
    const liveText = liveCatalog.stdout.join('')
    expect(liveText).toContain('/backups/pg-dev/art_live.dump')
    expect(liveText).toContain('[live]')
    expect(liveText).not.toContain('art_gone.dump')

    const history = capture()
    expect(await runCli(['catalog', '--db', db, '--history', '--format', 'text'], {
      stdout: history.write,
      stderr: history.writeError,
      env: { USER: 'roy' },
    })).toBe(0)
    const historyText = history.stdout.join('')
    expect(historyText).toContain('/backups/pg-dev/art_gone.dump')
    expect(historyText).toContain('[tombstoned 2026-02-01T00:00:00.000Z]')

    const json = capture()
    expect(await runCli(['catalog', '--db', db, '--history'], {
      stdout: json.write,
      stderr: json.writeError,
      env: { USER: 'roy' },
    })).toBe(0)
    const rows = JSON.parse(json.stdout.join('')) as Array<{ id: string; lifecycleState: string }>
    expect(rows.map((row) => row.id).sort()).toEqual(['art_gone', 'art_live'])
    expect(rows.find((row) => row.id === 'art_gone')?.lifecycleState).toBe('tombstoned')
  })
})
