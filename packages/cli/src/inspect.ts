import type { Executor } from '@backup-agent/core'

export type InspectErrorCode = 'INVALID_DSN' | 'CONNECT_FAILED' | 'PROBE_FAILED'

export class InspectError extends Error {
  readonly code: InspectErrorCode

  constructor(code: InspectErrorCode, message: string) {
    super(message)
    this.name = 'InspectError'
    this.code = code
  }
}

export interface ConnectionParams {
  host: string
  port: string
  user: string
  password?: string
  database: string
  sslmode?: string
}

/** Parses a postgres:// URI without ever echoing the password. */
export function parseDsn(dsn: string): ConnectionParams {
  let url: URL
  try {
    url = new URL(dsn)
  } catch {
    throw new InspectError('INVALID_DSN', 'dsn is not a valid URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new InspectError('INVALID_DSN', `unsupported scheme "${url.protocol}"`)
  }
  if (url.hostname === '') {
    throw new InspectError('INVALID_DSN', 'dsn must include a host')
  }

  const user = decodeURIComponent(url.username)
  if (user === '') throw new InspectError('INVALID_DSN', 'dsn must include a user')

  const password = url.password === '' ? undefined : decodeURIComponent(url.password)
  const database = url.pathname.replace(/^\//, '') || 'postgres'
  const sslmode = url.searchParams.get('sslmode') ?? undefined

  return {
    host: url.hostname,
    port: url.port === '' ? '5432' : url.port,
    user,
    ...(password === undefined ? {} : { password }),
    database,
    ...(sslmode === undefined ? {} : { sslmode }),
  }
}

export function connectionEnv(connection: ConnectionParams): Record<string, string> {
  const env: Record<string, string> = {
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGUSER: connection.user,
    PGDATABASE: connection.database,
    PGCONNECT_TIMEOUT: '10',
  }
  if (connection.password !== undefined) env.PGPASSWORD = connection.password
  if (connection.sslmode !== undefined) env.PGSSLMODE = connection.sslmode
  return env
}

export interface InstanceInfo {
  version: string
  serverVersionNum: number
  currentUser: string
  currentDatabase: string
  inRecovery: boolean
  systemIdentifier: string | null
  walLevel: string
  archiveMode: string
  databases: string[]
  executionSite: string
  warnings: string[]
}

const BASIC_SQL = `select json_build_object(
  'version', version(),
  'serverVersionNum', (current_setting('server_version_num'))::int,
  'currentUser', current_user,
  'currentDatabase', current_database(),
  'inRecovery', pg_is_in_recovery(),
  'walLevel', current_setting('wal_level'),
  'archiveMode', current_setting('archive_mode'),
  'databases', (select coalesce(json_agg(datname order by datname), '[]'::json)
                  from pg_database where not datistemplate)
)::text`

const CONTROL_SQL = 'select system_identifier::text from pg_control_system()'

const PSQL_ARGS = ['psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c']

function firstLine(value: string): string {
  return value.trim().split('\n')[0] ?? ''
}

function redact(message: string, connection: ConnectionParams): string {
  let redacted = message
  if (connection.password !== undefined && connection.password !== '') {
    redacted = redacted.split(connection.password).join('***')
  }
  return redacted
}

interface BasicProbe {
  version: string
  serverVersionNum: number
  currentUser: string
  currentDatabase: string
  inRecovery: boolean
  walLevel: string
  archiveMode: string
  databases: string[]
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
    throw new InspectError('PROBE_FAILED', 'instance probe returned an unexpected shape')
  }
  return {
    version: parsed.version,
    serverVersionNum: parsed.serverVersionNum,
    currentUser: parsed.currentUser,
    currentDatabase: parsed.currentDatabase,
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
 * environment, never in argv or output; `pg_control_system()` is optional
 * because it may require elevated privileges.
 */
export async function inspectInstance(
  executor: Executor,
  connection: ConnectionParams,
): Promise<InstanceInfo> {
  const env = connectionEnv(connection)
  const warnings: string[] = []

  const basic = await executor.run([...PSQL_ARGS, BASIC_SQL], { env })
  if (basic.exitCode !== 0) {
    const message = redact(firstLine(basic.stderr) || 'psql failed', connection)
    const connectionFailure = /could not connect|connection refused|no pg_hba|authentications? failed/i.test(
      basic.stderr,
    )
    throw new InspectError(connectionFailure ? 'CONNECT_FAILED' : 'PROBE_FAILED', message)
  }

  let probe: BasicProbe
  try {
    probe = parseBasic(basic.stdout.trim())
  } catch (error) {
    if (error instanceof InspectError) throw error
    throw new InspectError('PROBE_FAILED', 'instance probe returned invalid JSON')
  }

  let systemIdentifier: string | null = null
  const control = await executor.run([...PSQL_ARGS, CONTROL_SQL], { env })
  if (control.exitCode === 0 && control.stdout.trim() !== '') {
    systemIdentifier = control.stdout.trim()
  } else {
    warnings.push(
      `pg_control_system unavailable: ${redact(firstLine(control.stderr) || 'no output', connection)}`,
    )
  }

  return {
    ...probe,
    systemIdentifier,
    executionSite: basic.executionSite,
    warnings,
  }
}
