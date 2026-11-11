import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
} from '@backup-agent/core'

import { buildPhysicalBackupPlan, probePostgres } from '../src/index'

const DSN =
  process.env.BK_TEST_DSN ?? 'postgres://postgres:verify_pw@127.0.0.1:55416/postgres'

describe('physical backup (integration)', () => {
  it('takes and verifies a base backup', async (context) => {
    const executor = new LocalExecutor()
    const connection = parseDsn(DSN)
    const reachable = await executor.run(
      ['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', 'select 1'],
      { env: connectionEnv(connection) },
    )
    if (reachable.exitCode !== 0) {
      context.skip(`PostgreSQL not reachable at ${connection.host}:${connection.port}`)
      return
    }

    const workDir = mkdtempSync(join(tmpdir(), 'bk-physical-'))
    const outputPath = join(workDir, 'base')
    try {
      const instance = await probePostgres(executor, connection)
      const plan = buildPhysicalBackupPlan(
        { connection, outputPath, format: 'plain' },
        {
          ticketId: asTicketId('tkt_it'),
          mandateId: asMandateId('mnd_it'),
          now: new Date().toISOString(),
          instance,
          configDigest: 'integration',
        },
      )

      const result = await runPlan(plan, {
        executor,
        env: connectionEnv(connection),
        systemIdentifier: instance.systemIdentifier,
      })
      expect(result.status).toBe('succeeded')
      expect(existsSync(join(outputPath, 'backup_manifest'))).toBe(true)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }, 60_000)
})
