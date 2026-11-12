import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'

import {
  ConnectionError,
  LocalExecutor,
  PrincipalError,
  WebhookNotifier,
  asArtifactId,
  asPlanId,
  asTargetId,
  asTicketId,
  buildOpsReport,
  checkBudget,
  classifyRetentionProvider,
  connectionEnv,
  estimateCost,
  evaluateAssetRpo,
  fourEyesStatus,
  forecastCapacity,
  newId,
  loadPrincipalRegistry,
  parseModelPolicy,
  planRetention,
  policyFor,
  preparePlan,
  providerRetentionGuidance,
  renderDashboard,
  renderMetrics,
  renderReportMarkdown,
  resolvePrincipalDsn,
  retentionDigest,
  riskAtLeast,
  tombstoneRetention,
  toRetentionArtifact,
  validateAsset,
  withDatabase,
  type Executor,
  type InstanceInfo,
  type LogicalBackupRequest,
  type LogicalFormat,
  type LogicalRestoreRequest,
  type Plan,
  type PlanBuildContext,
} from '@backup-agent/core'
import {
  ProbeError,
  artifactDatabase,
  buildPgBackRestBackupPlan,
  buildPgBackRestExpirePlan,
  buildPgBackRestRestorePlan,
  buildPhysicalBackupPlan,
  buildPitrRestorePlan,
  buildWalGBackupPlan,
  buildWalGPrunePlan,
  buildWalGRestorePlan,
  postgresEngine,
  requestDigest,
  verifyLogicalRestore,
  type PhysicalBackupRequest,
  type PitrRestoreRequest,
} from '@backup-agent/engine-postgres'

import {
  createSqliteRepository,
  dispatchOutbox,
  reconcile,
} from '@backup-agent/core/persistence'
import type { ArtifactRecord, AssetDescriptor, Repository } from '@backup-agent/core'

import { inspectInstance, parseDsn } from './inspect'
import {
  DEFAULT_CONTROL_DB,
  buildPlanContext,
  executePlan,
  planIssueText,
  reportPlanOutcome,
  validateForExecution,
} from './execute-plan'
import {
  authorizeDestructivePlan,
  identityDenialMessage,
  provenIdentity,
} from './destructive-gate'
import { createOutboxHandlers } from './outbox'

const USAGE = `bkagent — PostgreSQL backup and restore agent

Usage:
  bkagent inspect --dsn <uri> [--format json|text]
  bkagent backup  --dsn <uri> --out <path> [--mode logical|physical] [--database <db>]
                  [--format custom|directory|plain|tar] [--jobs N] [--compress N]
                  [--table t]... [--schema s]... [--wal-method stream|fetch] [--label L]
  bkagent restore --dsn <uri> --input <path> [--database <db>] [--format custom|directory|plain]
                  [--create-database] [--clean] [--if-exists] [--no-owner] [--jobs N] [--yes]
                  [--db <control-db>]
  bkagent verify  --dsn <uri> --input <path> [--database <source-db>] [--format custom|directory|plain]
                  [--jobs N] [--no-owner] [--keep-scratch]
  bkagent pitr    --dsn <uri> --data-dir <dir> --port <n> --log <path> --restore-command <cmd>
                  (--target-time <ts> | --target-lsn <lsn> | --target-name <name> | --target-xid <xid>)
                  [--action promote|pause|shutdown] [--verify-sql <sql>] [--yes] [--db <control-db>]
  bkagent pgbackrest-backup  --config <path> --stanza <name> [--type full|diff|incr] [--ensure-stanza]
                             [--db <control-db>]
  bkagent pgbackrest-restore --config <path> --stanza <name> --data-dir <dir>
                             [--target-type time|lsn|xid|name|immediate] [--target <value>]
                             [--start-port <n>] [--log <path>] [--yes] [--db <control-db>]
  bkagent pgbackrest-expire  --config <path> --stanza <name> [--yes] [--db <control-db>]
  bkagent walg-backup  --data-dir <PGDATA> [--walg <bin>] [--db <control-db>]
  bkagent walg-restore --data-dir <dir> [--backup LATEST] [--start-port <n>] [--yes] [--db <control-db>]
  bkagent walg-prune   --retain-full <n> [--walg <bin>] [--yes] [--db <control-db>]
  bkagent artifact-add --db <path> --target <id> --provider <p> --kind <k> --path <path>
                       [--parent <id>] [--plan <id>] [--size N] [--verified-level V0..V3] [--protected]
  bkagent catalog  --db <path> [--target <id>] [--provider <p>] [--since <iso|Nd>] [--limit N] [--history]
  bkagent retain   --db <path> --daily N --weekly N --monthly N [--target <id>] [--apply --yes --digest <d>]
  bkagent report   --db <path> [--since <iso|Nd>] [--format markdown|json]
  bkagent metrics  --db <path>
  bkagent capacity --db <path> [--threshold-gb N] [--days N]
  bkagent watchdog --db <path>
  bkagent outbox-dispatch --db <path> [--limit N] [--max-attempts N]
  bkagent trace    --db <path> (--ticket <id> | --plan <id>)
  bkagent notify-test --url <url> [--severity P1|P2|P3|P4] [--title <text>]
  bkagent dashboard --db <path> (--out <file> | --serve [--port N]) [--since <iso|Nd>]
  bkagent asset-set --db <path> --target <id> --engine <e> --environment <env> --owner <o>
                    --criticality <c> --data-classification <d> --rpo-minutes N --rto-minutes N
                    [--protected] [--maintenance-cron <cron>] [--maintenance-tz <tz>]
  bkagent asset-list --db <path> [--format json|text]
  bkagent asset-rpo  --db <path>
  bkagent model-policy show --file <path>
  bkagent model-policy check --file <path> --task <t> --input-tokens N --output-tokens N
  bkagent cost record --db <path> --task <t> --model <m> --input-tokens N --output-tokens N
                      [--ticket <id>] [--policy <file>]
  bkagent cost report --db <path> [--since <iso|Nd>]
  bkagent approve --db <path> --target <id> --digest <digest> --approver <id> [--reject] [--reason <text>]
  bkagent approvals --db <path> --target <id> --digest <digest> [--ttl-minutes N]

Environment:
  BKAGENT_DSN    Default DSN when --dsn is omitted
  BKAGENT_DB     Control database when --db is omitted (default .bkagent/control.db)
  BKAGENT_WEBHOOK_URL  Failure-notification webhook for outbox-dispatch (never argv)

Destructive plans (all logical restores, pitr, pgbackrest-restore,
pgbackrest-expire, walg-restore, walg-prune) fail closed unless all hold:
  - the live probe proves the target systemIdentifier and the plan matches it;
  - --yes is passed;
  - the control database has an asset registered for the exact plan targetId;
  - if that asset is in the production environment, two distinct current approvals exist
    for the plan digest (see bkagent approve / bkagent approvals).

Exit codes:
  0 success   1 execution failed   2 usage   3 connection failure   4 plan/probe failure
`

export interface CliDeps {
  executor?: Executor
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  env?: NodeJS.ProcessEnv
}

function renderText(info: InstanceInfo): string {
  const lines = [
    `version:            ${info.version}`,
    `server_version_num: ${info.serverVersionNum}`,
    `user:               ${info.currentUser}`,
    `database:           ${info.currentDatabase}`,
    `in_recovery:        ${info.inRecovery}`,
    `system_identifier:  ${info.systemIdentifier ?? '(unavailable)'}`,
    `wal_level:          ${info.walLevel}`,
    `archive_mode:       ${info.archiveMode}`,
    `databases:          ${info.databases.join(', ')}`,
    `execution_site:     ${info.executionSite}`,
  ]
  for (const warning of info.warnings) lines.push(`warning:            ${warning}`)
  return `${lines.join('\n')}\n`
}

function principalFor(explicit: string | undefined, env: NodeJS.ProcessEnv): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  const user = env.USER ?? env.LOGNAME ?? userInfo().username
  return `os:${user}`
}

function syntheticInstance(): InstanceInfo {
  return {
    version: 'unknown',
    serverVersionNum: 0,
    currentUser: '',
    currentDatabase: 'postgres',
    databaseOid: null,
    inRecovery: false,
    systemIdentifier: null,
    walLevel: 'unknown',
    archiveMode: 'unknown',
    databases: [],
    executionSite: 'local',
    warnings: ['instance not probed'],
  }
}

