import type { ConnectionParams, Executor, InstanceInfo } from '@backup-agent/core'
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

const PSQL_ARGS = ['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c']

const BASIC_SQL = `select json_build_object(
  'version', version(),
  'serverVersionNum', (current_setting('server_version_num'))::int,
  'currentUser', current_user,
  'currentDatabase', current_database(),
  'databaseOid', (select oid::text from pg_database where datname = current_database()),
  'inRecovery', pg_is_in_recovery(),
  'walLevel', current_setting('wal_level'),
  'archiveMode', current_setting('archive_mode'),
  'databases', (select coalesce(json_agg(datname order by datname), '[]'::json)
                  from pg_database where not datistemplate)
)::text`

const CONTROL_SQL = 'select system_identifier::text from pg_control_system()'

interface BasicProbe {
  version: string
  serverVersionNum: number
  currentUser: string
  currentDatabase: string
  databaseOid: string | null
  inRecovery: boolean
  walLevel: string
  archiveMode: string
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
    databases: Array.isArray(parsed.databases)
      ? parsed.databases.filter((name): name is string => typeof name === 'string')
      : [],
  }
}

/**
 * Reads instance facts through `psql`. Credentials travel only in the child
 * environment; `pg_control_system()` is optional because it may require
 * elevated privileges.
 */
export async function probePostgres(
  executor: Executor,
  connection: ConnectionParams,
): Promise<InstanceInfo> {
  const env = connectionEnv(connection)
  const warnings: string[] = []

  const basic = await executor.run([...PSQL_ARGS, BASIC_SQL], { env })
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
  const control = await executor.run([...PSQL_ARGS, CONTROL_SQL], { env })
  if (control.exitCode === 0 && control.stdout.trim() !== '') {
    systemIdentifier = control.stdout.trim()
  } else {
    warnings.push(
      `pg_control_system unavailable: ${redactConnection(firstLine(control.stderr) || 'no output', connection)}`,
    )
  }

  return {
    ...probe,
    systemIdentifier,
    executionSite: basic.executionSite,
    warnings,
  }
}
