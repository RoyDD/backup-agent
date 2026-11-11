import {
  connectionEnv,
  redactConnection,
  withDatabase,
  type ConnectionParams,
  type Executor,
  type LogicalFormat,
} from '@backup-agent/core'

import { buildCreateDatabaseArgv, buildRestoreArgv } from './logical'

const PSQL_ARGS = ['psql', '-X', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-c']

const COUNT_SQL = `select n.nspname || '.' || c.relname as rel,
  (xpath('/row/c/text()',
     query_to_xml('select count(*) as c from ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname),
                  false, true, '')))[1]::text::bigint as cnt
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p')
  and n.nspname not in ('pg_catalog', 'information_schema')
order by 1`

export interface TableCount {
  relation: string
  source: number | null
  target: number | null
  match: boolean
}

export interface VerificationReport {
  ok: boolean
  scratchDatabase: string
  restoreExitCode: number
  tables: TableCount[]
  warnings: string[]
}

export interface VerifyLogicalOptions {
  connection: ConnectionParams
  inputPath: string
  format: LogicalFormat
  jobs?: number
  noOwner?: boolean
  scratchDatabase?: string
  keepScratch?: boolean
}

function adminConnection(connection: ConnectionParams): ConnectionParams {
  return withDatabase(connection, 'postgres')
}

function dropDatabaseArgv(connection: ConnectionParams, database: string): string[] {
  return [
    'dropdb',
    `--host=${connection.host}`,
    `--port=${connection.port}`,
    `--username=${connection.user}`,
    '--if-exists',
    database,
  ]
}

/** Reads the source database recorded in a custom/directory archive header. */
export async function artifactDatabase(
  executor: Executor,
  inputPath: string,
  format: LogicalFormat,
): Promise<string | null> {
  if (format === 'plain') return null
  const result = await executor.run(['pg_restore', '--list', inputPath])
  if (result.exitCode !== 0) return null
  const match = /^;\s+dbname:\s+(.+?)\s*$/m.exec(result.stdout)
  return match?.[1] ?? null
}

/** Row counts for every ordinary/partitioned table in user schemas. */
export async function listTableCounts(
  executor: Executor,
  connection: ConnectionParams,
): Promise<Map<string, number>> {
  const result = await executor.run([...PSQL_ARGS, COUNT_SQL], {
    env: connectionEnv(connection),
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `count query failed: ${redactConnection(result.stderr.trim(), connection)}`,
    )
  }

  const counts = new Map<string, number>()
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue
    const [relation, value] = line.split('\t')
    if (relation === undefined || value === undefined) continue
    counts.set(relation, Number(value))
  }
  return counts
}

function compareCounts(
  source: ReadonlyMap<string, number>,
  target: ReadonlyMap<string, number>,
): TableCount[] {
  const relations = new Set([...source.keys(), ...target.keys()])
  return [...relations].sort().map((relation) => {
    const sourceCount = source.get(relation) ?? null
    const targetCount = target.get(relation) ?? null
    return {
      relation,
      source: sourceCount,
      target: targetCount,
      match: sourceCount !== null && targetCount !== null && sourceCount === targetCount,
    }
  })
}

/**
 * Restores a logical artifact into a scratch database, compares table row
 * counts against the source, and drops the scratch database unless kept.
 */
export async function verifyLogicalRestore(
  executor: Executor,
  options: VerifyLogicalOptions,
): Promise<VerificationReport> {
  const admin = adminConnection(options.connection)
  const scratch =
    options.scratchDatabase ??
    `bk_verify_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const warnings: string[] = []

  const created = await executor.run(buildCreateDatabaseArgv(admin, scratch), {
    env: connectionEnv(admin),
  })
  if (created.exitCode !== 0) {
    throw new Error(`createdb failed: ${redactConnection(created.stderr.trim(), admin)}`)
  }

  const target = withDatabase(options.connection, scratch)
  const restore = await executor.run(
    buildRestoreArgv({
      connection: options.connection,
      inputPath: options.inputPath,
      format: options.format,
      database: scratch,
      ...(options.noOwner === undefined ? {} : { noOwner: options.noOwner }),
      ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    }),
    { env: connectionEnv(target) },
  )

  let tables: TableCount[] = []
  if (restore.exitCode === 0) {
    try {
      const sourceCounts = await listTableCounts(
        executor,
        withDatabase(options.connection, options.connection.database),
      )
      const targetCounts = await listTableCounts(executor, target)
      tables = compareCounts(sourceCounts, targetCounts)
    } catch (error) {
      warnings.push((error as Error).message)
    }
  } else {
    warnings.push(`restore exited with code ${restore.exitCode}`)
  }

  if (options.keepScratch !== true) {
    const dropped = await executor.run(dropDatabaseArgv(admin, scratch), {
      env: connectionEnv(admin),
    })
    if (dropped.exitCode !== 0) {
      warnings.push(`dropdb failed: ${redactConnection(dropped.stderr.trim(), admin)}`)
    }
  }

  return {
    ok: restore.exitCode === 0 && tables.every((table) => table.match),
    scratchDatabase: scratch,
    restoreExitCode: restore.exitCode,
    tables,
    warnings,
  }
}