async function probeTarget(
  dsn: string | undefined,
  executor: Executor,
): Promise<InstanceInfo> {
  return dsn === undefined ? syntheticInstance() : postgresEngine.probe(executor, parseDsn(dsn))
}

async function providerContext(
  dsn: string | undefined,
  executor: Executor,
  digest: string,
): Promise<PlanBuildContext> {
  const instance = await probeTarget(dsn, executor)
  return buildPlanContext(instance, digest)
}

const DEFAULT_DB_PATH = DEFAULT_CONTROL_DB

async function withRepo<T>(file: string, fn: (repo: Repository) => Promise<T>): Promise<T> {
  const repo = await createSqliteRepository({ filename: file })
  await repo.migrate()
  try {
    return await fn(repo)
  } finally {
    await repo.close()
  }
}

function pathSize(path: string): number {
  const stats = statSync(path)
  if (stats.isFile()) return stats.size
  let total = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    total += entry.isDirectory() ? pathSize(child) : statSync(child).size
  }
  return total
}

function resolveTarget(
  values: { dsn?: string; credentials?: string; principal?: string },
  env: NodeJS.ProcessEnv,
): { dsn: string; principalId: string } {
  const principalId = principalFor(values.principal, env)
  const credentialsPath = values.credentials ?? env.BKAGENT_CREDENTIALS
  if (credentialsPath !== undefined && credentialsPath.trim() !== '') {
    const registry = loadPrincipalRegistry(credentialsPath)
    return { dsn: resolvePrincipalDsn(registry, principalId, env), principalId }
  }
  const dsn = values.dsn ?? env.BKAGENT_DSN
  if (dsn === undefined || dsn.trim() === '') {
    throw new Error('--dsn or --credentials is required')
  }
  return { dsn, principalId }
}

