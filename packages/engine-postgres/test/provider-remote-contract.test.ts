import { describe, expect, it } from 'vitest'

import {
  asMandateId,
  asTicketId,
  ProviderOperationError,
  type ConnectionParams,
  type Executor,
  type InstanceInfo,
  type PlanBuildContext,
} from '@backup-agent/core'
import { FakeExecutor } from '@backup-agent/core/testkit'

import {
  defineProviderContractSuite,
  type ProviderContractExecutorOptions,
} from '../../core/test/contract/provider-contract.suite'
import { POSTGRES_ENGINE_DESCRIPTOR } from '../src/descriptor'
import { pgbackrestProvider, type PgBackRestProviderRequests } from '../src/pgbackrest'
import { walgProvider, type WalGProviderRequests } from '../src/walg'

/**
 * Provider contract for the two repository-owning adapters. Both wrap the pure
 * plan builders from `pgbackrest.ts` / `walg.ts`, so the shared §11 suite is the
 * only acceptance surface: descriptor consistency, plan/verb dispatch equality,
 * fail-closed preflight and the typed refusal for the verbs they lack.
 */

const INSTANCE: InstanceInfo = {
  version: 'PostgreSQL 16.15',
  serverVersionNum: 160015,
  currentUser: 'backup',
  currentDatabase: 'app',
  databaseOid: '16384',
  inRecovery: false,
  systemIdentifier: '7421000000000000001',
  walLevel: 'replica',
  archiveMode: 'on',
  databases: ['app'],
  executionSite: 'fake',
  warnings: [],
}

const CONTEXT: PlanBuildContext = {
  ticketId: asTicketId('tkt_contract'),
  mandateId: asMandateId('mnd_contract'),
  now: '2026-01-01T00:00:00.000Z',
  instance: INSTANCE,
  configDigest: 'cfg-contract',
  // A repository-owning adapter may run its verbs on a remote host; the plans
  // it produces must record that transport.
  transport: {
    kind: 'ssh',
    host: 'dba@db1.internal',
    knownHostsFile: '/etc/backup-agent/known_hosts',
  },
}

const VALIDATION = {
  now: CONTEXT.now,
  declaredCapabilities: POSTGRES_ENGINE_DESCRIPTOR.capabilities,
  requiredCapabilities: [],
  resources: { availableBytes: Number.MAX_SAFE_INTEGER, maxConcurrency: 8 },
  policyValid: true,
}

const PGBACKREST_CONFIG = '/tmp/pgbr.conf'

/** Two backups in one stanza, deliberately out of order in the payload. */
const PGBACKREST_INFO = [
  {
    name: 'main',
    status: { code: 0, message: 'ok' },
    backup: [
      {
        label: '20260101-010101F',
        type: 'full',
        timestamp: { start: 1767229261, stop: 1767232861 },
        info: { size: 1073741824 },
      },
      {
        label: '20260102-010101F',
        type: 'full',
        timestamp: { start: 1767315661, stop: 1767319261 },
        info: { size: 2147483648 },
      },
    ],
  },
]

/**
 * Tool probes answer `--version`; `pgbackrest info` answers with the canned
 * catalog above. Everything else succeeds with empty output, because the suite
 * only executes preflight and catalog.
 */
function executorFor(options: ProviderContractExecutorOptions = {}): Executor {
  const toolVersions = options.toolVersions ?? {}
  const missingTools = new Set(options.missingTools ?? [])
  return new FakeExecutor({
    defaultHandler: (cmd) => {
      if (cmd[1] === '--version') {
        const tool = cmd[0] ?? ''
        if (missingTools.has(tool)) {
          return { exitCode: 127, stdout: '', stderr: `${tool}: command not found` }
        }
        return { exitCode: 0, stdout: `${tool} (PostgreSQL) ${toolVersions[tool] ?? '99.0'}\n` }
      }
      if (cmd[0] === 'pgbackrest' && cmd[1] === 'info') {
        return { exitCode: 0, stdout: JSON.stringify(PGBACKREST_INFO) }
      }
      return { exitCode: 0, stdout: '' }
    },
  })
}

const pgbackrestRequests: PgBackRestProviderRequests = {
  // The existing builders key on `configPath`; only the new catalog/verify
  // request shapes use `config` (see §11 adapter request map).
  backup: { configPath: PGBACKREST_CONFIG, stanza: 'main', type: 'full' },
  restore: { configPath: PGBACKREST_CONFIG, stanza: 'main', dataDirectory: '/tmp/restore' },
  verify: { config: PGBACKREST_CONFIG, stanza: 'main' },
  prune: { configPath: PGBACKREST_CONFIG, stanza: 'main' },
  catalog: { config: PGBACKREST_CONFIG, stanza: 'main' },
}

const walgRequests: WalGProviderRequests = {
  backup: { dataDirectory: '/var/lib/postgresql/16/main' },
  restore: { dataDirectory: '/tmp/restore' },
  verify: undefined,
  prune: { retainFull: 2 },
  catalog: undefined,
}

