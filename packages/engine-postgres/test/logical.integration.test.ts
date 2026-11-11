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
  withDatabase,
  type ConnectionParams,
  type Executor,
} from '@backup-agent/core'

import {
  buildLogicalBackupPlan,
  buildLogicalRestorePlan,
  probePostgres,
  verifyLogicalRestore,
} from '../src/index'

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

describe('logical backup and restore (integration)', () => {
  it('backs up, restores and verifies table contents', async (context) => {
    const executor = new LocalExecutor()
    const admin = parseDsn(DSN)
    const reachable = await executor.run([...PSQL_ARGS, 'select 1'], {
      env: connectionEnv(admin),
    })
    if (reachable.exitCode !== 0) {
      context.skip(`PostgreSQL not reachable at ${admin.host}:${admin.port}`)
      return
    }

    const sourceDb = `bk_it_src_${Date.now().toString(36)}`
    const workDir = mkdtempSync(join(tmpdir(), 'bk-it-'))
    const dumpPath = join(workDir, 'app.dump')
    const source = withDatabase(admin, sourceDb)

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
        'create table t1(id int primary key, v text); insert into t1 select g, md5(g::text) from generate_series(1, 100) g;',
      )
      await sql(
        executor,
        source,
        'create table t2(id int); insert into t2 select generate_series(1, 50);',
      )

      const instance = await probePostgres(executor, source)
      const ctx = {
        ticketId: asTicketId('tkt_it'),
        mandateId: asMandateId('mnd_it'),
        now: new Date().toISOString(),
        instance,
        configDigest: 'integration',
      }

      const backupPlan = buildLogicalBackupPlan(
        { connection: admin, database: sourceDb, outputPath: dumpPath, format: 'custom' },
        ctx,
      )
      const backup = await runPlan(backupPlan, {
        executor,
        env: connectionEnv(admin),
        systemIdentifier: instance.systemIdentifier,
      })
      expect(backup.status).toBe('succeeded')

      await sql(executor, source, 'drop table t1; drop table t2;')

      const restorePlan = buildLogicalRestorePlan(
        { connection: admin, inputPath: dumpPath, format: 'custom', database: sourceDb },
        ctx,
      )
      const restore = await runPlan(restorePlan, {
        executor,
        env: connectionEnv(admin),
        systemIdentifier: instance.systemIdentifier,
      })
      expect(restore.status).toBe('succeeded')

      expect(await sql(executor, source, 'select count(*) from t1')).toBe('100')
      expect(await sql(executor, source, 'select count(*) from t2')).toBe('50')

      const report = await verifyLogicalRestore(executor, {
        connection: source,
        inputPath: dumpPath,
        format: 'custom',
      })
      expect(report.ok).toBe(true)
      expect(report.tables.find((table) => table.relation === 'public.t1')?.match).toBe(true)
      expect(report.tables.find((table) => table.relation === 'public.t2')?.match).toBe(true)
    } finally {
      await executor.run(['dropdb', `--host=${admin.host}`, `--port=${admin.port}`, `--username=${admin.user}`, '--if-exists', sourceDb], {
        env: connectionEnv(admin),
      })
      rmSync(workDir, { recursive: true, force: true })
    }
  }, 60_000)
})
