export type ConnectionErrorCode = 'INVALID_DSN'

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode

  constructor(code: ConnectionErrorCode, message: string) {
    super(message)
    this.name = 'ConnectionError'
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
    throw new ConnectionError('INVALID_DSN', 'dsn is not a valid URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ConnectionError('INVALID_DSN', `unsupported scheme "${url.protocol}"`)
  }
  if (url.hostname === '') {
    throw new ConnectionError('INVALID_DSN', 'dsn must include a host')
  }

  const user = decodeURIComponent(url.username)
  if (user === '') throw new ConnectionError('INVALID_DSN', 'dsn must include a user')

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

/** Environment for libpq clients. Credentials never enter argv. */
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

export function withDatabase(connection: ConnectionParams, database: string): ConnectionParams {
  return { ...connection, database }
}

export function redactConnection(message: string, connection: ConnectionParams): string {
  if (connection.password === undefined || connection.password === '') return message
  return message.split(connection.password).join('***')
}
