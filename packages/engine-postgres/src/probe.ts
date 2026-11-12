import type { ConnectionParams, Executor, InstanceInfo, ProbeOptions } from '@backup-agent/core'
import { connectionEnv, redactConnection } from '@backup-agent/core'

export type ProbeErrorCode = 'CONNECT_FAILED' | 'PROBE_FAILED'

export class ProbeError extends Error {
  readonly code: ProbeErrorCode

  constructor(code: ProbeErrorCode, message: string) {
    super(message)
    this.name = 'ProbeError'
    this.code = code
  }
}

const PSQL_BASE_ARGS = ['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1']

/**
 * Connection flags for a probe that cannot use the child environment.
 *
 * Remote transports never forward env, so the connection parameters travel as
 * argv instead. The password is deliberately absent: the target host supplies
 * its own credential source. `-c` must stay last, so these go before it.
 */
function connectionArgs(connection: ConnectionParams): string[] {
  return [
    `--host=${connection.host}`,
    `--port=${connection.port}`,
    `--username=${connection.user}`,
    `--dbname=${connection.database}`,
  ]
}

const BASIC_SQL = `select json_build_object(
  'version', version(),
  'serverVersionNum', (current_setting('server_version_num'))::int,
  'currentUser', current_user,
  'currentDatabase', current_database(),
  'databaseOid', (select oid::text from pg_database where datname = current_database()),
  'inRecovery', pg_is_in_recovery(),
  'walLevel', current_setting('wal_level'),
  'archiveMode', current_setting('archive_mode'),
  'archiveConfigured', current_setting('archive_command') <> '',
  'isSuperuser', (select rolsuper from pg_roles where rolname = current_user),
  'canReplicate', (select rolreplication from pg_roles where rolname = current_user),
  'currentLsn', case when pg_is_in_recovery() then null else pg_current_wal_lsn()::text end,
  'lastArchivedWal', (select last_archived_wal from pg_stat_archiver),
  'archiverFailedCount', (select failed_count from pg_stat_archiver),
  -- pg_database_size raises for databases the role cannot connect to; CASE is
  -- evaluated lazily, so the privilege check guards the call.
  'dataBytes', (select coalesce(sum(case when has_database_privilege(oid, 'CONNECT') then pg_database_size(oid) else 0 end), 0)::bigint from pg_database where not datistemplate),
  'databases', (select coalesce(json_agg(datname order by datname), '[]'::json)
                  from pg_database where not datistemplate)
)::text`

const CONTROL_SQL = 'select system_identifier::text from pg_control_system()'

const TIMELINE_SQL = 'select (pg_control_checkpoint()).timeline_id'

interface BasicProbe {
  version: string
  serverVersionNum: number
  currentUser: string
  currentDatabase: string
  databaseOid: string | null
  inRecovery: boolean
  walLevel: string
  archiveMode: string
  archiveConfigured: boolean
  isSuperuser: boolean
  canReplicate: boolean
  currentLsn: string | null
  lastArchivedWal: string | null
  archiverFailedCount: number | null
  dataBytes: number | null
  databases: string[]
}

function firstLine(value: string): string {
  return value.trim().split('\n')[0] ?? ''
}

