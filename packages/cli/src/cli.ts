import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'

import {
  APPROVAL_TTL_MS,
  ConnectionError,
  LocalExecutor,
  FsStorage,
  KubectlExecutor,
  LOCAL_TRANSPORT,
  createExecutorForTransport,
  describeTransport,
  fsArtifactSink,
  isRemoteTransport,
  s3ArtifactSink,
  storeArtifact,
  PrincipalError,
  S3Storage,
  applyOrphanGc,
  applyPurge,
  planOrphanGc,
  planPurge,
  SmtpNotifier,
  SshExecutor,
  WebhookNotifier,
  asArtifactId,
  asPlanId,
  asTargetId,
  asTicketId,
  assetProtectionDigest,
  buildOpsReport,
  checkBudget,
  classifyRetentionProvider,
  connectionEnv,
  digestArtifact,
  estimateCost,
  evaluateAssetRpo,
  evaluateAlerts,
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
  weakensProtection,
  withDatabase,
  type Executor,
  type InstanceInfo,
  type LogicalBackupRequest,
  type LogicalFormat,
  type LogicalRestoreRequest,
  type Notifier,
  type ArtifactSink,
  type ConnectionParams,
  type Plan,
  type PlanBuildContext,
  type TransportSpec,
  type SmtpNotifierOptions,
  type Storage,
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
  formatLsn,
  postgresEngine,
  preflightPitrTarget,
  recoverableWindow,
  requestDigest,
  verifyLogicalRestore,
  type PhysicalBackupRequest,
  type PitrRestoreRequest,
} from '@backup-agent/engine-postgres'

