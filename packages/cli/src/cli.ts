import { readFileSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  ConnectionError,
  LocalExecutor,
  asMandateId,
  asTicketId,
  connectionEnv,
  newId,
  requiresApproval,
  runPlan,
  validatePlan,
  withDatabase,
  type Executor,
  type InstanceInfo,
  type LogicalBackupRequest,
  type LogicalFormat,
  type LogicalRestoreRequest,
  type MandateRecord,
  type Plan,
  type PlanBuildContext,
  type PlanValidationIssue,
} from '@backup-agent/core'
import {
  ProbeError,
  artifactDatabase,
  buildPhysicalBackupPlan,
  buildPitrRestorePlan,
  postgresEngine,
  requestDigest,
  verifyLogicalRestore,
  type PhysicalBackupRequest,
  type PitrRestoreRequest,
} from '@backup-agent/engine-postgres'

import { inspectInstance, parseDsn } from './inspect'

const USAGE = `bkagent — PostgreSQL backup and restore agent

Usage:
  bkagent inspect --dsn <uri> [--format json|text]
  bkagent backup  --dsn <uri> --out <path> [--mode logical|physical] [--database <db>]
                  [--format custom|directory|plain|tar] [--jobs N] [--compress N]
                  [--table t]... [--schema s]... [--wal-method stream|fetch] [--label L]
  bkagent restore --dsn <uri> --input <path> [--database <db>] [--format custom|directory|plain]
                  [--create-database] [--clean] [--if-exists] [--no-owner] [--jobs N] [--yes]
  bkagent verify  --dsn <uri> --input <path> [--database <source-db>] [--format custom|directory|plain]
                  [--jobs N] [--no-owner] [--keep-scratch]
  bkagent pitr    --dsn <uri> --data-dir <dir> --port <n> --log <path> --restore-command <cmd>
                  (--target-time <ts> | --target-lsn <lsn> | --target-name <name> | --target-xid <xid>)
                  [--action promote|pause|shutdown] [--verify-sql <sql>] [--yes]

Environment:
  BKAGENT_DSN    Default DSN when --dsn is omitted

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

function planContext(instance: InstanceInfo, digest: string): PlanBuildContext {
  const now = new Date().toISOString()
  return {
    ticketId: asTicketId(newId('tkt')),
    mandateId: asMandateId(newId('mnd')),
    now,
    instance,
    configDigest: digest,
  }
}

function mandateFor(plan: Plan, principalId: string): MandateRecord {
  const now = new Date().toISOString()
  return {
    id: plan.mandateId,
    ticketId: plan.ticketId,
    principalId,
    scope: plan.provider,
    policyVersion: 'cli',
    allowedRisk: plan.risk,
    issuedAt: now,
    expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
  }
}

function validate(plan: Plan, principalId: string): PlanValidationIssue[] {
  const now = new Date().toISOString()
  return validatePlan(plan, {
    now,
    declaredCapabilities: postgresEngine.capabilities,
    requiredCapabilities: [],
    mandate: mandateFor(plan, principalId),
    resources: { availableBytes: Number.MAX_SAFE_INTEGER, maxConcurrency: 8 },
    policyValid: true,
  })
}

async function applyPlan(
  plan: Plan,
  instance: InstanceInfo,
  executor: Executor,
  deps: CliDeps,
  stateDir: string | undefined,
  env: Readonly<Record<string, string>>,
): Promise<Awaited<ReturnType<typeof runPlan>>> {
  const writeError = deps.stderr ?? ((text: string) => process.stderr.write(text))
  return runPlan(plan, {
    executor,
    env,
    systemIdentifier: instance.systemIdentifier,
    ...(stateDir === undefined ? {} : { stateDir }),
    onStep: (event) => {
      if (event.type === 'start') writeError(`[${event.stepId}] running\n`)
    },
  })
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

function issueText(issues: readonly PlanValidationIssue[]): string {
  return JSON.stringify({ ok: false, issues }, null, 2)
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
            'state-dir': { type: 'string' },
          },
        })
        const dsn = values.dsn ?? env.BKAGENT_DSN
        if (dsn === undefined || values.out === undefined) {
          writeError('bkagent: backup requires --dsn and --out\n')
          return 2
        }
        const mode = values.mode ?? 'logical'
        if (mode !== 'logical' && mode !== 'physical') {
          writeError(`bkagent: unsupported mode "${mode}"\n`)
          return 2
        }
        const connection = parseDsn(dsn)
        const instance = await postgresEngine.probe(executor, connection)
        const principal = principalFor(values.principal, env)

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
          const ctx = planContext(instance, requestDigest(physical))
          const plan = buildPhysicalBackupPlan(physical, ctx)
          const issues = validate(plan, principal)
          if (issues.length > 0) {
            write(`${issueText(issues)}\n`)
            return 4
          }
          const result = await applyPlan(
            plan,
            instance,
            executor,
            deps,
            values['state-dir'],
            connectionEnv(connection),
          )
          write(
            `${JSON.stringify({ planId: plan.planId, risk: plan.risk, steps: plan.steps.map((step) => step.stepId), result }, null, 2)}\n`,
          )
          return result.status === 'succeeded' ? 0 : 1
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
        const ctx = planContext(instance, requestDigest(request))
        const plan = postgresEngine.planLogicalBackup(request, ctx)
        const issues = validate(plan, principal)
        if (issues.length > 0) {
          write(`${issueText(issues)}\n`)
          return 4
        }
        const result = await applyPlan(
          plan,
          instance,
          executor,
          deps,
          values['state-dir'],
          connectionEnv(connection),
        )
        write(
          `${JSON.stringify({ planId: plan.planId, risk: plan.risk, steps: plan.steps.map((step) => step.stepId), result }, null, 2)}\n`,
        )
        return result.status === 'succeeded' ? 0 : 1
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
            'state-dir': { type: 'string' },
          },
        })
        const dsn = values.dsn ?? env.BKAGENT_DSN
        if (dsn === undefined || values.input === undefined) {
          writeError('bkagent: restore requires --dsn and --input\n')
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
        const ctx = planContext(instance, requestDigest(request))
        const plan = postgresEngine.planLogicalRestore(request, ctx)
        if (requiresApproval(plan.risk) && !values.yes) {
          writeError(`bkagent: plan risk is ${plan.risk}; re-run with --yes to proceed\n`)
          return 2
        }
        const issues = validate(plan, principalFor(values.principal, env))
        if (issues.length > 0) {
          write(`${issueText(issues)}\n`)
          return 4
        }
        const result = await applyPlan(
          plan,
          instance,
          executor,
          deps,
          values['state-dir'],
          connectionEnv(connection),
        )
        write(
          `${JSON.stringify({ planId: plan.planId, risk: plan.risk, steps: plan.steps.map((step) => step.stepId), result }, null, 2)}\n`,
        )
        return result.status === 'succeeded' ? 0 : 1
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

        const ctx = planContext(instance, requestDigest(request))
        const plan = buildPitrRestorePlan(request, ctx)
        if (!values.yes) {
          writeError(`bkagent: plan risk is ${plan.risk}; re-run with --yes to proceed\n`)
          return 2
        }
        const issues = validate(plan, principalFor(values.principal, env))
        if (issues.length > 0) {
          write(`${issueText(issues)}\n`)
          return 4
        }
        const pitrEnv = connectionEnv(
          withDatabase({ ...connection, host: '127.0.0.1', port: values.port }, 'postgres'),
        )
        const result = await applyPlan(
          plan,
          instance,
          executor,
          deps,
          values['state-dir'],
          pitrEnv,
        )
        write(
          `${JSON.stringify({ planId: plan.planId, risk: plan.risk, steps: plan.steps.map((step) => step.stepId), result }, null, 2)}\n`,
        )
        return result.status === 'succeeded' ? 0 : 1
      }

      default:
        writeError(`bkagent: unknown command "${command}"\n`)
        return 2
    }
  } catch (error) {
    return handleError(error, writeError)
  }
}