defineProviderContractSuite<PgBackRestProviderRequests>('pgbackrest (remote repository)', {
  engine: POSTGRES_ENGINE_DESCRIPTOR,
  adapter: pgbackrestProvider,
  context: CONTEXT,
  validation: VALIDATION,
  supported: ['backup', 'restore', 'verify', 'prune'],
  requests: pgbackrestRequests,
  executorFor,
})

defineProviderContractSuite<WalGProviderRequests>('wal-g (remote repository)', {
  engine: POSTGRES_ENGINE_DESCRIPTOR,
  adapter: walgProvider,
  context: CONTEXT,
  validation: VALIDATION,
  supported: ['backup', 'restore', 'prune'],
  requests: walgRequests,
  executorFor,
})

describe('plan transport', () => {
  it('carries the context transport on each adapter backup plan', () => {
    const plans = [
      pgbackrestProvider.backup(pgbackrestRequests.backup, CONTEXT),
      walgProvider.backup(walgRequests.backup, CONTEXT),
    ]
    for (const plan of plans) {
      expect(plan.transport).toEqual(CONTEXT.transport)
      expect(plan.transport).toEqual({
        kind: 'ssh',
        host: 'dba@db1.internal',
        knownHostsFile: '/etc/backup-agent/known_hosts',
      })
    }
  })
})

describe('pgbackrestProvider catalog', () => {
  /** Awaits a call that must refuse and returns the typed error for assertions. */
  async function expectRefusal(promise: Promise<unknown>): Promise<ProviderOperationError> {
    try {
      await promise
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderOperationError)
      return error as ProviderOperationError
    }
    throw new Error('expected the provider to refuse instead of returning a catalog')
  }

  it('reads pgbackrest info with the config path outside argv[0] and no stanza when omitted', async () => {
    const executor = executorFor({})
    await pgbackrestProvider.catalog(executor, { config: PGBACKREST_CONFIG }, CONTEXT)
    const calls = (executor as FakeExecutor).calls
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual([
      'pgbackrest',
      'info',
      '--output=json',
      `--config=${PGBACKREST_CONFIG}`,
    ])
  })

  it('maps two backups into newest-first entries with bytes from info.size', async () => {
    const catalog = await pgbackrestProvider.catalog(
      executorFor({}),
      pgbackrestRequests.catalog,
      CONTEXT,
    )

    expect(catalog.providerId).toBe('pgbackrest')
    expect(catalog.entries).toEqual([
      {
        // `timestamp.start` is epoch seconds in pgBackRest's JSON.
        label: '20260102-010101F',
        kind: 'full',
        startedAt: new Date(1767315661 * 1_000).toISOString(),
        stoppedAt: new Date(1767319261 * 1_000).toISOString(),
        bytes: 2147483648,
      },
      {
        label: '20260101-010101F',
        kind: 'full',
        startedAt: new Date(1767229261 * 1_000).toISOString(),
        stoppedAt: new Date(1767232861 * 1_000).toISOString(),
        bytes: 1073741824,
      },
    ])
  })

  it('refuses non-JSON output without leaking the config path', async () => {
    const executor = new FakeExecutor({
      defaultHandler: () => ({
        exitCode: 0,
        stdout: `pgbackrest: [028]: unable to open --config=${PGBACKREST_CONFIG}`,
      }),
    })

    const error = await expectRefusal(
      pgbackrestProvider.catalog(executor, pgbackrestRequests.catalog, CONTEXT),
    )

    expect(error.code).toBe('INVALID_REQUEST')
    expect(error.message).not.toContain(PGBACKREST_CONFIG)
  })

  it('refuses a non-zero exit without leaking the config path from stderr', async () => {
    const executor = new FakeExecutor({
      defaultHandler: () => ({
        exitCode: 1,
        stderr: `ERROR: [056]: unable to find stanza in --config=${PGBACKREST_CONFIG}`,
      }),
    })

    const error = await expectRefusal(
      pgbackrestProvider.catalog(executor, pgbackrestRequests.catalog, CONTEXT),
    )

    expect(error.code).toBe('INVALID_REQUEST')
    expect(error.message).not.toContain(PGBACKREST_CONFIG)
    expect(error.message).toContain('exited 1')
  })
})

describe('provider inspect', () => {
  it('probes the instance through psql for both adapters', async () => {
    const executor = new FakeExecutor({
      defaultHandler: (cmd) => {
        if (cmd[0] === 'psql' && cmd.includes('-c')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              version: 'PostgreSQL 16.15',
              serverVersionNum: 160015,
              currentUser: 'backup',
              currentDatabase: 'app',
              databaseOid: '16384',
              inRecovery: false,
              walLevel: 'replica',
              archiveMode: 'on',
              databases: ['app'],
            }),
          }
        }
        return { exitCode: 0, stdout: '' }
      },
    })
    const connection: ConnectionParams = {
      host: 'db.internal',
      port: '5432',
      user: 'backup',
      database: 'app',
    }

    const [pgbr, walg] = await Promise.all([
      pgbackrestProvider.inspect(executor, connection),
      walgProvider.inspect(executor, connection),
    ])

    expect(pgbr.serverVersionNum).toBe(160015)
    expect(walg.serverVersionNum).toBe(160015)
  })
})