function parseBasic(raw: string): BasicProbe {
  const parsed = JSON.parse(raw) as Partial<BasicProbe>
  if (
    typeof parsed.version !== 'string' ||
    typeof parsed.serverVersionNum !== 'number' ||
    typeof parsed.currentUser !== 'string' ||
    typeof parsed.currentDatabase !== 'string' ||
    typeof parsed.inRecovery !== 'boolean'
  ) {
    throw new ProbeError('PROBE_FAILED', 'instance probe returned an unexpected shape')
  }
  return {
    version: parsed.version,
    serverVersionNum: parsed.serverVersionNum,
    currentUser: parsed.currentUser,
    currentDatabase: parsed.currentDatabase,
    databaseOid: typeof parsed.databaseOid === 'string' ? parsed.databaseOid : null,
    inRecovery: parsed.inRecovery,
    walLevel: typeof parsed.walLevel === 'string' ? parsed.walLevel : 'unknown',
    archiveMode: typeof parsed.archiveMode === 'string' ? parsed.archiveMode : 'unknown',
    archiveConfigured: parsed.archiveConfigured === true,
    isSuperuser: parsed.isSuperuser === true,
    canReplicate: parsed.canReplicate === true,
    currentLsn: typeof parsed.currentLsn === 'string' ? parsed.currentLsn : null,
    lastArchivedWal: typeof parsed.lastArchivedWal === 'string' ? parsed.lastArchivedWal : null,
    archiverFailedCount:
      typeof parsed.archiverFailedCount === 'number' ? parsed.archiverFailedCount : null,
    dataBytes: typeof parsed.dataBytes === 'number' ? Number(parsed.dataBytes) : null,
    databases: Array.isArray(parsed.databases)
      ? parsed.databases.filter((name): name is string => typeof name === 'string')
      : [],
  }
}

/**
 * Reads instance facts through `psql`. Credentials travel only in the child
 * environment; `pg_control_system()` and `pg_control_checkpoint()` are optional
 * because they may require elevated privileges. Neither optional query can
 * change the outcome of the basic probe.
 */
export async function probePostgres(
  executor: Executor,
  connection: ConnectionParams,
  options: ProbeOptions = {},
): Promise<InstanceInfo> {
  // A remote transport cannot carry the child environment, so `target` means the
  // machine running psql supplies its own credentials and we send none.
  const targetCredentials = options.credentials === 'target'
  const env = targetCredentials ? undefined : connectionEnv(connection)
  const runOptions = env === undefined ? {} : { env }
  const psqlArgs = [
    ...PSQL_BASE_ARGS,
    ...(targetCredentials ? connectionArgs(connection) : []),
    '-c',
  ]
  const warnings: string[] = []

  const basic = await executor.run([...psqlArgs, BASIC_SQL], runOptions)
  if (basic.exitCode !== 0) {
    const message = redactConnection(firstLine(basic.stderr) || 'psql failed', connection)
    const connectionFailure =
      /could not connect|connection refused|no pg_hba|authentications? failed/i.test(basic.stderr)
    throw new ProbeError(connectionFailure ? 'CONNECT_FAILED' : 'PROBE_FAILED', message)
  }

  let probe: BasicProbe
  try {
    probe = parseBasic(basic.stdout.trim())
  } catch (error) {
    if (error instanceof ProbeError) throw error
    throw new ProbeError('PROBE_FAILED', 'instance probe returned invalid JSON')
  }

  let systemIdentifier: string | null = null
  const control = await executor.run([...psqlArgs, CONTROL_SQL], runOptions)
  if (control.exitCode === 0 && control.stdout.trim() !== '') {
    systemIdentifier = control.stdout.trim()
  } else {
    warnings.push(
      `pg_control_system unavailable: ${redactConnection(firstLine(control.stderr) || 'no output', connection)}`,
    )
  }

  // Best effort, on its own query: the timeline is only informational today, so
  // any failure — non-zero exit or an executor that cannot run the query at all
  // — degrades to a warning.
  let timelineId: number | null = null
  try {
    const timeline = await executor.run([...psqlArgs, TIMELINE_SQL], runOptions)
    if (timeline.exitCode === 0 && timeline.stdout.trim() !== '') {
      const parsed = Number.parseInt(timeline.stdout.trim(), 10)
      if (Number.isInteger(parsed) && parsed > 0) {
        timelineId = parsed
      } else {
        warnings.push('pg_control_checkpoint unavailable: timeline_id is not a positive integer')
      }
    } else {
      warnings.push(
        `pg_control_checkpoint unavailable: ${redactConnection(firstLine(timeline.stderr) || 'no output', connection)}`,
      )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warnings.push(
      `pg_control_checkpoint unavailable: ${redactConnection(firstLine(message) || 'no output', connection)}`,
    )
  }

  return {
    ...probe,
    systemIdentifier,
    timelineId,
    executionSite: basic.executionSite,
    warnings,
  }
}