function parseNonNegativeInt(value: string | undefined, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

function parseSince(value: string | undefined, fallbackDays = 7): string {
  if (value === undefined) {
    return new Date(Date.now() - fallbackDays * 86_400_000).toISOString()
  }
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  const relative = /^(\d+)d$/.exec(value)
  if (relative) {
    return new Date(Date.now() - Number(relative[1]) * 86_400_000).toISOString()
  }
  throw new Error(`invalid --since "${value}"`)
}

function inferFormat(path: string): LogicalFormat {
  const stats = statSync(path)
  if (stats.isDirectory()) return 'directory'
  if (path.endsWith('.sql')) return 'plain'
  return 'custom'
}

function parsePositiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

function handleError(error: unknown, writeError: (text: string) => void): number {
  if (error instanceof ConnectionError) {
    writeError(`bkagent: INVALID_DSN: ${error.message}\n`)
    return 2
  }
  if (error instanceof ProbeError) {
    writeError(`bkagent: ${error.code}: ${error.message}\n`)
    return error.code === 'CONNECT_FAILED' ? 3 : 4
  }
  writeError(`bkagent: ${(error as Error).message}\n`)
  return 4
}

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text))
  const writeError = deps.stderr ?? ((text: string) => process.stderr.write(text))
  const env = deps.env ?? process.env
  const executor = deps.executor ?? new LocalExecutor()
  const resolveDb = (value: string | undefined): string =>
    value ?? env.BKAGENT_DB ?? DEFAULT_DB_PATH

  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    write(USAGE)
    return command === undefined ? 2 : 0
  }

  try {
    switch (command) {
      case 'inspect': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            dsn: { type: 'string' },
            format: { type: 'string', default: 'json' },
          },
        })
        const dsn = values.dsn ?? env.BKAGENT_DSN
        if (dsn === undefined || dsn.trim() === '') {
          writeError('bkagent: --dsn or BKAGENT_DSN is required\n')
          return 2
        }
        const format = values.format ?? 'json'
        if (format !== 'json' && format !== 'text') {
          writeError(`bkagent: unsupported format "${format}"\n`)
          return 2
        }
        const info = await inspectInstance(executor, parseDsn(dsn))
        write(format === 'json' ? `${JSON.stringify(info, null, 2)}\n` : renderText(info))
        return 0
      }

      case 'backup': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            dsn: { type: 'string' },
            database: { type: 'string' },
            out: { type: 'string' },
            mode: { type: 'string', default: 'logical' },
            format: { type: 'string' },
            jobs: { type: 'string' },
            compress: { type: 'string' },
            'wal-method': { type: 'string' },
            checkpoint: { type: 'string' },
            label: { type: 'string' },
            'max-rate': { type: 'string' },
            'parse-wal': { type: 'boolean', default: false },
            table: { type: 'string', multiple: true, default: [] },
            schema: { type: 'string', multiple: true, default: [] },
            principal: { type: 'string' },
            credentials: { type: 'string' },
            'state-dir': { type: 'string' },
            db: { type: 'string' },
          },
        })
        if (values.out === undefined) {
          writeError('bkagent: backup requires --out\n')
          return 2
        }
        let dsn: string
        let principal: string
        try {
          const target = resolveTarget(values, env)
          dsn = target.dsn
          principal = target.principalId
        } catch (error) {
          writeError(`bkagent: ${(error as Error).message}\n`)
          return 2
        }
        const mode = values.mode ?? 'logical'
        if (mode !== 'logical' && mode !== 'physical') {
          writeError(`bkagent: unsupported mode "${mode}"\n`)
          return 2
        }
        const connection = parseDsn(dsn)
        const instance = await postgresEngine.probe(executor, connection)

        if (mode === 'physical') {
          const format = (values.format ?? 'plain') as 'plain' | 'tar'
          if (format !== 'plain' && format !== 'tar') {
            writeError(`bkagent: unsupported physical format "${format}"\n`)
            return 2
          }
          if (values.jobs !== undefined) {
            writeError('bkagent: --jobs is not supported for physical backups\n')
            return 2
          }
          const walMethod = values['wal-method'] as 'stream' | 'fetch' | undefined
          if (walMethod !== undefined && walMethod !== 'stream' && walMethod !== 'fetch') {
            writeError(`bkagent: unsupported wal method "${walMethod}"\n`)
            return 2
          }
          const checkpoint = values.checkpoint as 'fast' | 'spread' | undefined
          if (checkpoint !== undefined && checkpoint !== 'fast' && checkpoint !== 'spread') {
            writeError(`bkagent: unsupported checkpoint mode "${checkpoint}"\n`)
            return 2
          }
          const physical: PhysicalBackupRequest = {
            connection,
            outputPath: values.out,
            format,
            ...(walMethod === undefined ? {} : { walMethod }),
            ...(checkpoint === undefined ? {} : { checkpoint }),
            ...(values.compress === undefined
              ? {}
              : { compression: parsePositiveInt(values.compress, '--compress') as number }),
            ...(values.label === undefined ? {} : { label: values.label }),
            ...(values['max-rate'] === undefined ? {} : { maxRate: values['max-rate'] }),
            parseWal: values['parse-wal'],
          }
          const ctx = buildPlanContext(instance, requestDigest(physical))
          const plan = buildPhysicalBackupPlan(physical, ctx)
          const issues = validateForExecution(plan, principal)
          if (issues.length > 0) {
            write(`${planIssueText(issues)}\n`)
            return 4
          }
          const { result } = await executePlan(plan, instance, {
            executor,
            writeError,
            controlDb: resolveDb(values.db),
            principalId: principal,
            stateDir: values['state-dir'],
            env: connectionEnv(connection),
            artifact: {
              path: values.out,
              kind: 'full',
              verifiedLevel: format === 'plain' ? 'V0' : null,
            },
          })
          return reportPlanOutcome(plan, result, write)
        }

        const format = (values.format ?? 'custom') as LogicalFormat
        if (!['custom', 'directory', 'plain'].includes(format)) {
          writeError(`bkagent: unsupported format "${format}"\n`)
          return 2
        }
        const request: LogicalBackupRequest = {
          connection,
          database: values.database ?? connection.database,
          outputPath: values.out,
          format,
          ...(values.jobs === undefined
            ? {}
            : { jobs: parsePositiveInt(values.jobs, '--jobs') as number }),
          ...(values.compress === undefined
            ? {}
            : { compression: parsePositiveInt(values.compress, '--compress') as number }),
          ...(values.table !== undefined && values.table.length > 0 ? { tables: values.table } : {}),
          ...(values.schema !== undefined && values.schema.length > 0
            ? { schemas: values.schema }
            : {}),
        }
        if (request.jobs !== undefined && format !== 'directory') {
          writeError('bkagent: --jobs requires --format directory\n')
          return 2
        }
        const ctx = buildPlanContext(instance, requestDigest(request))
        const built = postgresEngine.planLogicalBackup(request, ctx)
        const prepared = await preparePlan({
          plan: built,
          refresh: async () => {
            const live = await postgresEngine.probe(executor, connection)
            const now = new Date().toISOString()
            return {
              ...built.fingerprint,
              systemIdentifier: live.systemIdentifier ?? built.fingerprint.systemIdentifier,
              targetOid: live.databaseOid ?? built.fingerprint.targetOid,
              createdAt: now,
              expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
            }
          },
          validate: (candidate) => validateForExecution(candidate, principal),
          now: () => new Date().toISOString(),
          maxAttempts: 2,
        })
        if (!prepared.ok) {
          write(`${planIssueText(prepared.issues)}\n`)
          return 4
        }
        const plan = prepared.plan
        const { result } = await executePlan(plan, instance, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principal,
          stateDir: values['state-dir'],
          env: connectionEnv(connection),
          artifact: {
            path: values.out,
            kind: 'logical',
            verifiedLevel: format === 'plain' ? null : 'V1',
          },
        })
        return reportPlanOutcome(plan, result, write)
      }

      case 'restore': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            dsn: { type: 'string' },
            input: { type: 'string' },
            database: { type: 'string' },
            format: { type: 'string' },
            'create-database': { type: 'boolean', default: false },
            clean: { type: 'boolean', default: false },
            'if-exists': { type: 'boolean', default: false },
            'no-owner': { type: 'boolean', default: false },
            jobs: { type: 'string' },
            yes: { type: 'boolean', default: false },
            principal: { type: 'string' },
            credentials: { type: 'string' },
            'state-dir': { type: 'string' },
            db: { type: 'string' },
          },
        })
        if (values.input === undefined) {
          writeError('bkagent: restore requires --input\n')
          return 2
        }
        let dsn: string
        let principal: string
        try {
          const target = resolveTarget(values, env)
          dsn = target.dsn
          principal = target.principalId
        } catch (error) {
          writeError(`bkagent: ${(error as Error).message}\n`)
          return 2
        }
        const format = (values.format ?? inferFormat(values.input)) as LogicalFormat
        if (!['custom', 'directory', 'plain'].includes(format)) {
          writeError(`bkagent: unsupported format "${format}"\n`)
          return 2
        }
        const connection = parseDsn(dsn)
        const request: LogicalRestoreRequest = {
          connection,
          inputPath: values.input,
          format,
          database: values.database ?? connection.database,
          createDatabase: values['create-database'],
          clean: values.clean,
          ifExists: values['if-exists'],
          noOwner: values['no-owner'],
          ...(values.jobs === undefined
            ? {}
            : { jobs: parsePositiveInt(values.jobs, '--jobs') as number }),
        }
        if (request.jobs !== undefined && format !== 'directory') {
          writeError('bkagent: --jobs requires --format directory\n')
          return 2
        }
        const instance = await postgresEngine.probe(executor, connection)
        const ctx = buildPlanContext(instance, requestDigest(request))
        const built = postgresEngine.planLogicalRestore(request, ctx)
        const gate = await authorizeDestructivePlan({
          plan: built,
          instance,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (gate.kind === 'denied') {
          writeError(`bkagent: ${gate.message}\n`)
          return gate.exitCode
        }
        const gatePlan = gate.plan
        const destructive = riskAtLeast(gatePlan.risk, 'destructive')

        const prepared = await preparePlan({
          plan: gatePlan,
          refresh: async () => {
            const live = await postgresEngine.probe(executor, connection)
            // A destructive plan must never inherit an identity the live probe
            // could not prove; that would authorize the wrong cluster.
            if (destructive && provenIdentity(gatePlan, live) === null) {
              throw new Error(identityDenialMessage(gatePlan, live))
            }
            const now = new Date().toISOString()
            return {
              ...gatePlan.fingerprint,
              systemIdentifier: destructive
                ? (live.systemIdentifier as string)
                : (live.systemIdentifier ?? gatePlan.fingerprint.systemIdentifier),
              targetOid: live.databaseOid ?? gatePlan.fingerprint.targetOid,
              createdAt: now,
              expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
            }
          },
          validate: (candidate) => validateForExecution(candidate, principal),
          now: () => new Date().toISOString(),
          maxAttempts: 2,
        })
        if (!prepared.ok) {
          write(`${planIssueText(prepared.issues)}\n`)
          return 4
        }

        // Re-authorize the plan that will actually run against a fresh probe,
        // so approvals and identity apply to the final prepared revision.
        let plan = prepared.plan
        let executionInstance = instance
        if (destructive) {
          executionInstance = await postgresEngine.probe(executor, connection)
          const finalGate = await authorizeDestructivePlan({
            plan,
            instance: executionInstance,
            controlDb: resolveDb(values.db),
            confirmed: values.yes,
            requester: principal,
            osPrincipal: principalFor(undefined, env),
          })
          if (finalGate.kind === 'denied') {
            writeError(`bkagent: ${finalGate.message}\n`)
            return finalGate.exitCode
          }
          plan = finalGate.plan
        }

        const { result } = await executePlan(plan, executionInstance, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principal,
          stateDir: values['state-dir'],
          env: connectionEnv(connection),
          authorization: {
            confirmed: values.yes,
            requester: principal,
            osPrincipal: principalFor(undefined, env),
          },
        })
        return reportPlanOutcome(plan, result, write)
      }

      case 'verify': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            dsn: { type: 'string' },
            input: { type: 'string' },
            database: { type: 'string' },
            format: { type: 'string' },
            jobs: { type: 'string' },
            'no-owner': { type: 'boolean', default: false },
            'keep-scratch': { type: 'boolean', default: false },
          },
        })
        const dsn = values.dsn ?? env.BKAGENT_DSN
        if (dsn === undefined || values.input === undefined) {
          writeError('bkagent: verify requires --dsn and --input\n')
          return 2
        }
        const format = (values.format ?? inferFormat(values.input)) as LogicalFormat
        if (!['custom', 'directory', 'plain'].includes(format)) {
          writeError(`bkagent: unsupported format "${format}"\n`)
          return 2
        }
        const base = parseDsn(dsn)
        const sourceDatabase =
          values.database ?? (await artifactDatabase(executor, values.input, format)) ?? base.database
        const connection = withDatabase(base, sourceDatabase)
        const report = await verifyLogicalRestore(executor, {
          connection,
          inputPath: values.input,
          format,
          noOwner: values['no-owner'],
          keepScratch: values['keep-scratch'],
          ...(values.jobs === undefined
            ? {}
            : { jobs: parsePositiveInt(values.jobs, '--jobs') as number }),
        })
        write(`${JSON.stringify(report, null, 2)}\n`)
        return report.ok ? 0 : 1
      }

      case 'pitr': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            dsn: { type: 'string' },
            'data-dir': { type: 'string' },
            port: { type: 'string' },
            log: { type: 'string' },
            'restore-command': { type: 'string' },
            'target-time': { type: 'string' },
            'target-lsn': { type: 'string' },
            'target-name': { type: 'string' },
            'target-xid': { type: 'string' },
            action: { type: 'string' },
            'verify-sql': { type: 'string' },
            yes: { type: 'boolean', default: false },
            principal: { type: 'string' },
            'state-dir': { type: 'string' },
            db: { type: 'string' },
          },
        })
        const dsn = values.dsn ?? env.BKAGENT_DSN
        if (
          dsn === undefined ||
          values['data-dir'] === undefined ||
          values.port === undefined ||
          values.log === undefined ||
          values['restore-command'] === undefined
        ) {
          writeError(
            'bkagent: pitr requires --dsn --data-dir --port --log --restore-command\n',
          )
          return 2
        }
        const targetCount = [
          values['target-time'],
          values['target-lsn'],
          values['target-name'],
          values['target-xid'],
        ].filter((value) => value !== undefined).length
        if (targetCount !== 1) {
          writeError(
            'bkagent: exactly one of --target-time|--target-lsn|--target-name|--target-xid is required\n',
          )
          return 2
        }
        const action = values.action
        if (action !== undefined && !['promote', 'pause', 'shutdown'].includes(action)) {
          writeError(`bkagent: unsupported recovery action "${action}"\n`)
          return 2
        }

        const connection = parseDsn(dsn)
        const instance = await postgresEngine.probe(executor, connection)
        const dataDirectory = values['data-dir']
        let existingAutoConf = ''
        try {
          existingAutoConf = readFileSync(join(dataDirectory, 'postgresql.auto.conf'), 'utf8')
        } catch {
          existingAutoConf = ''
        }

        const request: PitrRestoreRequest = {
          connection,
          dataDirectory,
          port: values.port,
          logPath: values.log,
          restoreCommand: values['restore-command'],
          target: {
            ...(values['target-time'] === undefined ? {} : { time: values['target-time'] }),
            ...(values['target-lsn'] === undefined ? {} : { lsn: values['target-lsn'] }),
            ...(values['target-name'] === undefined ? {} : { name: values['target-name'] }),
            ...(values['target-xid'] === undefined ? {} : { xid: values['target-xid'] }),
          },
          ...(action === undefined
            ? {}
            : { action: action as 'promote' | 'pause' | 'shutdown' }),
          existingAutoConf,
          ...(values['verify-sql'] === undefined ? {} : { verifySql: values['verify-sql'] }),
        }

        const ctx = buildPlanContext(instance, requestDigest(request))
        const built = buildPitrRestorePlan(request, ctx)
        const principal = principalFor(values.principal, env)
        const gate = await authorizeDestructivePlan({
          plan: built,
          instance,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (gate.kind === 'denied') {
          writeError(`bkagent: ${gate.message}\n`)
          return gate.exitCode
        }
        const live = await postgresEngine.probe(executor, connection)
        const finalGate = await authorizeDestructivePlan({
          plan: gate.plan,
          instance: live,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (finalGate.kind === 'denied') {
          writeError(`bkagent: ${finalGate.message}\n`)
          return finalGate.exitCode
        }
        const plan = finalGate.plan
        const issues = validateForExecution(plan, principal)
        if (issues.length > 0) {
          write(`${planIssueText(issues)}\n`)
          return 4
        }
        const pitrEnv = connectionEnv(
          withDatabase({ ...connection, host: '127.0.0.1', port: values.port }, 'postgres'),
        )
        const { result } = await executePlan(plan, live, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principal,
          stateDir: values['state-dir'],
          env: pitrEnv,
          authorization: {
            confirmed: values.yes,
            requester: principal,
            osPrincipal: principalFor(undefined, env),
          },
        })
        return reportPlanOutcome(plan, result, write)
      }

      case 'pgbackrest-backup': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            config: { type: 'string' },
            stanza: { type: 'string' },
            repo: { type: 'string' },
            type: { type: 'string' },
            'ensure-stanza': { type: 'boolean', default: false },
            dsn: { type: 'string' },
            principal: { type: 'string' },
            'state-dir': { type: 'string' },
            db: { type: 'string' },
          },
        })
        if (values.config === undefined || values.stanza === undefined) {
          writeError('bkagent: pgbackrest-backup requires --config and --stanza\n')
          return 2
        }
        const type = values.type as 'full' | 'diff' | 'incr' | undefined
        if (type !== undefined && !['full', 'diff', 'incr'].includes(type)) {
          writeError(`bkagent: unsupported backup type "${type}"\n`)
          return 2
        }
        const request = {
          configPath: values.config,
          stanza: values.stanza,
          ...(values.repo === undefined ? {} : { repo: values.repo }),
          ...(type === undefined ? {} : { type }),
          ensureStanza: values['ensure-stanza'],
        }
        const ctx = await providerContext(
          values.dsn ?? env.BKAGENT_DSN,
          executor,
          requestDigest(request),
        )
        const plan = buildPgBackRestBackupPlan(request, ctx)
        const issues = validateForExecution(plan, principalFor(values.principal, env))
        if (issues.length > 0) {
          write(`${planIssueText(issues)}\n`)
          return 4
        }
        const { result } = await executePlan(plan, ctx.instance, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principalFor(values.principal, env),
          stateDir: values['state-dir'],
        })
        return reportPlanOutcome(plan, result, write)
      }

      case 'pgbackrest-restore': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            config: { type: 'string' },
            stanza: { type: 'string' },
            repo: { type: 'string' },
            'data-dir': { type: 'string' },
            'target-type': { type: 'string' },
            target: { type: 'string' },
            action: { type: 'string' },
            delta: { type: 'boolean', default: false },
            'start-port': { type: 'string' },
            log: { type: 'string' },
            dsn: { type: 'string' },
            yes: { type: 'boolean', default: false },
            principal: { type: 'string' },
            'state-dir': { type: 'string' },
            db: { type: 'string' },
          },
        })
        if (
          values.config === undefined ||
          values.stanza === undefined ||
          values['data-dir'] === undefined
        ) {
          writeError('bkagent: pgbackrest-restore requires --config --stanza --data-dir\n')
          return 2
        }
        const targetType = values['target-type'] as
          | 'time'
          | 'lsn'
          | 'xid'
          | 'name'
          | 'immediate'
          | undefined
        if (
          targetType !== undefined &&
          !['time', 'lsn', 'xid', 'name', 'immediate'].includes(targetType)
        ) {
          writeError(`bkagent: unsupported target type "${targetType}"\n`)
          return 2
        }
        const action = values.action
        if (action !== undefined && !['promote', 'pause', 'shutdown'].includes(action)) {
          writeError(`bkagent: unsupported recovery action "${action}"\n`)
          return 2
        }
        const request = {
          configPath: values.config,
          stanza: values.stanza,
          ...(values.repo === undefined ? {} : { repo: values.repo }),
          dataDirectory: values['data-dir'],
          ...(targetType === undefined
            ? {}
            : { target: { type: targetType, ...(values.target === undefined ? {} : { value: values.target }) } }),
          ...(action === undefined ? {} : { action: action as 'promote' | 'pause' | 'shutdown' }),
          delta: values.delta,
          ...(values['start-port'] === undefined ? {} : { startPort: values['start-port'] }),
          ...(values.log === undefined ? {} : { logPath: values.log }),
        }
        const dsn = values.dsn ?? env.BKAGENT_DSN
        const ctx = await providerContext(dsn, executor, requestDigest(request))
        const plan = buildPgBackRestRestorePlan(request, ctx)
        const principal = principalFor(values.principal, env)
        const gate = await authorizeDestructivePlan({
          plan,
          instance: ctx.instance,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (gate.kind === 'denied') {
          writeError(`bkagent: ${gate.message}\n`)
          return gate.exitCode
        }
        const live = await probeTarget(dsn, executor)
        const finalGate = await authorizeDestructivePlan({
          plan: gate.plan,
          instance: live,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (finalGate.kind === 'denied') {
          writeError(`bkagent: ${finalGate.message}\n`)
          return finalGate.exitCode
        }
        const gatedPlan = finalGate.plan
        const issues = validateForExecution(gatedPlan, principal)
        if (issues.length > 0) {
          write(`${planIssueText(issues)}\n`)
          return 4
        }
        const { result } = await executePlan(gatedPlan, live, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principal,
          stateDir: values['state-dir'],
          authorization: {
            confirmed: values.yes,
            requester: principal,
            osPrincipal: principalFor(undefined, env),
          },
        })
        return reportPlanOutcome(gatedPlan, result, write)
      }

      case 'pgbackrest-expire': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            config: { type: 'string' },
            stanza: { type: 'string' },
            repo: { type: 'string' },
            dsn: { type: 'string' },
            yes: { type: 'boolean', default: false },
            principal: { type: 'string' },
            'state-dir': { type: 'string' },
            db: { type: 'string' },
          },
        })
        if (values.config === undefined || values.stanza === undefined) {
          writeError('bkagent: pgbackrest-expire requires --config and --stanza\n')
          return 2
        }
        const request = {
          configPath: values.config,
          stanza: values.stanza,
          ...(values.repo === undefined ? {} : { repo: values.repo }),
        }
        const dsn = values.dsn ?? env.BKAGENT_DSN
        const ctx = await providerContext(dsn, executor, requestDigest(request))
        const plan = buildPgBackRestExpirePlan(request, ctx)
        const principal = principalFor(values.principal, env)
        const gate = await authorizeDestructivePlan({
          plan,
          instance: ctx.instance,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (gate.kind === 'denied') {
          writeError(`bkagent: ${gate.message}\n`)
          return gate.exitCode
        }
        const live = await probeTarget(dsn, executor)
        const finalGate = await authorizeDestructivePlan({
          plan: gate.plan,
          instance: live,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (finalGate.kind === 'denied') {
          writeError(`bkagent: ${finalGate.message}\n`)
          return finalGate.exitCode
        }
        const gatedPlan = finalGate.plan
        const issues = validateForExecution(gatedPlan, principal)
        if (issues.length > 0) {
          write(`${planIssueText(issues)}\n`)
          return 4
        }
        const { result } = await executePlan(gatedPlan, live, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principal,
          stateDir: values['state-dir'],
          authorization: {
            confirmed: values.yes,
            requester: principal,
            osPrincipal: principalFor(undefined, env),
          },
        })
        return reportPlanOutcome(gatedPlan, result, write)
      }

      case 'walg-backup': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            'data-dir': { type: 'string' },
            walg: { type: 'string' },
            dsn: { type: 'string' },
            principal: { type: 'string' },
            'state-dir': { type: 'string' },
            db: { type: 'string' },
          },
        })
        if (values['data-dir'] === undefined) {
          writeError('bkagent: walg-backup requires --data-dir\n')
          return 2
        }
        const request = {
          dataDirectory: values['data-dir'],
          ...(values.walg === undefined ? {} : { command: values.walg }),
        }
        const ctx = await providerContext(
          values.dsn ?? env.BKAGENT_DSN,
          executor,
          requestDigest(request),
        )
        const plan = buildWalGBackupPlan(request, ctx)
        const issues = validateForExecution(plan, principalFor(values.principal, env))
        if (issues.length > 0) {
          write(`${planIssueText(issues)}\n`)
          return 4
        }
        const { result } = await executePlan(plan, ctx.instance, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principalFor(values.principal, env),
          stateDir: values['state-dir'],
        })
        return reportPlanOutcome(plan, result, write)
      }

      case 'walg-restore': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            'data-dir': { type: 'string' },
            backup: { type: 'string' },
            'start-port': { type: 'string' },
            log: { type: 'string' },
            walg: { type: 'string' },
            dsn: { type: 'string' },
            yes: { type: 'boolean', default: false },
            principal: { type: 'string' },
            'state-dir': { type: 'string' },
            db: { type: 'string' },
          },
        })
        if (values['data-dir'] === undefined) {
          writeError('bkagent: walg-restore requires --data-dir\n')
          return 2
        }
        const request = {
          dataDirectory: values['data-dir'],
          ...(values.backup === undefined ? {} : { backupName: values.backup }),
          ...(values['start-port'] === undefined ? {} : { startPort: values['start-port'] }),
          ...(values.log === undefined ? {} : { logPath: values.log }),
          ...(values.walg === undefined ? {} : { command: values.walg }),
        }
        const dsn = values.dsn ?? env.BKAGENT_DSN
        const ctx = await providerContext(dsn, executor, requestDigest(request))
        const plan = buildWalGRestorePlan(request, ctx)
        const principal = principalFor(values.principal, env)
        const gate = await authorizeDestructivePlan({
          plan,
          instance: ctx.instance,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (gate.kind === 'denied') {
          writeError(`bkagent: ${gate.message}\n`)
          return gate.exitCode
        }
        const live = await probeTarget(dsn, executor)
        const finalGate = await authorizeDestructivePlan({
          plan: gate.plan,
          instance: live,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (finalGate.kind === 'denied') {
          writeError(`bkagent: ${finalGate.message}\n`)
          return finalGate.exitCode
        }
        const gatedPlan = finalGate.plan
        const issues = validateForExecution(gatedPlan, principal)
        if (issues.length > 0) {
          write(`${planIssueText(issues)}\n`)
          return 4
        }
        const { result } = await executePlan(gatedPlan, live, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principal,
          stateDir: values['state-dir'],
          authorization: {
            confirmed: values.yes,
            requester: principal,
            osPrincipal: principalFor(undefined, env),
          },
        })
        return reportPlanOutcome(gatedPlan, result, write)
      }

      case 'walg-prune': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            'retain-full': { type: 'string' },
            walg: { type: 'string' },
            dsn: { type: 'string' },
            yes: { type: 'boolean', default: false },
            principal: { type: 'string' },
            'state-dir': { type: 'string' },
            db: { type: 'string' },
          },
        })
        if (values['retain-full'] === undefined) {
          writeError('bkagent: walg-prune requires --retain-full\n')
          return 2
        }
        const request = {
          retainFull: parsePositiveInt(values['retain-full'], '--retain-full') as number,
          ...(values.walg === undefined ? {} : { command: values.walg }),
        }
        const dsn = values.dsn ?? env.BKAGENT_DSN
        const ctx = await providerContext(dsn, executor, requestDigest(request))
        const plan = buildWalGPrunePlan(request, ctx)
        const principal = principalFor(values.principal, env)
        const gate = await authorizeDestructivePlan({
          plan,
          instance: ctx.instance,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (gate.kind === 'denied') {
          writeError(`bkagent: ${gate.message}\n`)
          return gate.exitCode
        }
        const live = await probeTarget(dsn, executor)
        const finalGate = await authorizeDestructivePlan({
          plan: gate.plan,
          instance: live,
          controlDb: resolveDb(values.db),
          confirmed: values.yes,
          requester: principal,
          osPrincipal: principalFor(undefined, env),
        })
        if (finalGate.kind === 'denied') {
          writeError(`bkagent: ${finalGate.message}\n`)
          return finalGate.exitCode
        }
        const gatedPlan = finalGate.plan
        const issues = validateForExecution(gatedPlan, principal)
        if (issues.length > 0) {
          write(`${planIssueText(issues)}\n`)
          return 4
        }
        const { result } = await executePlan(gatedPlan, live, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principal,
          stateDir: values['state-dir'],
          authorization: {
            confirmed: values.yes,
            requester: principal,
            osPrincipal: principalFor(undefined, env),
          },
        })
        return reportPlanOutcome(gatedPlan, result, write)
      }

      case 'artifact-add': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            target: { type: 'string' },
            provider: { type: 'string' },
            kind: { type: 'string' },
            path: { type: 'string' },
            parent: { type: 'string' },
            plan: { type: 'string' },
            size: { type: 'string' },
            'verified-level': { type: 'string' },
            checksum: { type: 'string' },
            protected: { type: 'boolean', default: false },
          },
        })
        if (
          values.target === undefined ||
          values.provider === undefined ||
          values.kind === undefined ||
          values.path === undefined
        ) {
          writeError('bkagent: artifact-add requires --target --provider --kind --path\n')
          return 2
        }
        let sizeBytes = values.size === undefined ? 0 : Number(values.size)
        if (values.size === undefined) {
          try {
            sizeBytes = pathSize(values.path)
          } catch {
            sizeBytes = 0
          }
        }
        const now = new Date().toISOString()
        const artifact = {
          id: asArtifactId(newId('art')),
          planId: values.plan === undefined ? null : asPlanId(values.plan),
          targetId: asTargetId(values.target),
          provider: values.provider,
          kind: values.kind,
          parentId: values.parent === undefined ? null : asArtifactId(values.parent),
          path: values.path,
          sizeBytes,
          checksum: values.checksum ?? null,
          verifiedLevel: values['verified-level'] ?? null,
          verifiedAt: values['verified-level'] === undefined ? null : now,
          protected: values.protected,
          createdAt: now,
        }
        await withRepo(resolveDb(values.db), async (repo) => repo.artifacts.insert(artifact))
        write(`${JSON.stringify(artifact, null, 2)}\n`)
        return 0
      }

      case 'catalog': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            target: { type: 'string' },
            provider: { type: 'string' },
            since: { type: 'string' },
            limit: { type: 'string' },
            format: { type: 'string', default: 'json' },
            history: { type: 'boolean', default: false },
          },
        })
        const artifacts = await withRepo(resolveDb(values.db), async (repo) =>
          repo.artifacts.list({
            ...(values.target === undefined ? {} : { targetId: asTargetId(values.target) }),
            ...(values.provider === undefined ? {} : { provider: values.provider }),
            ...(values.since === undefined ? {} : { since: parseSince(values.since, 3650) }),
            ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
            // Default is live-only. `--history` also returns tombstoned rows
            // (and, when given, the other filters still apply).
            lifecycle: values.history ? 'any' : 'live',
          }),
        )
        if (values.format === 'text') {
          write(
            `${artifacts
              .map((artifact) => {
                const lifecycle =
                  artifact.lifecycleState === 'tombstoned'
                    ? `[tombstoned${artifact.tombstonedAt === null || artifact.tombstonedAt === undefined ? '' : ` ${artifact.tombstonedAt}`}]`
                    : '[live]'
                return `${artifact.createdAt} ${artifact.provider}/${artifact.kind} ${artifact.targetId} ${artifact.sizeBytes} ${artifact.path} ${lifecycle}`
              })
              .join('\n')}\n`,
          )
        } else {
          write(`${JSON.stringify(artifacts, null, 2)}\n`)
        }
        return 0
      }

      case 'retain': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            daily: { type: 'string' },
            weekly: { type: 'string' },
            monthly: { type: 'string' },
            target: { type: 'string' },
            digest: { type: 'string' },
            principal: { type: 'string' },
            apply: { type: 'boolean', default: false },
            yes: { type: 'boolean', default: false },
          },
        })
        if (values.daily === undefined || values.weekly === undefined || values.monthly === undefined) {
          writeError('bkagent: retain requires --daily --weekly --monthly\n')
          return 2
        }
        const policy = {
          daily: parseNonNegativeInt(values.daily, '--daily'),
          weekly: parseNonNegativeInt(values.weekly, '--weekly'),
          monthly: parseNonNegativeInt(values.monthly, '--monthly'),
        }
        if (values.apply) {
          if (values.target === undefined) {
            writeError('bkagent: retain --apply requires exactly one --target\n')
            return 2
          }
          if (!values.yes) {
            writeError(
              'bkagent: retain --apply changes catalog lifecycle state and requires --yes\n',
            )
            return 2
          }
          if (values.digest === undefined) {
            writeError(
              'bkagent: retain --apply requires --digest <digest> from the reviewed dry run\n',
            )
            return 2
          }
        }

        const controlDb = resolveDb(values.db)
        const targetId = values.target === undefined ? null : asTargetId(values.target)
        const now = new Date()

        if (values.apply && targetId !== null && values.digest !== undefined) {
          // `--target` and `--digest` are proven above.
          const appliedDigest = values.digest
          const outcome = await withRepo(controlDb, (repo) =>
            tombstoneRetention(repo, {
              targetId,
              policy,
              expectedDigest: appliedDigest,
              confirmed: values.yes,
              requester: principalFor(values.principal, env),
              osPrincipal: principalFor(undefined, env),
              now,
            }),
          )
          if (outcome.kind === 'refused') {
            writeError(
              `bkagent: retention apply refused (${outcome.reason}): ${outcome.message}\n`,
            )
            return 2
          }
          const summary = outcome.summary
          write(
            `${JSON.stringify(
              {
                applied: true,
                tombstoneOnly: true,
                bytesReclaimed: 0,
                bytesNotReclaimed: summary.bytesNotReclaimed,
                targetId: summary.targetId,
                digest: summary.digest,
                policy: summary.policy,
                tombstoned: summary.artifactIds,
                providerClasses: summary.providerClasses,
                approvals: summary.approvals,
                outboxId: summary.outboxId,
                notice:
                  'Catalog rows tombstoned; bytes were NOT reclaimed. Rows, paths, checksums and ' +
                  'lineage are retained for trace and audit. Provider-owned repositories are pruned ' +
                  'only with their own tool (pgbackrest expire / wal-g delete retain).',
              },
              null,
              2,
            )}\n`,
          )
          return 0
        }

        const { artifacts, protectedTargets } = await withRepo(controlDb, async (repo) => {
          const assets = await repo.assets.list()
          return {
            artifacts: await repo.artifacts.list(targetId === null ? {} : { targetId }),
            // Target-level protection: `asset-set --protected` claims every
            // artifact of the target, regardless of row-level flags.
            protectedTargets: new Set(
              assets.filter((asset) => asset.protected).map((asset) => asset.targetId as string),
            ),
          }
        })
        const decision = planRetention(artifacts.map(toRetentionArtifact), policy, now, {
          protectedTargets,
        })

        const byTarget = new Map<string, ArtifactRecord[]>()
        for (const artifact of artifacts) {
          const group = byTarget.get(artifact.targetId)
          if (group === undefined) byTarget.set(artifact.targetId, [artifact])
          else group.push(artifact)
        }
        // A dry run for an empty target still yields the digest of the empty
        // candidate set, so the operator can see the exact decision they hold.
        if (targetId !== null && !byTarget.has(targetId)) byTarget.set(targetId, [])

        const targetReports = [...byTarget.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([entryTargetId, records]) => {
            const ids = new Set(records.map((record) => record.id as string))
            const remove = [...decision.remove].filter((id) => ids.has(id)).sort()
            const keep = [...decision.keep].filter((id) => ids.has(id)).sort()
            const digest = retentionDigest({
              targetId: entryTargetId,
              policy,
              candidateIds: remove,
            })
            const providerClasses: Record<string, number> = {
              managed: 0,
              'provider-owned': 0,
              unknown: 0,
            }
            const providerOwned: Array<{ id: string; provider: string; guidance: string }> = []
            const unknownProviders: Array<{ id: string; provider: string; guidance: string }> = []
            let bytesNotReclaimed = 0
            for (const id of remove) {
              const record = records.find((candidate) => (candidate.id as string) === id)
              if (record === undefined) continue
              const providerClass = classifyRetentionProvider(record.provider)
              providerClasses[providerClass] = (providerClasses[providerClass] ?? 0) + 1
              bytesNotReclaimed += record.sizeBytes
              if (providerClass === 'provider-owned') {
                providerOwned.push({
                  id,
                  provider: record.provider,
                  guidance: providerRetentionGuidance(record.provider),
                })
              } else if (providerClass === 'unknown') {
                unknownProviders.push({
                  id,
                  provider: record.provider,
                  guidance: providerRetentionGuidance(record.provider),
                })
              }
            }
            return {
              targetId: entryTargetId,
              digest,
              assetProtected: protectedTargets.has(entryTargetId),
              keep,
              remove,
              reasons: Object.fromEntries(
                [...decision.reasons].filter(([id]) => ids.has(id)),
              ),
              providerClasses,
              providerOwned,
              unknownProviders,
              bytesNotReclaimed,
            }
          })

        const selected =
          targetId === null
            ? null
            : (targetReports.find((report) => report.targetId === targetId) ?? null)
        const result = {
          applied: false,
          tombstoneOnly: true,
          bytesReclaimed: 0,
          policy,
          targetId,
          digest: selected === null ? null : selected.digest,
          keep: selected === null
            ? [...decision.keep]
            : selected.keep,
          remove: selected === null
            ? [...decision.remove]
            : selected.remove,
          reasons: selected === null
            ? Object.fromEntries(decision.reasons)
            : selected.reasons,
          targets: targetReports,
          notice:
            'Dry run: no rows changed. --apply only tombstones eligible catalog rows; bytes are ' +
            'NOT reclaimed. A removal set containing provider-owned (pgbackrest, walg) or unknown ' +
            'providers refuses the entire apply with provider guidance. Assets registered with ' +
            '--protected keep every artifact and apply refuses. --apply requires ' +
            '--target, --yes and the --digest shown here.',
        }
        write(`${JSON.stringify(result, null, 2)}\n`)
        return 0
      }

      case 'report': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            since: { type: 'string' },
            format: { type: 'string', default: 'markdown' },
          },
        })
        const since = parseSince(values.since)
        const now = new Date().toISOString()
        const report = await withRepo(resolveDb(values.db), async (repo) => {
          const artifacts = await repo.artifacts.list({ since })
          const attempts = await repo.attempts.listSince(since)
          return buildOpsReport({
            since,
            now,
            artifacts,
            attempts: attempts.map((attempt) => ({
              state: attempt.state,
              errorClass: attempt.errorClass ?? null,
            })),
          })
        })
        write(
          values.format === 'json'
            ? `${JSON.stringify(report, null, 2)}\n`
            : renderReportMarkdown(report),
        )
        return 0
      }

      case 'metrics': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: { db: { type: 'string' } },
        })
        const now = new Date()
        const text = await withRepo(resolveDb(values.db), async (repo) => {
          const artifacts = await repo.artifacts.list({})
          const attempts = await repo.attempts.listSince('1970-01-01T00:00:00.000Z')
          const outboxPending = await repo.outbox.countByStatus('pending')
          const stalled = await repo.attempts.listExpired(now.toISOString())
          return renderMetrics({
            artifacts,
            attempts: attempts.map((attempt) => ({
              state: attempt.state,
              errorClass: attempt.errorClass ?? null,
            })),
            outboxPending,
            stalledAttempts: stalled.length,
            now: now.getTime(),
          })
        })
        write(text)
        return 0
      }

      case 'capacity': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            'threshold-gb': { type: 'string', default: '100' },
            days: { type: 'string', default: '90' },
          },
        })
        const thresholdBytes = Number(values['threshold-gb']) * 1024 ** 3
        const since = new Date(
          Date.now() - parseNonNegativeInt(values.days, '--days') * 86_400_000,
        ).toISOString()
        const forecast = await withRepo(resolveDb(values.db), async (repo) => {
          const artifacts = await repo.artifacts.list({ since })
          const sorted = [...artifacts].sort(
            (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
          )
          let running = 0
          const points = sorted.map((artifact) => {
            running += artifact.sizeBytes
            return { at: Date.parse(artifact.createdAt), bytes: running }
          })
          return forecastCapacity(points, thresholdBytes, Date.now())
        })
        write(`${JSON.stringify(forecast, null, 2)}\n`)
        return 0
      }

      case 'watchdog': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: { db: { type: 'string' } },
        })
        const report = await withRepo(resolveDb(values.db), async (repo) =>
          reconcile(repo, new Date().toISOString()),
        )
        write(`${JSON.stringify(report, null, 2)}\n`)
        return 0
      }

      case 'outbox-dispatch': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            limit: { type: 'string' },
            'max-attempts': { type: 'string' },
          },
        })
        const limit = parsePositiveInt(values.limit, '--limit')
        const maxAttempts = parsePositiveInt(values['max-attempts'], '--max-attempts')
        const handlers = createOutboxHandlers({ webhookUrl: env.BKAGENT_WEBHOOK_URL })
        const report = await withRepo(resolveDb(values.db), async (repo) =>
          dispatchOutbox(repo, {
            handlers,
            now: () => new Date().toISOString(),
            ...(limit === undefined ? {} : { limit }),
            ...(maxAttempts === undefined ? {} : { maxAttempts }),
          }),
        )
        write(`${JSON.stringify(report, null, 2)}\n`)
        return 0
      }

      case 'trace': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            ticket: { type: 'string' },
            plan: { type: 'string' },
          },
        })
        if (values.ticket === undefined && values.plan === undefined) {
          writeError('bkagent: trace requires --ticket or --plan\n')
          return 2
        }
        const epoch = '1970-01-01T00:00:00.000Z'
        const trace = await withRepo(resolveDb(values.db), async (repo) => {
          if (values.ticket !== undefined) {
            const ticketId = asTicketId(values.ticket)
            const plans = await repo.plans.listByTicket(ticketId)
            const planIds = new Set(plans.map((plan) => plan.id))
            const attempts = (await repo.attempts.listSince(epoch)).filter((attempt) =>
              planIds.has(attempt.planId),
            )
            // History read: tombstoned artifacts still resolve their lineage.
            const artifacts = (await repo.artifacts.list({ lifecycle: 'any' })).filter(
              (artifact) => artifact.planId !== null && planIds.has(artifact.planId),
            )
            return {
              ticket: await repo.tickets.get(ticketId),
              mandates: await repo.mandates.listByTicket(ticketId),
              plans,
              attempts,
              artifacts,
              lineage: await repo.lineage.listFor('ticket', values.ticket as string),
            }
          }
          const planId = asPlanId(values.plan as string)
          const attempts = (await repo.attempts.listSince(epoch)).filter(
            (attempt) => attempt.planId === planId,
          )
          // History read: tombstoned artifacts still resolve their lineage.
          const artifacts = (await repo.artifacts.list({ lifecycle: 'any' })).filter(
            (artifact) => artifact.planId === planId,
          )
          return {
            plan: await repo.plans.get(planId),
            attempts,
            artifacts,
            lineage: await repo.lineage.listFor('plan', values.plan as string),
          }
        })
        write(`${JSON.stringify(trace, null, 2)}\n`)
        return 0
      }

      case 'notify-test': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            url: { type: 'string' },
            severity: { type: 'string', default: 'P4' },
            title: { type: 'string', default: 'bkagent test alert' },
          },
        })
        if (values.url === undefined) {
          writeError('bkagent: notify-test requires --url\n')
          return 2
        }
        const severity = values.severity as 'P1' | 'P2' | 'P3' | 'P4'
        if (!['P1', 'P2', 'P3', 'P4'].includes(severity)) {
          writeError(`bkagent: unsupported severity "${severity}"\n`)
          return 2
        }
        await new WebhookNotifier(values.url).send({
          severity,
          title: values.title,
          message: 'test event from bkagent',
        })
        write(`${JSON.stringify({ ok: true, severity })}\n`)
        return 0
      }

      case 'dashboard': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            out: { type: 'string' },
            serve: { type: 'boolean', default: false },
            port: { type: 'string', default: '8787' },
            since: { type: 'string' },
          },
        })
        if (values.out === undefined && !values.serve) {
          writeError('bkagent: dashboard requires --out or --serve\n')
          return 2
        }
        const since =
          values.since === undefined ? undefined : parseSince(values.since, 3650)
        const generatedAt = new Date().toISOString()
        const payload = await withRepo(resolveDb(values.db), async (repo) => {
          const artifacts = await repo.artifacts.list(
            since === undefined ? {} : { since },
          )
          const attempts = await repo.attempts.listSince(
            since ?? '1970-01-01T00:00:00.000Z',
          )
          const report = buildOpsReport({
            since: since ?? '1970-01-01T00:00:00.000Z',
            now: generatedAt,
            artifacts,
            attempts: attempts.map((attempt) => ({
              state: attempt.state,
              errorClass: attempt.errorClass ?? null,
            })),
          })
          return { artifacts, attempts, report }
        })
        const html = renderDashboard({ generatedAt, ...payload })

        if (values.out !== undefined) {
          writeFileSync(values.out, html, 'utf8')
          write(`${values.out}\n`)
          return 0
        }

        const port = Number(values.port)
        createServer((_request, response) => {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end(html)
        }).listen(port, '127.0.0.1', () => {
          writeError(`dashboard listening on http://127.0.0.1:${port}\n`)
        })
        return 0
      }

      case 'asset-set': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            target: { type: 'string' },
            engine: { type: 'string' },
            environment: { type: 'string' },
            owner: { type: 'string' },
            criticality: { type: 'string' },
            'data-classification': { type: 'string' },
            'rpo-minutes': { type: 'string' },
            'rto-minutes': { type: 'string' },
            protected: { type: 'boolean', default: false },
            'maintenance-cron': { type: 'string' },
            'maintenance-tz': { type: 'string' },
          },
        })
        if (
          values.target === undefined ||
          values.engine === undefined ||
          values.environment === undefined ||
          values.owner === undefined ||
          values.criticality === undefined ||
          values['data-classification'] === undefined ||
          values['rpo-minutes'] === undefined ||
          values['rto-minutes'] === undefined
        ) {
          writeError('bkagent: asset-set requires target, engine, environment, owner, criticality, data-classification, rpo-minutes, rto-minutes\n')
          return 2
        }
        const asset: AssetDescriptor = {
          targetId: asTargetId(values.target),
          engine: values.engine,
          environment: values.environment as AssetDescriptor['environment'],
          owner: values.owner,
          criticality: values.criticality as AssetDescriptor['criticality'],
          dataClassification: values['data-classification'] as AssetDescriptor['dataClassification'],
          rpoMinutes: Number(values['rpo-minutes']),
          rtoMinutes: Number(values['rto-minutes']),
          ...(values['maintenance-cron'] === undefined && values['maintenance-tz'] === undefined
            ? {}
            : {
                maintenanceWindow: {
                  ...(values['maintenance-cron'] === undefined
                    ? {}
                    : { cron: values['maintenance-cron'] }),
                  ...(values['maintenance-tz'] === undefined
                    ? {}
                    : { timezone: values['maintenance-tz'] }),
                },
              }),
          protected: values.protected,
        }
        const issues = validateAsset(asset)
        if (issues.length > 0) {
          write(`${JSON.stringify({ ok: false, issues }, null, 2)}\n`)
          return 4
        }
        await withRepo(resolveDb(values.db), async (repo) => repo.assets.upsert(asset))
        write(`${JSON.stringify(asset, null, 2)}\n`)
        return 0
      }

      case 'asset-list': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: { db: { type: 'string' }, format: { type: 'string', default: 'json' } },
        })
        const assets = await withRepo(resolveDb(values.db), async (repo) => repo.assets.list())
        if (values.format === 'text') {
          write(
            `${assets
              .map(
                (asset) =>
                  `${asset.targetId} ${asset.environment}/${asset.criticality} owner=${asset.owner} rpo=${asset.rpoMinutes}m rto=${asset.rtoMinutes}m protected=${asset.protected}`,
              )
              .join('\n')}\n`,
          )
        } else {
          write(`${JSON.stringify(assets, null, 2)}\n`)
        }
        return 0
      }

      case 'asset-rpo': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: { db: { type: 'string' } },
        })
        const status = await withRepo(resolveDb(values.db), async (repo) => {
          const assets = await repo.assets.list()
          const artifacts = await repo.artifacts.list({})
          return evaluateAssetRpo(assets, artifacts, new Date())
        })
        write(`${JSON.stringify(status, null, 2)}\n`)
        return 0
      }

      case 'model-policy': {
        const [subcommand, ...policyArgs] = rest
        if (subcommand !== 'show' && subcommand !== 'check') {
          writeError('bkagent: model-policy requires show|check\n')
          return 2
        }
        const { values } = parseArgs({
          args: policyArgs,
          allowPositionals: false,
          options: {
            file: { type: 'string' },
            task: { type: 'string' },
            'input-tokens': { type: 'string' },
            'output-tokens': { type: 'string' },
          },
        })
        if (values.file === undefined) {
          writeError('bkagent: model-policy requires --file\n')
          return 2
        }
        const document = parseModelPolicy(JSON.parse(readFileSync(values.file, 'utf8')) as unknown)
        if (subcommand === 'show') {
          write(`${JSON.stringify(document, null, 2)}\n`)
          return 0
        }
        if (
          values.task === undefined ||
          values['input-tokens'] === undefined ||
          values['output-tokens'] === undefined
        ) {
          writeError('bkagent: model-policy check requires --task --input-tokens --output-tokens\n')
          return 2
        }
        const policy = policyFor(document, values.task)
        if (policy === undefined) {
          writeError(`bkagent: no policy for task "${values.task}"\n`)
          return 2
        }
        const usage = {
          task: values.task,
          model: policy.model,
          inputTokens: parseNonNegativeInt(values['input-tokens'], '--input-tokens'),
          outputTokens: parseNonNegativeInt(values['output-tokens'], '--output-tokens'),
        }
        write(`${JSON.stringify({ policy, usage, check: checkBudget(usage, policy) }, null, 2)}\n`)
        return 0
      }

      case 'cost': {
        const [subcommand, ...costArgs] = rest
        if (subcommand !== 'record' && subcommand !== 'report') {
          writeError('bkagent: cost requires record|report\n')
          return 2
        }
        if (subcommand === 'record') {
          const { values } = parseArgs({
            args: costArgs,
            allowPositionals: false,
            options: {
              db: { type: 'string' },
              ticket: { type: 'string' },
              task: { type: 'string' },
              model: { type: 'string' },
              'input-tokens': { type: 'string' },
              'output-tokens': { type: 'string' },
              'input-per-1k': { type: 'string' },
              'output-per-1k': { type: 'string' },
              policy: { type: 'string' },
            },
          })
          if (
            values.task === undefined ||
            values.model === undefined ||
            values['input-tokens'] === undefined ||
            values['output-tokens'] === undefined
          ) {
            writeError('bkagent: cost record requires --task --model --input-tokens --output-tokens\n')
            return 2
          }
          let inputPer1k = values['input-per-1k'] === undefined ? 0 : Number(values['input-per-1k'])
          let outputPer1k = values['output-per-1k'] === undefined ? 0 : Number(values['output-per-1k'])
          if (values.policy !== undefined) {
            const document = parseModelPolicy(
              JSON.parse(readFileSync(values.policy, 'utf8')) as unknown,
            )
            const policy = policyFor(document, values.task)
            if (policy === undefined) {
              writeError(`bkagent: no policy for task "${values.task}"\n`)
              return 2
            }
            inputPer1k = policy.inputPer1k
            outputPer1k = policy.outputPer1k
          }
          const usage = {
            task: values.task,
            model: values.model,
            inputTokens: parseNonNegativeInt(values['input-tokens'], '--input-tokens'),
            outputTokens: parseNonNegativeInt(values['output-tokens'], '--output-tokens'),
          }
          const costUsd = estimateCost(usage, { inputPer1k, outputPer1k })
          const record = {
            id: newId('mu'),
            ticketId: values.ticket === undefined ? null : asTicketId(values.ticket),
            ...usage,
            costUsd,
            createdAt: new Date().toISOString(),
          }
          await withRepo(resolveDb(values.db), async (repo) => repo.modelUsage.insert(record))
          write(`${JSON.stringify(record, null, 2)}\n`)
          return 0
        }

        const { values } = parseArgs({
          args: costArgs,
          allowPositionals: false,
          options: { db: { type: 'string' }, since: { type: 'string' } },
        })
        const since = parseSince(values.since, 30)
        const usage = await withRepo(resolveDb(values.db), async (repo) =>
          repo.modelUsage.listSince(since),
        )
        const byTask = new Map<string, { task: string; model: string; calls: number; tokens: number; costUsd: number }>()
        for (const record of usage) {
          const key = `${record.task}/${record.model}`
          const entry = byTask.get(key) ?? {
            task: record.task,
            model: record.model,
            calls: 0,
            tokens: 0,
            costUsd: 0,
          }
          entry.calls += 1
          entry.tokens += record.inputTokens + record.outputTokens
          entry.costUsd += record.costUsd
          byTask.set(key, entry)
        }
        write(
          `${JSON.stringify({ since, calls: usage.length, costUsd: usage.reduce((sum, record) => sum + record.costUsd, 0), byTask: [...byTask.values()] }, null, 2)}\n`,
        )
        return 0
      }

      case 'approve': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            target: { type: 'string' },
            digest: { type: 'string' },
            approver: { type: 'string' },
            reject: { type: 'boolean', default: false },
            reason: { type: 'string' },
          },
        })
        if (
          values.target === undefined ||
          values.digest === undefined ||
          values.approver === undefined
        ) {
          writeError('bkagent: approve requires --target --digest --approver\n')
          return 2
        }
        const approval = {
          id: newId('apr'),
          targetId: asTargetId(values.target),
          configDigest: values.digest,
          approver: values.approver,
          decision: values.reject ? ('reject' as const) : ('approve' as const),
          reason: values.reason ?? null,
          createdAt: new Date().toISOString(),
        }
        await withRepo(resolveDb(values.db), async (repo) => repo.approvals.record(approval))
        write(`${JSON.stringify(approval, null, 2)}\n`)
        return 0
      }

      case 'approvals': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            target: { type: 'string' },
            digest: { type: 'string' },
            'ttl-minutes': { type: 'string', default: '60' },
          },
        })
        if (values.target === undefined || values.digest === undefined) {
          writeError('bkagent: approvals requires --target and --digest\n')
          return 2
        }
        const ttlMs = parseNonNegativeInt(values['ttl-minutes'], '--ttl-minutes') * 60_000
        const since = new Date(Date.now() - ttlMs).toISOString()
        const approvals = await withRepo(resolveDb(values.db), async (repo) =>
          repo.approvals.listFor(asTargetId(values.target as string), values.digest as string, since),
        )
        const status = fourEyesStatus('production-destructive', approvals, new Date(), ttlMs)
        write(
          `${JSON.stringify({ targetId: values.target, digest: values.digest, status, approvals }, null, 2)}\n`,
        )
        return 0
      }

      default:
        writeError(`bkagent: unknown command "${command}"\n`)
        return 2
    }
  } catch (error) {
    return handleError(error, writeError)
  }
}