import {
  OUTBOX_TOPIC_RUN_AUDIT,
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
import { runGoalCommand } from './goal'

const USAGE = `bkagent — PostgreSQL backup and restore agent

Usage:
  bkagent inspect --dsn <uri> [--format json|text]
  bkagent providers [--dsn <uri>] [--format json|text]
  bkagent exec --transport ssh --host <user@host> --known-hosts <file>
              [--port N] [--identity <key>] [--timeout-ms N] -- <argv...>
  bkagent exec --transport kubectl --pod <pod> [--namespace N] [--container C]
              [--context C] [--kubeconfig <path>] [--timeout-ms N] -- <argv...>
  bkagent backup  --dsn <uri> --out <path> [--mode logical|physical] [--database <db>]
                  [--format custom|directory|plain|tar] [--jobs N] [--compress N]
                  [--table t]... [--schema s]... [--wal-method stream|fetch] [--label L]
  bkagent restore --dsn <uri> --input <path> [--database <db>] [--format custom|directory|plain]
                  [--create-database] [--clean] [--if-exists] [--no-owner] [--jobs N] [--yes]
                  [--state-dir <dir> [--resume]] [--db <control-db>]
  bkagent verify  --dsn <uri> --input <path> [--database <source-db>] [--format custom|directory|plain]
                  [--jobs N] [--no-owner] [--keep-scratch] [--db <control-db>]
  bkagent pitr    --dsn <uri> --data-dir <dir> --port <n> --log <path> --restore-command <cmd>
                  (--target-time <ts> | --target-lsn <lsn> | --target-name <name> | --target-xid <xid>)
                  [--action promote|pause|shutdown] [--verify-sql <sql>] [--yes]
                  [--state-dir <dir> [--resume]] [--db <control-db>]
  bkagent pgbackrest-backup  --config <path> --stanza <name> [--type full|diff|incr] [--ensure-stanza]
                             [--db <control-db>]
  bkagent pgbackrest-restore --config <path> --stanza <name> --data-dir <dir>
                             [--target-type time|lsn|xid|name|immediate] [--target <value>]
                             [--start-port <n>] [--log <path>] [--yes] [--db <control-db>]
                             [--state-dir <dir> [--resume]]
  bkagent pgbackrest-expire  --config <path> --stanza <name> [--yes] [--db <control-db>]
  bkagent walg-backup  --data-dir <PGDATA> [--walg <bin>] [--db <control-db>]
  bkagent walg-restore --data-dir <dir> [--backup LATEST] [--start-port <n>] [--yes] [--db <control-db>]
                       [--state-dir <dir> [--resume]]
  bkagent walg-prune   --retain-full <n> [--walg <bin>] [--yes] [--db <control-db>]
  bkagent artifact-upload --db <path> --id <artifact-id> [--storage-kind fs|nfs|s3]
                       [--storage-root <dir>] [--remove-local]
  bkagent artifact-add --db <path> --target <id> --provider <p> --kind <k> --path <path>
                       [--parent <id>] [--plan <id>] [--size N] [--verified-level V0..V3 --checksum <sha256>]
                       [--protected]
  bkagent catalog  --db <path> [--target <id>] [--provider <p>] [--since <iso|Nd>] [--limit N] [--history]
  bkagent retain   --db <path> --daily N --weekly N --monthly N [--target <id>] [--apply --yes --digest <d>]
  bkagent storage-purge --db <path> [--storage-kind fs|nfs|s3] [--storage-root <dir>] [--grace-days N]
                      [--target <id>] [--apply --yes --digest <d>]
  bkagent storage-gc    --db <path> [--storage-kind fs|nfs|s3] [--storage-root <dir>] [--grace-days N]
                      [--apply --yes --digest <d>]
  bkagent report   --db <path> [--since <iso|Nd>] [--format markdown|json]
  bkagent metrics  --db <path>
  bkagent capacity --db <path> [--threshold-gb N] [--days N]
  bkagent watchdog --db <path> [--threshold-gb N]
  bkagent outbox-dispatch --db <path> [--limit N] [--max-attempts N]
  bkagent trace    --db <path> (--ticket <id> | --plan <id>)
  bkagent notify-test --url <url> [--severity P1|P2|P3|P4] [--title <text>]
  bkagent dashboard --db <path> (--out <file> | --serve [--port N]) [--since <iso|Nd>]
  bkagent asset-set --db <path> --target <id> --engine <e> --environment <env> --owner <o>
                    --criticality <c> --data-classification <d> --rpo-minutes N --rto-minutes N
                    [--protected] [--maintenance-cron <cron>] [--maintenance-tz <tz>]
                    [--yes --principal <id>]   # required to weaken an existing asset
  bkagent asset-list --db <path> [--format json|text]
  bkagent asset-rpo  --db <path>
  bkagent model-policy show --file <path>
  bkagent model-policy check --file <path> --task <t> --input-tokens N --output-tokens N
  bkagent cost record --db <path> --task <t> --model <m> --input-tokens N --output-tokens N
                      [--ticket <id>] [--policy <file>]
  bkagent cost report --db <path> [--since <iso|Nd>]
  bkagent approve --db <path> --target <id> --digest <digest> --approver <id> [--reject] [--reason <text>]
  bkagent approvals --db <path> --target <id> --digest <digest> [--ttl-minutes N]
  bkagent goal add --db <path> --target <id> --intent <text>
                  [--steps-json <json> | --steps-file <path>]
                  [--constraints-json <json> | --constraints-file <path>]
                  [--principal <id>] [--format json|text]
  bkagent goal plan --db <path> --goal <id> [--steps-json <json> | --steps-file <path>] [--format json|text]
  bkagent goal next --db <path> --goal <id> [--format json|text]
  bkagent goal run --db <path> --goal <id> [--format json|text]
  bkagent goal show --db <path> --goal <id> [--format json|text]
  bkagent goal list --db <path> [--state <s>] [--target <id>] [--limit N] [--format json|text]
  bkagent goal approve-step --db <path> --step <id> --approver <id> [--reason <text>] [--format json|text]
  bkagent goal diagnose --db <path> --step <id> [--format json|text]
  bkagent goal remediate --db <path> --step <id> --kind retry|replan|escalate|abandon
                       [--action-json <json> | --action-file <path>] [--reason <text>] [--format json|text]
  bkagent memory search --db <path> [--target <id>] [--signature <s>] [--query <text>] [--limit N]
                      [--format json|text]

Environment:
  BKAGENT_DSN    Default DSN when --dsn is omitted
  BKAGENT_DB     Control database when --db is omitted (default .bkagent/control.db)
  BKAGENT_WEBHOOK_URL  Failure-notification webhook for outbox-dispatch (never argv)
  BKAGENT_STORAGE_ROOT  fs/nfs storage root for storage-purge / storage-gc
  BKAGENT_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY[/SESSION_TOKEN]
                       s3 storage configuration (never argv)
  BKAGENT_SMTP_HOST/PORT/FROM/TO[/USER/PASS]
                       SMTP alert channel (plaintext; no STARTTLS) used by
                       outbox-dispatch, watchdog and notify-test --smtp

Destructive plans (all logical restores, pitr, pgbackrest-restore,
pgbackrest-expire, walg-restore, walg-prune) fail closed unless all hold:
  - the live probe proves the target systemIdentifier and the plan matches it;
  - --yes is passed;
  - the control database has an asset registered for the exact plan targetId;
  - if that asset is in the production environment, two distinct current approvals exist
    for the plan digest (see bkagent approve / bkagent approvals).

Weakening an existing asset (production -> other environment, protected -> not
protected, lower criticality) is gated the same way: --yes plus two approvals
bound to the asset change digest printed by the refusal.

V2/V3 evidence enters the catalog through a passing \`bkagent verify\` run (which
writes the level and a content digest) or \`artifact-add\` with an explicit
--checksum; a level alone is refused.

Artifact storage: \`backup --storage-kind fs|nfs|s3 [--storage-root <dir>] [--remove-local]\`
uploads the produced file into the configured Storage, records its location and a
sha256 digest, and fails the run if the upload fails. \`artifact-upload\` does the
same for an existing catalog row.

Transport (every command except \`exec\`):
  --transport local|ssh|kubectl
  ssh:      --ssh-host <user@host> --known-hosts <file> [--ssh-port N] [--identity <key>]
  kubectl:  --kubectl-pod <pod> [--namespace N] [--container C] [--context C] [--kubeconfig <path>]
  The transport is recorded on the Plan and selected at execution. Remote plans
  never forward the child environment: provision credentials on the target host
  (.pgpass / peer / GSSAPI). A DSN password is not forwarded.

Provider readiness: \`bkagent providers --dsn ...\` probes tool versions (via
--version) and the server version matrix; it exits 1 when a registered provider
cannot run. Descriptors declare capabilities, so an unsupported request is
refused instead of silently downgraded.

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

/**
 * SMTP configuration from the environment. All-or-nothing: a host without a
 * sender/recipient list is a configuration error, not a silent no-op.
 */
function smtpOptionsFromEnv(env: NodeJS.ProcessEnv): SmtpNotifierOptions | undefined {
  const host = env.BKAGENT_SMTP_HOST
  if (host === undefined || host.trim() === '') return undefined
  const from = env.BKAGENT_SMTP_FROM
  const to = env.BKAGENT_SMTP_TO
  if (from === undefined || from.trim() === '' || to === undefined || to.trim() === '') {
    throw new Error('BKAGENT_SMTP_HOST requires BKAGENT_SMTP_FROM and BKAGENT_SMTP_TO')
  }
  const port = Number(env.BKAGENT_SMTP_PORT ?? '25')
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('BKAGENT_SMTP_PORT must be an integer between 1 and 65535')
  }
  const recipients = to
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '')
  if (recipients.length === 0) {
    throw new Error('BKAGENT_SMTP_TO must list at least one recipient')
  }
  const user = env.BKAGENT_SMTP_USER
  const pass = env.BKAGENT_SMTP_PASS
  return {
    host: host.trim(),
    port,
    from: from.trim(),
    to: recipients,
    ...(user === undefined || user.trim() === '' ? {} : { user: user.trim() }),
    ...(pass === undefined || pass === '' ? {} : { pass }),
  }
}

/**
 * Delivery channel for alerts and failure notifications: SMTP when configured,
 * otherwise the webhook, otherwise null (the caller decides whether silence is
 * acceptable; the outbox dispatcher fails closed, the watchdog does not).
 */
function notifierFor(env: NodeJS.ProcessEnv): Notifier | null {
  const smtp = smtpOptionsFromEnv(env)
  if (smtp !== undefined) return new SmtpNotifier(smtp)
  const webhook = env.BKAGENT_WEBHOOK_URL
  if (webhook === undefined || webhook.trim() === '') return null
  return new WebhookNotifier(webhook.trim())
}

/**
 * Deterministic digest of a purge/GC plan. `--apply` is bound to the digest a
 * dry run printed, so the reviewed set and the deleted set cannot differ.
 */
function planDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

interface StorageWiring {
  readonly storage: Storage
  readonly keyOf: (artifact: ArtifactRecord) => string | null
}

interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

/** S3 configuration from the environment; credentials never come from argv. */
function s3ConfigFromEnv(env: NodeJS.ProcessEnv): S3Config {
  const endpoint = env.BKAGENT_S3_ENDPOINT
  const region = env.BKAGENT_S3_REGION
  const bucket = env.BKAGENT_S3_BUCKET
  const accessKeyId = env.BKAGENT_S3_ACCESS_KEY_ID
  const secretAccessKey = env.BKAGENT_S3_SECRET_ACCESS_KEY
  if (
    endpoint === undefined ||
    region === undefined ||
    bucket === undefined ||
    accessKeyId === undefined ||
    secretAccessKey === undefined
  ) {
    throw new Error(
      's3 storage requires BKAGENT_S3_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY',
    )
  }
  const sessionToken = env.BKAGENT_S3_SESSION_TOKEN
  return {
    endpoint,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(sessionToken === undefined ? {} : { sessionToken }),
  }
}

/**
 * Builds the artifact sink from CLI flags. Absent storage flags mean "keep the
 * artifact where the step wrote it" (the local path), so nothing changes for
 * operators who do not configure storage.
 */
function artifactSinkFromCli(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): ArtifactSink | undefined {
  const kindRaw = values['storage-kind']
  const rootRaw = values['storage-root']
  if (kindRaw === undefined && rootRaw === undefined) return undefined
  const kind = typeof kindRaw === 'string' ? kindRaw : 'fs'
  const keepsLocalCopy = values['remove-local'] !== true
  if (kind === 'fs' || kind === 'nfs') {
    const root =
      (typeof rootRaw === 'string' ? rootRaw : undefined) ?? env.BKAGENT_STORAGE_ROOT
    if (root === undefined || root.trim() === '') {
      throw new Error('--storage-root (or BKAGENT_STORAGE_ROOT) is required for fs/nfs')
    }
    return fsArtifactSink({ root, kind, keepsLocalCopy })
  }
  if (kind === 's3') {
    return s3ArtifactSink({ ...s3ConfigFromEnv(env), keepsLocalCopy })
  }
  throw new Error(`unsupported storage kind "${kind}" (expected fs, nfs or s3)`)
}

/**
 * Builds the Storage implementation and the artifact-path → key mapping.
 *
 * Only self-managed roots are addressable here: a path outside the configured
 * root (or an `s3://` path in another bucket) maps to `null`, and the purge/GC
 * planners then skip it instead of deleting something they cannot account for.
 * S3 credentials come from the environment, never argv.
 */
function storageFromCli(
  values: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): StorageWiring {
  const kind = typeof values['storage-kind'] === 'string' ? values['storage-kind'] : 'fs'
  if (kind === 'fs' || kind === 'nfs') {
    const root =
      (typeof values['storage-root'] === 'string' ? values['storage-root'] : undefined) ??
      env.BKAGENT_STORAGE_ROOT
    if (root === undefined || root.trim() === '') {
      throw new Error('--storage-root (or BKAGENT_STORAGE_ROOT) is required for fs/nfs storage')
    }
    const base = resolve(root)
    const storage = new FsStorage({ root: base, kind })
    return {
      storage,
      keyOf: (artifact) => {
        const full = resolve(artifact.path)
        if (!full.startsWith(base + sep)) return null
        return full.slice(base.length + 1).split(sep).join('/')
      },
    }
  }
  if (kind === 's3') {
    const config = s3ConfigFromEnv(env)
    const prefix = `s3://${config.bucket}/`
    return {
      storage: new S3Storage(config),
      keyOf: (artifact) =>
        artifact.path.startsWith(prefix) ? artifact.path.slice(prefix.length) : null,
    }
  }
  throw new Error(`unsupported storage kind "${kind}" (expected fs, nfs or s3)`)
}

const TRANSPORT_FLAGS: ReadonlySet<string> = new Set([
  '--transport',
  '--ssh-host',
  '--known-hosts',
  '--ssh-port',
  '--identity',
  '--kubectl-pod',
  '--namespace',
  '--container',
  '--context',
  '--kubeconfig',
])

/**
 * Lifts the transport flags out of argv before command dispatch: transport is an
 * execution-wide choice, so every command that probes or runs a plan sees the
 * same one. `exec` is excluded — it takes its own transport flags.
 */
function extractTransportArgs(argv: readonly string[]): {
  args: string[]
  transport: TransportSpec
} {
  const values = new Map<string, string>()
  const args: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) break
    if (token === '--') {
      args.push(...argv.slice(index))
      break
    }
    const equals = token.startsWith('--') ? token.indexOf('=') : -1
    const name = equals > 0 ? token.slice(0, equals) : token
    if (TRANSPORT_FLAGS.has(name)) {
      const value = equals > 0 ? token.slice(equals + 1) : argv[index + 1]
      if (value === undefined) throw new Error(`${name} requires a value`)
      values.set(name, value)
      if (equals < 0) index += 1
      continue
    }
    args.push(token)
  }

  const kind = values.get('--transport') ?? 'local'
  if (kind === 'local') {
    for (const flag of values.keys()) {
      if (flag !== '--transport') {
        throw new Error(`${flag} is only valid with --transport ssh|kubectl`)
      }
    }
    return { args, transport: LOCAL_TRANSPORT }
  }
  if (kind === 'ssh') {
    const host = values.get('--ssh-host')
    const knownHostsFile = values.get('--known-hosts')
    if (host === undefined || host.trim() === '') {
      throw new Error('--transport ssh requires --ssh-host')
    }
    if (knownHostsFile === undefined || knownHostsFile.trim() === '') {
      throw new Error('--transport ssh requires --known-hosts (host-key pinning is not optional)')
    }
    const portRaw = values.get('--ssh-port')
    const port = portRaw === undefined ? undefined : Number(portRaw)
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      throw new Error('--ssh-port must be an integer between 1 and 65535')
    }
    const identityFile = values.get('--identity')
    return {
      args,
      transport: {
        kind: 'ssh',
        host: host.trim(),
        knownHostsFile: knownHostsFile.trim(),
        ...(port === undefined ? {} : { port }),
        ...(identityFile === undefined ? {} : { identityFile }),
      },
    }
  }
  if (kind === 'kubectl') {
    const pod = values.get('--kubectl-pod')
    if (pod === undefined || pod.trim() === '') {
      throw new Error('--transport kubectl requires --kubectl-pod')
    }
    const namespace = values.get('--namespace')
    const container = values.get('--container')
    const context = values.get('--context')
    const kubeconfig = values.get('--kubeconfig')
    return {
      args,
      transport: {
        kind: 'kubectl',
        pod: pod.trim(),
        ...(namespace === undefined ? {} : { namespace }),
        ...(container === undefined ? {} : { container }),
        ...(context === undefined ? {} : { context }),
        ...(kubeconfig === undefined ? {} : { kubeconfig }),
      },
    }
  }
  throw new Error(`unsupported transport "${kind}" (expected local, ssh or kubectl)`)
}

