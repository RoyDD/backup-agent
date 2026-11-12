import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  LocalExecutor,
  asMandateId,
  asTicketId,
  connectionEnv,
  parseDsn,
  runPlan,
  validatePlan,
  withDatabase,
  type ConnectionParams,
  type Executor,
} from '@backup-agent/core'

import { buildLogicalBackupPlan, probePostgres } from '../src/index'

const DSN =
  process.env.BK_TEST_DSN ?? 'postgres://postgres:verify_pw@127.0.0.1:55416/postgres'
const PSQL_ARGS = ['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c']

async function sql(
  executor: Executor,
  connection: ConnectionParams,
  statement: string,
): Promise<string> {
  const result = await executor.run([...PSQL_ARGS, statement], {
    env: connectionEnv(connection),
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim())
  return result.stdout.trim()
}

describe('prompt-injection drill (integration)', () => {
  it('never turns database comments or file names into commands', async (context) => {
    const executor = new LocalExecutor()
    const admin = parseDsn(DSN)
    const reachable = await executor.run([...PSQL_ARGS, 'select 1'], {
      env: connectionEnv(admin),
    })
    if (reachable.exitCode !== 0) {
      context.skip(`PostgreSQL not reachable at ${admin.host}:${admin.port}`)
      return
    }

    const sourceDb = `bk_inj_${Date.now().toString(36)}`
    const source = withDatabase(admin, sourceDb)
    const workDir = mkdtempSync(join(tmpdir(), 'bk-inj-'))
    const dumpPath = join(workDir, 'safe.dump')

    try {
      const created = await executor.run(
        [
          'createdb',
          `--host=${admin.host}`,
          `--port=${admin.port}`,
          `--username=${admin.user}`,
          '--maintenance-db=postgres',
          sourceDb,
        ],
        { env: connectionEnv(admin) },
      )
      expect(created.exitCode).toBe(0)

      await sql(
        executor,
        source,
        "create table notes(id int primary key, body text); insert into notes values (1, 'hello');",
      )
      await sql(
        executor,
        source,
        "comment on table notes is '\"; DROP DATABASE postgres; -- $(rm -rf /)';",
      )

      const instance = await probePostgres(executor, source)
      const ctx = {
        ticketId: asTicketId('tkt_inj'),
        mandateId: asMandateId('mnd_inj'),
        now: new Date().toISOString(),
        instance,
        configDigest: 'injection',
      }
      const plan = buildLogicalBackupPlan(
        { connection: admin, database: sourceDb, outputPath: dumpPath, format: 'custom' },
        ctx,
      )

      const argv = plan.steps.flatMap((step) => step.argv ?? [])
      expect(argv.join(' ')).not.toContain('DROP DATABASE')
      expect(argv.join(' ')).not.toContain('rm -rf')

      const backup = await runPlan(plan, {
        executor,
        env: connectionEnv(admin),
        systemIdentifier: instance.systemIdentifier,
      })
      expect(backup.status).toBe('succeeded')

      // The injected text did not execute: database and row still exist.
      expect(await sql(executor, source, 'select count(*) from notes')).toBe('1')
      expect(
        await sql(executor, admin, "select count(*) from pg_database where datname = 'postgres'"),
      ).toBe('1')

      // A file name carrying shell syntax is rejected at plan validation.
      const maliciousPath = join(workDir, 'evil;rm -rf /.dump')
      const malicious = buildLogicalBackupPlan(
        { connection: admin, database: sourceDb, outputPath: maliciousPath, format: 'custom' },
        ctx,
      )
      const issues = validatePlan(malicious, {
        now: new Date().toISOString(),
        declaredCapabilities: new Set(['logical', 'catalog']),
        requiredCapabilities: ['logical'],
        mandate: {
          id: malicious.mandateId,
          ticketId: malicious.ticketId,
          principalId: 'user:test',
          scope: 'logical',
          policyVersion: '1',
          allowedRisk: 'destructive',
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
        resources: { availableBytes: Number.MAX_SAFE_INTEGER, maxConcurrency: 4 },
        policyValid: true,
      })
      expect(issues.some((issue) => issue.message.includes('shell metacharacters'))).toBe(true)
    } finally {
      await executor.run(
        [
          'dropdb',
          `--host=${admin.host}`,
          `--port=${admin.port}`,
          `--username=${admin.user}`,
          '--if-exists',
          sourceDb,
        ],
        { env: connectionEnv(admin) },
      )
      rmSync(workDir, { recursive: true, force: true })
    }
  }, 60_000)
})
