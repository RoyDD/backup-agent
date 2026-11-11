import { readFileSync } from 'node:fs'

export interface PrincipalCredential {
  id: string
  kind: 'human' | 'service'
  /** Name of the environment variable holding the DSN; never the DSN itself. */
  dsnEnv: string
}

export interface PrincipalRegistry {
  version: 1
  principals: readonly PrincipalCredential[]
}

export class PrincipalError extends Error {
  readonly code: 'INVALID_REGISTRY' | 'UNKNOWN_PRINCIPAL' | 'MISSING_SECRET'

  constructor(code: PrincipalError['code'], message: string) {
    super(message)
    this.name = 'PrincipalError'
    this.code = code
  }
}

export function parsePrincipalRegistry(value: unknown): PrincipalRegistry {
  if (value === null || typeof value !== 'object') {
    throw new PrincipalError('INVALID_REGISTRY', 'registry must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.principals)) {
    throw new PrincipalError('INVALID_REGISTRY', 'registry must declare version 1 and principals[]')
  }
  const seen = new Set<string>()
  const principals: PrincipalCredential[] = []
  for (const entry of record.principals) {
    if (entry === null || typeof entry !== 'object') {
      throw new PrincipalError('INVALID_REGISTRY', 'principal entry must be an object')
    }
    const item = entry as Record<string, unknown>
    if (typeof item.id !== 'string' || item.id.trim() === '') {
      throw new PrincipalError('INVALID_REGISTRY', 'principal.id must be a non-empty string')
    }
    if (item.kind !== 'human' && item.kind !== 'service') {
      throw new PrincipalError('INVALID_REGISTRY', `principal ${item.id}: kind must be human|service`)
    }
    if (typeof item.dsnEnv !== 'string' || item.dsnEnv.trim() === '') {
      throw new PrincipalError('INVALID_REGISTRY', `principal ${item.id}: dsnEnv must be set`)
    }
    if (seen.has(item.id)) {
      throw new PrincipalError('INVALID_REGISTRY', `duplicate principal ${item.id}`)
    }
    seen.add(item.id)
    principals.push({ id: item.id, kind: item.kind, dsnEnv: item.dsnEnv })
  }
  return { version: 1, principals }
}

export function loadPrincipalRegistry(path: string): PrincipalRegistry {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new PrincipalError('INVALID_REGISTRY', `cannot read registry: ${path}`)
  }
  try {
    return parsePrincipalRegistry(JSON.parse(raw) as unknown)
  } catch (error) {
    if (error instanceof PrincipalError) throw error
    throw new PrincipalError('INVALID_REGISTRY', 'registry is not valid JSON')
  }
}

/**
 * Resolves the DSN for a principal. The registry stores only an environment
 * variable name; the secret itself is read from the process environment so it
 * never enters a plan, log or audit record.
 */
export function resolvePrincipalDsn(
  registry: PrincipalRegistry,
  principalId: string,
  env: NodeJS.ProcessEnv,
): string {
  const credential = registry.principals.find((entry) => entry.id === principalId)
  if (credential === undefined) {
    throw new PrincipalError('UNKNOWN_PRINCIPAL', `principal ${principalId} is not registered`)
  }
  const dsn = env[credential.dsnEnv]
  if (dsn === undefined || dsn.trim() === '') {
    throw new PrincipalError(
      'MISSING_SECRET',
      `environment variable ${credential.dsnEnv} is empty for principal ${principalId}`,
    )
  }
  return dsn
}