/** Credential note for a remote run: nothing is forwarded, so say so once. */
function remoteCredentialNote(
  transport: TransportSpec,
  connection: ConnectionParams,
): string | undefined {
  if (!isRemoteTransport(transport)) return undefined
  return connection.password === undefined
    ? `bkagent: running over ${describeTransport(transport)}; credentials come from the target host (no environment is forwarded)\n`
    : `bkagent: running over ${describeTransport(transport)}; the DSN password is not forwarded — provision credentials on the target host (.pgpass/peer/GSSAPI)\n`
}

/** Remote transports authenticate on the target host; local keeps the env. */
function probeOptions(transport: TransportSpec): { credentials?: 'env' | 'target' } {
  return transport.kind === 'local' ? {} : { credentials: 'target' }
}

const TRANSPORT_COMMANDS: ReadonlySet<string> = new Set([
  'inspect',
  'providers',
  'backup',
  'restore',
  'pitr',
  'pgbackrest-backup',
  'pgbackrest-restore',
  'pgbackrest-expire',
  'walg-backup',
  'walg-restore',
  'walg-prune',
])

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
  transport: TransportSpec,
): Promise<InstanceInfo> {
  return dsn === undefined
    ? syntheticInstance()
    : postgresEngine.probe(executor, parseDsn(dsn), probeOptions(transport))
}

