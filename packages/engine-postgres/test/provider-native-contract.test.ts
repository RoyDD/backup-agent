import { describe, expect, it } from 'vitest'

import {
  asMandateId,
  asTicketId,
  parseDsn,
  ProviderOperationError,
  type Executor,
  type PlanBuildContext,
  type PlanValidationContext,
} from '@backup-agent/core'
import { FakeExecutor } from '@backup-agent/core/testkit'

import { POSTGRES_ENGINE_DESCRIPTOR } from '../src/descriptor'
import { buildLogicalVerifyPlan, logicalProvider, type LogicalProviderRequests } from '../src/logical'
import {
  buildPhysicalVerifyPlan,
  nativePhysicalProvider,
  type PhysicalProviderRequests,
} from '../src/physical'
import {
  defineProviderContractSuite,
  type ProviderContractExecutorOptions,
} from '../../core/test/contract/provider-contract.suite'

const connection = parseDsn('postgres://backup:secret@10.0.0.5:5433/app?sslmode=require')

const context: PlanBuildContext = {
  ticketId: asTicketId('tkt_contract'),
  mandateId: asMandateId('mnd_contract'),
  now: '2026-01-01T00:00:00.000Z',
  instance: {
    version: 'PostgreSQL 16.15',
    serverVersionNum: 160015,
    currentUser: 'backup',
    currentDatabase: 'app',
    databaseOid: '16384',
    inRecovery: false,
    systemIdentifier: 'sys-contract',
    walLevel: 'replica',
    archiveMode: 'on',
    databases: ['app'],
    executionSite: 'fake',
    warnings: [],
  },
  configDigest: 'cfg-contract',
  // The contract suite runs every adapter with a remote transport in play, so
  // the plans it validates must carry it rather than fall back to a default.
  transport: {
    kind: 'ssh',
    host: 'dba@db1.internal',
    knownHostsFile: '/etc/backup-agent/known_hosts',
  },
}

/** Base validation context; the suite binds a Mandate to each produced Plan. */
const validation: Omit<PlanValidationContext, 'mandate'> = {
  now: context.now,
  declaredCapabilities: POSTGRES_ENGINE_DESCRIPTOR.capabilities,
  requiredCapabilities: [],
  resources: { availableBytes: Number.MAX_SAFE_INTEGER, maxConcurrency: 8 },
  policyValid: true,
}

/**
 * Executor double for the contract cases: `<tool> --version` answers with a
 * satisfying version unless the case scripts a version or an absence, and every
 * other argv succeeds so preflight never trips over an unrelated call.
 */
function executorFor(options: ProviderContractExecutorOptions): Executor {
  const toolVersions = options.toolVersions ?? {}
  const missingTools = options.missingTools ?? []
  return new FakeExecutor({
    site: 'fake',
    defaultHandler: (cmd) => {
      const tool = cmd[0] ?? ''
      if (cmd.includes('--version')) {
        if (missingTools.includes(tool)) {
          return { exitCode: 127, stderr: `${tool}: command not found` }
        }
        return { stdout: `${tool} ${toolVersions[tool] ?? '99.0'}` }
      }
      return {}
    },
  })
}

const logicalRequests: LogicalProviderRequests = {
  backup: { connection, database: 'app', outputPath: '/tmp/a.dump', format: 'custom' },
  restore: { connection, inputPath: '/tmp/a.dump', format: 'custom', database: 'app_restored' },
  verify: { connection, inputPath: '/tmp/a.dump', format: 'custom' },
  prune: undefined,
  catalog: undefined,
}

const physicalRequests: PhysicalProviderRequests = {
  backup: { connection, outputPath: '/tmp/base', format: 'plain' },
  restore: {
    connection,
    dataDirectory: '/tmp/restore',
    port: '55417',
    logPath: '/tmp/restore.log',
    restoreCommand: 'cp /archive/%f %p',
    target: { time: '2026-01-01 00:00:00+00' },
    existingAutoConf: '',
  },
  verify: { connection, outputPath: '/tmp/base' },
  prune: undefined,
  catalog: undefined,
}

defineProviderContractSuite<LogicalProviderRequests>('native-logical', {
  engine: POSTGRES_ENGINE_DESCRIPTOR,
  adapter: logicalProvider,
  context,
  validation,
  supported: ['backup', 'restore', 'verify'],
  requests: logicalRequests,
  executorFor,
})

defineProviderContractSuite<PhysicalProviderRequests>('native-physical', {
  engine: POSTGRES_ENGINE_DESCRIPTOR,
  adapter: nativePhysicalProvider,
  context,
  validation,
  supported: ['backup', 'restore', 'verify'],
  requests: physicalRequests,
  executorFor,
})

describe('native verify plans', () => {
  it('carries the context transport on each adapter backup plan', () => {
    for (const plan of [
      logicalProvider.backup(logicalRequests.backup, context),
      nativePhysicalProvider.backup(physicalRequests.backup, context),
    ]) {
      expect(plan.transport).toEqual(context.transport)
      expect(plan.transport).toEqual({
        kind: 'ssh',
        host: 'dba@db1.internal',
        knownHostsFile: '/etc/backup-agent/known_hosts',
      })
    }
  })

  it('refuses to verify a plain-format dump, which has no TOC to list', () => {
    let thrown: unknown
    try {
      buildLogicalVerifyPlan({ connection, inputPath: '/tmp/a.sql', format: 'plain' }, context)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProviderOperationError)
    expect((thrown as ProviderOperationError).code).toBe('INVALID_REQUEST')
  })

  it('lists a custom-format dump TOC without mapping owners', () => {
    const plan = buildLogicalVerifyPlan(
      { connection, inputPath: '/tmp/a.dump', format: 'custom', noOwner: true },
      context,
    )
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.argv).toEqual(['pg_restore', '--list', '/tmp/a.dump'])
    expect(plan.risk).toBe('reversible')
    expect(plan.requires).toEqual({ capabilities: ['logical', 'verify-restore'] })
    expect(plan.targetId).toBe('verify:10.0.0.5:5433/app')
  })

  it('skips WAL parsing by default and enables it on request', () => {
    const defaulted = buildPhysicalVerifyPlan({ connection, outputPath: '/tmp/base' }, context)
    expect(defaulted.steps[0]?.argv).toEqual(['pg_verifybackup', '--no-parse-wal', '/tmp/base'])
    expect(defaulted.risk).toBe('reversible')
    expect(defaulted.requires).toEqual({ capabilities: ['physical', 'verify-restore'] })
    expect(defaulted.targetId).toBe('verify:/tmp/base')

    const parsed = buildPhysicalVerifyPlan(
      { connection, outputPath: '/tmp/base', parseWal: true },
      context,
    )
    expect(parsed.steps[0]?.argv).toEqual(['pg_verifybackup', '/tmp/base'])
  })
})