async function providerContext(
  dsn: string | undefined,
  executor: Executor,
  digest: string,
  transport: TransportSpec,
): Promise<PlanBuildContext> {
  const instance = await probeTarget(dsn, executor, transport)
  return buildPlanContext(instance, digest, transport)
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

/**
 * Records that an artifact passed V2 verification.
 *
 * Without this the catalog can only learn about V2/V3 evidence from a human
 * typing `artifact-add --verified-level`, which is exactly the "claimed but not
 * proven" case VRP is meant to exclude. The digest is written alongside the
 * level so later tampering is detectable; a `null` digest leaves any existing
 * checksum in place.
 */
async function recordVerifiedArtifact(
  controlDb: string,
  inputPath: string,
  note: (text: string) => void,
): Promise<void> {
  const checksum = digestArtifact(inputPath)
  if (checksum === null) {
    note(`bkagent: cannot read ${inputPath}; V2 evidence was not recorded\n`)
    return
  }
  try {
    await withRepo(controlDb, async (repo) => {
      const artifacts = await repo.artifacts.list({})
      const matches = artifacts
        .filter((artifact) => resolve(artifact.path) === resolve(inputPath))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      const latest = matches[0]
      if (latest === undefined) {
        note(`bkagent: ${inputPath} is not cataloged; V2 evidence was not recorded\n`)
        return
      }
      const verifiedAt = new Date().toISOString()
      const updated = await repo.artifacts.markVerified({
        id: latest.id,
        level: 'V2',
        verifiedAt,
        checksum,
      })
      note(
        updated
          ? `bkagent: artifact ${latest.id} recorded as V2 at ${verifiedAt}\n`
          : `bkagent: artifact ${latest.id} could not be updated; V2 evidence was not recorded\n`,
      )
    })
  } catch (error) {
    note(`bkagent: recording V2 evidence failed: ${(error as Error).message}\n`)
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
  const resolveDb = (value: string | undefined): string =>
    value ?? env.BKAGENT_DB ?? DEFAULT_DB_PATH

  // `exec` carries its own transport flags; every other command shares one.
  const isExecCommand = argv[0] === 'exec'
  let transport: TransportSpec = LOCAL_TRANSPORT
  let dispatchArgs: readonly string[] = argv
  if (!isExecCommand) {
    try {
      const extracted = extractTransportArgs(argv)
      transport = extracted.transport
      dispatchArgs = extracted.args
    } catch (error) {
      writeError(`bkagent: ${(error as Error).message}\n`)
      return 2
    }
  }
  const baseExecutor = deps.executor ?? new LocalExecutor()
  const executor = transport.kind === 'local'
    ? baseExecutor
    : createExecutorForTransport(transport)

  const [command, ...rest] = dispatchArgs
  if (
    transport.kind !== 'local' &&
    command !== undefined &&
    !TRANSPORT_COMMANDS.has(command)
  ) {
    writeError(
      `bkagent: --transport applies to ${[...TRANSPORT_COMMANDS].join(', ')}; ` +
        `"${command}" runs against the control plane itself\n`,
    )
    return 2
  }
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
        const info = await inspectInstance(executor, parseDsn(dsn), probeOptions(transport))
        write(format === 'json' ? `${JSON.stringify(info, null, 2)}\n` : renderText(info))
        return 0
      }

      case 'providers': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            dsn: { type: 'string' },
            format: { type: 'string', default: 'json' },
          },
        })
        const format = values.format ?? 'json'
        if (format !== 'json' && format !== 'text') {
          writeError(`bkagent: unsupported format "${format}"\n`)
          return 2
        }
        const engine = postgresEngine.descriptor
        const descriptors = [...postgresEngine.providers.values()].map((provider) => ({
          id: provider.descriptor.id,
          capabilities: [...provider.descriptor.capabilities].sort(),
          ownership: provider.descriptor.ownership,
          versionRange: provider.descriptor.versionRange,
          tools: provider.descriptor.tools,
        }))
        const engineFacts = {
          id: engine.id,
          capabilities: [...engine.capabilities].sort(),
          versionRange: engine.versionRange,
          tools: engine.tools,
        }
        const dsn = values.dsn ?? env.BKAGENT_DSN
        if (dsn === undefined || dsn.trim() === '') {
          // A descriptor-only listing needs no server; nothing is probed.
          write(
            format === 'json'
              ? `${JSON.stringify({ engine: engineFacts, providers: descriptors }, null, 2)}\n`
              : `${engine.id} ${engine.versionRange.min}-${engine.versionRange.max ?? '?'}: ` +
                  `${descriptors.map((provider) => provider.id).join(', ')}\n`,
          )
          return 0
        }

        const instance = await postgresEngine.probe(executor, parseDsn(dsn), probeOptions(transport))
        const context = buildPlanContext(instance, 'providers')
        const preflights = []
        for (const provider of postgresEngine.providers.values()) {
          preflights.push({
            ...descriptors.find((descriptor) => descriptor.id === provider.descriptor.id),
            id: provider.descriptor.id,
            preflight: await provider.preflight(executor, undefined as never, context),
          })
        }
        const server = {
          version: instance.version,
          major: Math.floor(instance.serverVersionNum / 10_000),
          timelineId: instance.timelineId ?? null,
        }
        const healthy = preflights.every((entry) => entry.preflight.ok)
        write(
          format === 'json'
            ? `${JSON.stringify({ engine: engineFacts, server, providers: preflights }, null, 2)}\n`
            : preflights
                .map((entry) => {
                  const issues = entry.preflight.issues
                    .map((issue) => `${issue.code}${issue.tool === undefined ? '' : `(${issue.tool})`}: ${issue.message}`)
                    .join('; ')
                  return `${entry.id}: ${entry.preflight.ok ? 'ok' : `NOT READY — ${issues}`}`
                })
                .join('\n') + '\n',
        )
        return healthy ? 0 : 1
      }

      case 'exec': {
        const { values, positionals } = parseArgs({
          args: [...rest],
          allowPositionals: true,
          options: {
            transport: { type: 'string', default: 'ssh' },
            host: { type: 'string' },
            'known-hosts': { type: 'string' },
            port: { type: 'string' },
            identity: { type: 'string' },
            pod: { type: 'string' },
            namespace: { type: 'string' },
            container: { type: 'string' },
            context: { type: 'string' },
            kubeconfig: { type: 'string' },
            'timeout-ms': { type: 'string' },
          },
        })
        // Everything after `--` is the remote argv; it is never interpreted by a
        // local shell and, over SSH, is POSIX-quoted as a single transport string.
        const remoteArgv = positionals.filter((value) => value !== '--')
        if (remoteArgv.length === 0) {
          writeError('bkagent: exec requires a command after --\n')
          return 2
        }
        const timeoutMs =
          values['timeout-ms'] === undefined
            ? undefined
            : parsePositiveInt(values['timeout-ms'], '--timeout-ms')
        const transport = values.transport ?? 'ssh'
        let remote: Executor
        if (transport === 'ssh') {
          if (values.host === undefined || values['known-hosts'] === undefined) {
            writeError('bkagent: exec --transport ssh requires --host and --known-hosts\n')
            return 2
          }
          remote = new SshExecutor({
            host: values.host,
            knownHostsFile: values['known-hosts'],
            ...(values.port === undefined
              ? {}
              : { port: parsePositiveInt(values.port, '--port') as number }),
            ...(values.identity === undefined ? {} : { identityFile: values.identity }),
          })
        } else if (transport === 'kubectl') {
          if (values.pod === undefined) {
            writeError('bkagent: exec --transport kubectl requires --pod\n')
            return 2
          }
          remote = new KubectlExecutor({
            pod: values.pod,
            ...(values.namespace === undefined ? {} : { namespace: values.namespace }),
            ...(values.container === undefined ? {} : { container: values.container }),
            ...(values.context === undefined ? {} : { context: values.context }),
            ...(values.kubeconfig === undefined ? {} : { kubeconfig: values.kubeconfig }),
          })
        } else {
          writeError(`bkagent: unsupported transport "${transport}"\n`)
          return 2
        }
        const run = await remote.run(remoteArgv, timeoutMs === undefined ? {} : { timeoutMs })
        write(`${JSON.stringify(run, null, 2)}\n`)
        return run.exitCode === 0 && !run.timedOut ? 0 : 1
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
            resume: { type: 'boolean', default: false },
            'storage-kind': { type: 'string' },
            'storage-root': { type: 'string' },
            'remove-local': { type: 'boolean', default: false },
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
        let artifactSink: ArtifactSink | undefined
        try {
          artifactSink = artifactSinkFromCli(values, env)
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
        const instance = await postgresEngine.probe(executor, connection, probeOptions(transport))

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
          const ctx = buildPlanContext(instance, requestDigest(physical), transport)
          const plan = buildPhysicalBackupPlan(physical, ctx)
          const issues = validateForExecution(plan, principal, undefined, transport.kind === 'local' ? values.out : undefined)
          if (issues.length > 0) {
            write(`${planIssueText(issues)}\n`)
            return 4
          }
          const credentialNote = remoteCredentialNote(transport, connection)
          if (credentialNote !== undefined) writeError(credentialNote)
          const { result } = await executePlan(plan, instance, {
            executor,
            writeError,
            controlDb: resolveDb(values.db),
            principalId: principal,
            stateDir: values['state-dir'],
            resume: values.resume,
            ...(transport.kind === 'local' ? { env: connectionEnv(connection) } : {}),
            artifact: {
              path: values.out,
              kind: 'full',
              verifiedLevel: format === 'plain' ? 'V0' : null,
            },
            ...(artifactSink === undefined ? {} : { artifactSink }),
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
        const ctx = buildPlanContext(instance, requestDigest(request), transport)
        const built = postgresEngine.planLogicalBackup(request, ctx)
        const prepared = await preparePlan({
          plan: built,
          refresh: async () => {
            const live = await postgresEngine.probe(executor, connection, probeOptions(transport))
            const now = new Date().toISOString()
            return {
              ...built.fingerprint,
              systemIdentifier: live.systemIdentifier ?? built.fingerprint.systemIdentifier,
              targetOid: live.databaseOid ?? built.fingerprint.targetOid,
              createdAt: now,
              expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
            }
          },
          validate: (candidate) =>
            validateForExecution(candidate, principal, undefined, transport.kind === 'local' ? values.out : undefined),
          now: () => new Date().toISOString(),
          maxAttempts: 2,
        })
        if (!prepared.ok) {
          write(`${planIssueText(prepared.issues)}\n`)
          return 4
        }
        const plan = prepared.plan
        const credentialNote = remoteCredentialNote(transport, connection)
        if (credentialNote !== undefined) writeError(credentialNote)
        const { result } = await executePlan(plan, instance, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principal,
          stateDir: values['state-dir'],
          resume: values.resume,
          ...(transport.kind === 'local' ? { env: connectionEnv(connection) } : {}),
          artifact: {
            path: values.out,
            kind: 'logical',
            verifiedLevel: format === 'plain' ? null : 'V1',
          },
          ...(artifactSink === undefined ? {} : { artifactSink }),
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
            resume: { type: 'boolean', default: false },
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
        const instance = await postgresEngine.probe(executor, connection, probeOptions(transport))
        const ctx = buildPlanContext(instance, requestDigest(request), transport)
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
            const live = await postgresEngine.probe(executor, connection, probeOptions(transport))
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
          executionInstance = await postgresEngine.probe(executor, connection, probeOptions(transport))
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

        const credentialNote = remoteCredentialNote(transport, connection)
        if (credentialNote !== undefined) writeError(credentialNote)
        const { result } = await executePlan(plan, executionInstance, {
          executor,
          writeError,
          controlDb: resolveDb(values.db),
          principalId: principal,
          stateDir: values['state-dir'],
          resume: values.resume,
          ...(transport.kind === 'local' ? { env: connectionEnv(connection) } : {}),
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
            db: { type: 'string' },
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
        // A passing V2 run is the only automated source of VRP evidence; write it
        // back before reporting so "verified" never means "printed ok".
        if (report.ok) {
          await recordVerifiedArtifact(resolveDb(values.db), values.input, writeError)
        }
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
            resume: { type: 'boolean', default: false },
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
        const instance = await postgresEngine.probe(executor, connection, probeOptions(transport))
        const dataDirectory = values['data-dir']
        // A postmaster.pid means a server is still running on this data directory,
        // typically from an earlier attempt whose target assertion failed. Refuse
        // with the remedy instead of letting pg_ctl fail opaquely.
        if (existsSync(join(dataDirectory, 'postmaster.pid'))) {
          writeError(
            `bkagent: ${dataDirectory} still has postmaster.pid: a server is running on it. ` +
              `Stop it first (pg_ctl -D ${dataDirectory} stop -m fast), then re-run pitr.\n`,
          )
          return 2
        }
        let existingAutoConf = ''
        try {
          existingAutoConf = readFileSync(join(dataDirectory, 'postgresql.auto.conf'), 'utf8')
        } catch {
          existingAutoConf = ''
        }

        // §9 recoverable window: the target must sit inside what the base backup
        // and the archive actually cover. Only an LSN target can be compared
        // locally; a time/name/xid target is decided by the runtime assertion.
        let backupLabel: string | null = null
        try {
          backupLabel = readFileSync(join(dataDirectory, 'backup_label'), 'utf8')
        } catch {
          backupLabel = null
        }
        const windowFacts = {
          lastArchivedWal: instance.lastArchivedWal ?? null,
          backupLabel,
        }
        const window = recoverableWindow(windowFacts)
        if (values['target-lsn'] !== undefined) {
          const windowIssues = preflightPitrTarget({ lsn: values['target-lsn'] }, windowFacts)
          if (windowIssues.length > 0) {
            write(`${JSON.stringify({ ok: false, issues: windowIssues }, null, 2)}\n`)
            return 4
          }
        } else if (window.evaluated && window.from !== null && window.to !== null) {
          writeError(
            `bkagent: recoverable window ${formatLsn(window.from)} .. ${formatLsn(window.to)}; ` +
              'a time/name/xid target cannot be mapped to an LSN locally, so the ' +
              'post-recovery assertion decides.\n',
          )
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

        const ctx = buildPlanContext(instance, requestDigest(request), transport)
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
        const live = await postgresEngine.probe(executor, connection, probeOptions(transport))
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
        const issues = validateForExecution(plan, principal, undefined, transport.kind === 'local' ? values['data-dir'] : undefined)
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
          resume: values.resume,
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
            resume: { type: 'boolean', default: false },
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
          transport,
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
          resume: values.resume,
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
            resume: { type: 'boolean', default: false },
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
        const ctx = await providerContext(dsn, executor, requestDigest(request), transport)
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
        const live = await probeTarget(dsn, executor, transport)
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
          resume: values.resume,
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
            resume: { type: 'boolean', default: false },
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
        const ctx = await providerContext(dsn, executor, requestDigest(request), transport)
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
        const live = await probeTarget(dsn, executor, transport)
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
          resume: values.resume,
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
            resume: { type: 'boolean', default: false },
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
          transport,
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
          resume: values.resume,
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
            resume: { type: 'boolean', default: false },
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
        const ctx = await providerContext(dsn, executor, requestDigest(request), transport)
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
        const live = await probeTarget(dsn, executor, transport)
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
          resume: values.resume,
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
            resume: { type: 'boolean', default: false },
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
        const ctx = await providerContext(dsn, executor, requestDigest(request), transport)
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
        const live = await probeTarget(dsn, executor, transport)
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
          resume: values.resume,
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
        if (values['verified-level'] !== undefined) {
          const level = values['verified-level']
          if (!['V0', 'V1', 'V2', 'V3'].includes(level)) {
            writeError(`bkagent: unsupported verified level "${level}"\n`)
            return 2
          }
          // A level with no content digest is a claim, not evidence: VRP selection
          // trusts this column, so the artifact bytes must be hashed first.
          if (values.checksum === undefined || !/^[0-9a-f]{64}$/i.test(values.checksum)) {
            writeError(
              'bkagent: --verified-level requires a 64-hex --checksum for the artifact contents\n',
            )
            return 2
          }
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

      case 'artifact-upload': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            id: { type: 'string' },
            'storage-kind': { type: 'string' },
            'storage-root': { type: 'string' },
            'remove-local': { type: 'boolean', default: false },
            format: { type: 'string', default: 'json' },
          },
        })
        if (values.id === undefined) {
          writeError('bkagent: artifact-upload requires --id\n')
          return 2
        }
        let sink: ArtifactSink
        try {
          const resolved = artifactSinkFromCli(values, env)
          if (resolved === undefined) {
            throw new Error('artifact-upload requires --storage-kind (fs, nfs or s3)')
          }
          sink = resolved
        } catch (error) {
          writeError(`bkagent: ${(error as Error).message}\n`)
          return 2
        }
        const artifactId = asArtifactId(values.id)
        const outcome = await withRepo(resolveDb(values.db), async (repo) => {
          const artifact = await repo.artifacts.get(artifactId)
          if (artifact === null) return { kind: 'missing' as const }
          if (classifyRetentionProvider(artifact.provider) !== 'managed') {
            return {
              kind: 'provider-owned' as const,
              provider: artifact.provider,
            }
          }
          if (
            artifact.path.startsWith('s3://') ||
            artifact.path.startsWith('ssh:') ||
            artifact.path.startsWith('kubectl:')
          ) {
            return { kind: 'already-stored' as const, path: artifact.path }
          }
          let stored: Awaited<ReturnType<typeof storeArtifact>>
          try {
            stored = await storeArtifact(sink, {
              targetId: artifact.targetId,
              kind: artifact.kind,
              planId: artifact.planId ?? `art-${artifactId}`,
              localPath: artifact.path,
            })
          } catch (error) {
            return { kind: 'failed' as const, message: (error as Error).message }
          }
          const relocated = await repo.artifacts.relocate({
            id: artifactId,
            path: stored.location,
            sizeBytes: stored.bytes,
            checksum: stored.digest,
          })
          if (!relocated) {
            return { kind: 'failed' as const, message: 'artifact row disappeared during upload' }
          }
          const storedAt = new Date().toISOString()
          await repo.outbox.append({
            topic: OUTBOX_TOPIC_RUN_AUDIT,
            payload: {
              event: 'artifact.stored',
              artifactId: String(artifactId),
              from: artifact.path,
              location: stored.location,
              bytes: stored.bytes,
              digest: stored.digest,
              removedLocal: stored.removedLocal,
              storedAt,
            },
            idempotencyKey: `artifact-stored:${artifactId}:${storedAt}`,
            availableAt: storedAt,
          })
          return { kind: 'stored' as const, stored }
        })

        if (outcome.kind === 'missing') {
          writeError(`bkagent: no artifact "${String(artifactId)}" in the catalog\n`)
          return 4
        }
        if (outcome.kind === 'provider-owned') {
          writeError(
            `bkagent: artifact "${String(artifactId)}" belongs to provider "${outcome.provider}"; ` +
              'provider repositories are never moved by the control plane (ADR-003)\n',
          )
          return 2
        }
        if (outcome.kind === 'already-stored') {
          write(`${JSON.stringify({ ok: true, id: String(artifactId), location: outcome.path, note: 'already stored' }, null, 2)}\n`)
          return 0
        }
        if (outcome.kind === 'failed') {
          writeError(`bkagent: upload failed: ${outcome.message}\n`)
          return 1
        }
        write(
          `${JSON.stringify(
            {
              ok: true,
              id: String(artifactId),
              location: outcome.stored.location,
              bytes: outcome.stored.bytes,
              digest: outcome.stored.digest,
              removedLocal: outcome.stored.removedLocal,
            },
            null,
            2,
          )}\n`,
        )
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

      case 'storage-purge': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            'storage-kind': { type: 'string', default: 'fs' },
            'storage-root': { type: 'string' },
            'grace-days': { type: 'string', default: '7' },
            target: { type: 'string' },
            apply: { type: 'boolean', default: false },
            yes: { type: 'boolean', default: false },
            digest: { type: 'string' },
            format: { type: 'string', default: 'json' },
          },
        })
        const graceDays = parseNonNegativeInt(values['grace-days'], '--grace-days') as number
        let wiring: StorageWiring
        try {
          wiring = storageFromCli(values, env)
        } catch (error) {
          writeError(`bkagent: ${(error as Error).message}\n`)
          return 2
        }
        const targetId = values.target === undefined ? undefined : asTargetId(values.target)
        const now = new Date()
        const artifacts = await withRepo(resolveDb(values.db), (repo) =>
          repo.artifacts.list({ lifecycle: 'any', ...(targetId === undefined ? {} : { targetId }) }),
        )
        const plan = planPurge({
          artifacts,
          now: now.toISOString(),
          graceDays,
          keyOf: wiring.keyOf,
        })
        const digest = planDigest({
          phase: 'purge',
          candidates: plan.candidates.map((candidate) => [String(candidate.id), candidate.key]),
        })
        if (!values.apply) {
          const skippedByReason: Record<string, number> = {}
          for (const skip of plan.skipped) {
            skippedByReason[skip.reason] = (skippedByReason[skip.reason] ?? 0) + 1
          }
          write(
            `${JSON.stringify(
              {
                ok: true,
                phase: 'dry-run',
                digest,
                candidates: plan.candidates.map((candidate) => ({
                  id: String(candidate.id),
                  key: candidate.key,
                  provider: candidate.provider,
                })),
                skipped: skippedByReason,
              },
              null,
              2,
            )}\n`,
          )
          return 0
        }
        // Byte reclamation is irreversible: require --yes and the reviewed digest.
        if (!values.yes || values.digest === undefined) {
          writeError(
            `bkagent: storage-purge --apply requires --yes and --digest ${digest}\n`,
          )
          return 2
        }
        if (values.digest !== digest) {
          writeError(
            `bkagent: digest mismatch; the reviewed plan was ${digest}, re-run the dry run\n`,
          )
          return 2
        }
        const report = await applyPurge(wiring.storage, plan)
        const byId = new Map(plan.candidates.map((candidate) => [String(candidate.id), candidate]))
        if (report.purged.length > 0) {
          await withRepo(resolveDb(values.db), async (repo) => {
            for (const id of report.purged) {
              const candidate = byId.get(String(id))
              await repo.outbox.append({
                topic: OUTBOX_TOPIC_RUN_AUDIT,
                payload: {
                  event: 'artifact.purged',
                  artifactId: String(id),
                  key: candidate?.key ?? null,
                  path: candidate?.path ?? null,
                  provider: candidate?.provider ?? null,
                  purgedAt: now.toISOString(),
                },
                idempotencyKey: `artifact-purged:${String(id)}:${now.toISOString()}`,
                availableAt: now.toISOString(),
              })
            }
          })
        }
        write(`${JSON.stringify(report, null, 2)}\n`)
        return report.failed.length === 0 ? 0 : 1
      }

      case 'storage-gc': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            'storage-kind': { type: 'string', default: 'fs' },
            'storage-root': { type: 'string' },
            'grace-days': { type: 'string', default: '7' },
            apply: { type: 'boolean', default: false },
            yes: { type: 'boolean', default: false },
            digest: { type: 'string' },
            format: { type: 'string', default: 'json' },
          },
        })
        const graceDays = parseNonNegativeInt(values['grace-days'], '--grace-days') as number
        let wiring: StorageWiring
        try {
          wiring = storageFromCli(values, env)
        } catch (error) {
          writeError(`bkagent: ${(error as Error).message}\n`)
          return 2
        }
        const now = new Date()
        const objects = await wiring.storage.list()
        const artifacts = await withRepo(resolveDb(values.db), (repo) =>
          repo.artifacts.list({ lifecycle: 'any' }),
        )
        const plan = planOrphanGc({
          objects,
          artifacts,
          now: now.toISOString(),
          graceDays,
          keyOf: wiring.keyOf,
        })
        const digest = planDigest({
          phase: 'gc',
          delete: plan.delete.map((candidate) => candidate.key),
        })
        if (!values.apply) {
          write(
            `${JSON.stringify({ ok: true, phase: 'dry-run', digest, ...plan }, null, 2)}\n`,
          )
          return 0
        }
        if (!values.yes || values.digest === undefined) {
          writeError(`bkagent: storage-gc --apply requires --yes and --digest ${digest}\n`)
          return 2
        }
        if (values.digest !== digest) {
          writeError(
            `bkagent: digest mismatch; the reviewed plan was ${digest}, re-run the dry run\n`,
          )
          return 2
        }
        const report = await applyOrphanGc(wiring.storage, plan)
        if (report.deleted.length > 0) {
          await withRepo(resolveDb(values.db), async (repo) => {
            for (const key of report.deleted) {
              await repo.outbox.append({
                topic: OUTBOX_TOPIC_RUN_AUDIT,
                payload: {
                  event: 'artifact.gc.purged',
                  key,
                  purgedAt: now.toISOString(),
                },
                idempotencyKey: `artifact-gc:${key}:${now.toISOString()}`,
                availableAt: now.toISOString(),
              })
            }
          })
        }
        write(`${JSON.stringify(report, null, 2)}\n`)
        return report.failed.length === 0 ? 0 : 1
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
          const outbox = await repo.outbox.stats(now.toISOString())
          const ticketsByState = await repo.tickets.countByState()
          const attemptsByState = await repo.attempts.countByState()
          const assets = await repo.assets.list()
          const rpo = evaluateAssetRpo(assets, artifacts, now)

          const attemptDurations = attempts
            .filter(
              (attempt) =>
                attempt.startedAt !== null &&
                attempt.startedAt !== undefined &&
                attempt.finishedAt !== null &&
                attempt.finishedAt !== undefined,
            )
            .flatMap((attempt) => {
              const started = Date.parse(attempt.startedAt as string)
              const finished = Date.parse(attempt.finishedAt as string)
              if (!Number.isFinite(started) || !Number.isFinite(finished)) return []
              return [{ state: attempt.state, seconds: Math.max(0, (finished - started) / 1000) }]
            })

          const bytesByProvider = new Map<string, number>()
          const levels = new Map<string, number>()
          for (const artifact of artifacts) {
            bytesByProvider.set(
              artifact.provider,
              (bytesByProvider.get(artifact.provider) ?? 0) + artifact.sizeBytes,
            )
            if (artifact.verifiedLevel !== null) {
              levels.set(artifact.verifiedLevel, (levels.get(artifact.verifiedLevel) ?? 0) + 1)
            }
          }

          return renderMetrics({
            artifacts,
            attempts: attempts.map((attempt) => ({
              state: attempt.state,
              errorClass: attempt.errorClass ?? null,
            })),
            outboxPending: outbox.pending + outbox.processing,
            ticketsByState,
            attemptsByState,
            attemptDurations,
            backupBytesByProvider: [...bytesByProvider].map(([provider, bytes]) => ({
              provider,
              bytes,
            })),
            verifyLevels: [...levels].map(([level, count]) => ({ level, count })),
            outboxOldestPendingAt: outbox.oldestPendingAt,
            rpo: {
              assets: rpo.length,
              withinRpo: rpo.filter((status) => status.withinRpo).length,
            },
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
        const thresholdGb = Number(values['threshold-gb'])
        if (!Number.isFinite(thresholdGb) || thresholdGb <= 0) {
          writeError(`bkagent: --threshold-gb must be a positive number\n`)
          return 2
        }
        const thresholdBytes = thresholdGb * 1024 ** 3
        const since = new Date(
          Date.now() - parseNonNegativeInt(values.days, '--days') * 86_400_000,
        ).toISOString()
        const forecast = await withRepo(resolveDb(values.db), async (repo) => {
          // The window filters which points are plotted, not which bytes exist:
          // bytes written before the window are the baseline the projection
          // starts from, otherwise a long-lived repository looks flat.
          const artifacts = await repo.artifacts.list({})
          const sorted = [...artifacts].sort(
            (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
          )
          let running = 0
          const points: { at: number; bytes: number }[] = []
          for (const artifact of sorted) {
            running += artifact.sizeBytes
            if (artifact.createdAt >= since) {
              points.push({ at: Date.parse(artifact.createdAt), bytes: running })
            }
          }
          return forecastCapacity(points, thresholdBytes, Date.now())
        })
        write(`${JSON.stringify(forecast, null, 2)}\n`)
        return 0
      }

      case 'watchdog': {
        const { values } = parseArgs({
          args: [...rest],
          allowPositionals: false,
          options: {
            db: { type: 'string' },
            'threshold-gb': { type: 'string', default: '100' },
          },
        })
        const thresholdGb = Number(values['threshold-gb'])
        if (!Number.isFinite(thresholdGb) || thresholdGb <= 0) {
          writeError(`bkagent: --threshold-gb must be a positive number\n`)
          return 2
        }
        const now = new Date()
        const { report, alerts } = await withRepo(resolveDb(values.db), async (repo) => {
          const reconciled = await reconcile(repo, now.toISOString())
          const assets = await repo.assets.list()
          const artifacts = await repo.artifacts.list({})
          // The failure-streak rule only needs recent terminal attempts; a month
          // is long enough to see a streak and short enough to stay cheap.
          const since = new Date(now.getTime() - 30 * 86_400_000).toISOString()
          const attempts = await repo.attempts.listSince(since)
          const rpo = evaluateAssetRpo(assets, artifacts, now)
          const points: { at: number; bytes: number }[] = []
          let running = 0
          for (const artifact of [...artifacts].sort(
            (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
          )) {
            running += artifact.sizeBytes
            points.push({ at: Date.parse(artifact.createdAt), bytes: running })
          }
          const forecast = forecastCapacity(points, thresholdGb * 1024 ** 3, now.getTime())
          return {
            report: reconciled,
            alerts: evaluateAlerts({
              now,
              assets: rpo,
              attempts: attempts.map((attempt) => ({
                targetId: attempt.targetId ?? null,
                state: attempt.state,
                finishedAt: attempt.finishedAt ?? null,
              })),
              capacity: { daysUntilThreshold: forecast.daysUntilThreshold },
            }),
          }
        })
        // Alerts are emitted with the run: a P1/P2 that only lives in the JSON
        // output would need someone to read it. Delivery is best effort and never
        // fails the watchdog (the schedule would mask the backlog report).
        const delivery: { sent: number; failed: string[] } = { sent: 0, failed: [] }
        let notifier: Notifier | null
        try {
          notifier = notifierFor(env)
        } catch (error) {
          writeError(`bkagent: ${(error as Error).message}\n`)
          return 2
        }
        if (notifier !== null) {
          for (const alert of alerts) {
            try {
              await notifier.send(alert)
              delivery.sent += 1
            } catch (error) {
              delivery.failed.push(`${alert.severity} ${alert.title}: ${(error as Error).message}`)
            }
          }
        }
        write(`${JSON.stringify({ ...report, alerts, delivery }, null, 2)}\n`)
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
        let notifier: Notifier | null
        try {
          notifier = notifierFor(env)
        } catch (error) {
          writeError(`bkagent: ${(error as Error).message}\n`)
          return 2
        }
        const handlers = createOutboxHandlers({
          webhookUrl: env.BKAGENT_WEBHOOK_URL,
          ...(notifier === null ? {} : { notifier }),
        })
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
            smtp: { type: 'boolean', default: false },
            severity: { type: 'string', default: 'P4' },
            title: { type: 'string', default: 'bkagent test alert' },
          },
        })
        if (values.url === undefined && !values.smtp) {
          writeError('bkagent: notify-test requires --url or --smtp\n')
          return 2
        }
        const severity = values.severity as 'P1' | 'P2' | 'P3' | 'P4'
        if (!['P1', 'P2', 'P3', 'P4'].includes(severity)) {
          writeError(`bkagent: unsupported severity "${severity}"\n`)
          return 2
        }
        let notifier: Notifier
        if (values.smtp) {
          try {
            const configured = notifierFor(env)
            if (configured === null) {
              writeError('bkagent: --smtp requires BKAGENT_SMTP_HOST/FROM/TO\n')
              return 2
            }
            notifier = configured
          } catch (error) {
            writeError(`bkagent: ${(error as Error).message}\n`)
            return 2
          }
        } else {
          notifier = new WebhookNotifier(values.url as string)
        }
        await notifier.send({
          severity,
          title: values.title,
          message: 'test event from bkagent',
        })
        write(`${JSON.stringify({ ok: true, severity, channel: values.smtp ? 'smtp' : 'webhook' })}\n`)
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
        // Rebuilt per request when serving: a long-running panel that froze its
        // first render would silently show hours-old state.
        const render = async (): Promise<string> => {
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
          return renderDashboard({ generatedAt, ...payload })
        }

        if (values.out !== undefined) {
          writeFileSync(values.out, await render(), 'utf8')
          write(`${values.out}\n`)
          return 0
        }

        const port = Number(values.port)
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          writeError(`bkagent: --port must be an integer between 1 and 65535\n`)
          return 2
        }
        createServer((_request, response) => {
          render().then(
            (html) => {
              response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
              response.end(html)
            },
            (error: unknown) => {
              response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
              response.end(`dashboard render failed: ${(error as Error).message}\n`)
            },
          )
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
            yes: { type: 'boolean', default: false },
            principal: { type: 'string' },
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
        const requester = principalFor(values.principal, env)
        const osPrincipal = principalFor(undefined, env)
        const now = new Date().toISOString()
        // Registration is cheap and ungated; *weakening* an existing asset is not.
        // Environment decides the four-eyes threshold and `protected` decides
        // retention immunity, so a downgrade is as sensitive as a destructive run
        // and has to be approved like one.
        const gated = await withRepo(resolveDb(values.db), async (repo) => {
          const existing = await repo.assets.get(asset.targetId)
          if (existing === null || !weakensProtection(existing, asset)) {
            await repo.assets.upsert(asset)
            return { kind: 'stored' as const }
          }

          const digest = assetProtectionDigest(asset)
          const approveHint =
            `  bkagent approve --db ${resolveDb(values.db)} --target ${asset.targetId} ` +
            `--digest ${digest} --approver <id>\n` +
            `  bkagent approvals --db ${resolveDb(values.db)} --target ${asset.targetId} ` +
            `--digest ${digest}`
          if (!values.yes) {
            return {
              kind: 'refused' as const,
              message:
                `weakening the protection of "${asset.targetId}" ` +
                `(environment ${existing.environment} -> ${asset.environment}, ` +
                `protected ${existing.protected} -> ${asset.protected}, ` +
                `criticality ${existing.criticality} -> ${asset.criticality}) ` +
                `requires --yes and two current approvals.\n` +
                `digest: ${digest}\n${approveHint}`,
            }
          }
          const since = new Date(Date.now() - APPROVAL_TTL_MS).toISOString()
          const approvals = await repo.approvals.listFor(asset.targetId, digest, since)
          const status = fourEyesStatus(
            'production-destructive',
            approvals,
            new Date(),
            APPROVAL_TTL_MS,
            [requester, osPrincipal],
          )
          if (!status.ok) {
            const selfNote =
              status.selfApproved === undefined
                ? ''
                : `\nignored self-approval from requester: ${status.selfApproved.join(', ')}`
            return {
              kind: 'refused' as const,
              message:
                `weakening "${asset.targetId}" requires ${status.required} distinct approvals; ` +
                `have ${status.distinct}.${selfNote}\ndigest: ${digest}\n${approveHint}`,
            }
          }
          await repo.assets.upsert(asset)
          await repo.outbox.append({
            topic: OUTBOX_TOPIC_RUN_AUDIT,
            payload: {
              event: 'asset.protection.weakened',
              targetId: asset.targetId,
              previous: {
                environment: existing.environment,
                criticality: existing.criticality,
                protected: existing.protected,
              },
              next: {
                environment: asset.environment,
                criticality: asset.criticality,
                protected: asset.protected,
              },
              digest,
              approvers: approvals
                .filter((approval) => approval.decision === 'approve')
                .map((approval) => approval.approver),
              requester,
              osPrincipal,
              detectedAt: now,
            },
            idempotencyKey: `asset-weakened:${asset.targetId}:${digest}:${now}`,
            availableAt: now,
          })
          return { kind: 'stored' as const }
        })
        if (gated.kind === 'refused') {
          writeError(`bkagent: ${gated.message}\n`)
          return 2
        }
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
          // Environment-derived identity: four-eyes counts this, not the free-text
          // label, so one operator cannot record two "approvers" on one machine.
          approverOs: principalFor(undefined, env),
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

      case 'goal':
      case 'memory': {
        return await runGoalCommand(command, rest, {
          write,
          writeError,
          env,
          dispatch: (argv, stdout, stderr) =>
            runCli(argv, {
              stdout,
              stderr,
              env,
              ...(deps.executor === undefined ? {} : { executor: deps.executor }),
            }),
        })
      }

      default:
        writeError(`bkagent: unknown command "${command}"\n`)
        return 2
    }
  } catch (error) {
    return handleError(error, writeError)
  }
}
