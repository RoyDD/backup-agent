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

/**
 * One row per relation: `relation<TAB>[{name,type,notnull,default}, ...]`.
 * Attributes are ordered by `attnum`, so the payload is stable for comparison.
 */
const COLUMNS_SQL = `select n.nspname || '.' || c.relname as rel,
  coalesce(
    json_agg(
      json_build_object(
        'name', a.attname,
        'type', format_type(a.atttypid, a.atttypmod),
        'notnull', a.attnotnull,
        'default', pg_get_expr(d.adbin, d.adrelid)
      ) order by a.attnum
    ) filter (where a.attname is not null),
    '[]'::json
  )::text as columns
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_attribute a
  on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where c.relkind in ('r', 'p')
  and n.nspname not in ('pg_catalog', 'information_schema')
group by 1
order by 1`

/** One row per constraint: `relation<TAB>conname<TAB>convalidated<TAB>definition`. */
const CONSTRAINTS_SQL = `select n.nspname || '.' || c.relname as rel,
  con.conname,
  con.convalidated::text,
  pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname not in ('pg_catalog', 'information_schema')
order by 1, 2`

/** One row per index: `relation<TAB>index<TAB>method<TAB>definition`. */
const INDEXES_SQL = `select n.nspname || '.' || c.relname as rel,
  ic.relname as index_name,
  am.amname,
  pg_get_indexdef(i.indexrelid) as definition
from pg_index i
join pg_class c on c.oid = i.indrelid
join pg_class ic on ic.oid = i.indexrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_am am on am.oid = ic.relam
where n.nspname not in ('pg_catalog', 'information_schema')
order by 1, 2`

/** btree indexes in user schemas, the only relation kind amcheck can verify. */
const AMCHECK_INDEXES_SQL = `select n.nspname, ic.relname
from pg_index i
join pg_class ic on ic.oid = i.indexrelid
join pg_namespace n on n.oid = ic.relnamespace
join pg_am am on am.oid = ic.relam
where am.amname = 'btree'
  and ic.relkind = 'i'
  and n.nspname not in ('pg_catalog', 'information_schema')
order by 1, 2`

const CREATE_AMCHECK_SQL = 'create extension if not exists amcheck'

/** amcheck walks a whole btree; the cap keeps a wide schema bounded. */
const MAX_AMCHECK_INDEXES = 200

export interface TableCount {
  relation: string
  source: number | null
  target: number | null
  match: boolean
}

export interface SchemaDifference {
  relation: string
  kind: 'relation' | 'column' | 'constraint' | 'index'
  detail: string
}

export interface VerifySchemaReport {
  compared: boolean
  differences: SchemaDifference[]
}

export interface VerifyAmcheckReport {
  available: boolean
  checked: number
  /** Qualified index names whose check failed. */
  failed: string[]
  /** Why amcheck could not run at all (extension unavailable/permission). */
  reason: string | null
}

export interface VerificationReport {
  ok: boolean
  scratchDatabase: string
  restoreExitCode: number
  /** True only when both row-count queries succeeded and were compared. */
  compared: boolean
  tables: TableCount[]
  schema: VerifySchemaReport
  amcheck: VerifyAmcheckReport
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

interface ColumnShape {
  name: string
  type: string
  notnull: boolean
  default: string | null
}

interface ConstraintShape {
  definition: string
  validated: boolean
}

interface IndexShape {
  definition: string
  method: string
}

interface SchemaSnapshot {
  columns: Map<string, ColumnShape[]>
  constraints: Map<string, Map<string, ConstraintShape>>
  indexes: Map<string, Map<string, IndexShape>>
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

function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').trim()
}

/**
 * Quotes a SQL identifier for interpolation into an `-c` argument. Values stay
 * inside argv and are never assembled into a shell string.
 */
function quoteIdentifier(name: string): string {
  return `"${name.split('"').join('""')}"`
}

function parseRows(stdout: string): string[][] {
  const rows: string[][] = []
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    rows.push(line.split('\t'))
  }
  return rows
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

interface QueryRequest {
  label: string
  sql: string
  connection: ConnectionParams
}

/**
 * Runs one schema query. A failure is reported through `warnings` and yields
 * `null`, so the caller can fail the whole comparison closed.
 */
async function queryRows(
  executor: Executor,
  request: QueryRequest,
  warnings: string[],
): Promise<string[][] | null> {
  try {
    const result = await executor.run([...PSQL_ARGS, request.sql], {
      env: connectionEnv(request.connection),
    })
    if (result.exitCode !== 0) {
      warnings.push(
        `${request.label} query failed: ${redactConnection(firstLine(result.stderr), request.connection)}`,
      )
      return null
    }
    return parseRows(result.stdout)
  } catch (error) {
    warnings.push(
      `${request.label} query failed: ${redactConnection((error as Error).message, request.connection)}`,
    )
    return null
  }
}

function parseColumns(
  rows: readonly string[][],
  side: string,
  warnings: string[],
): Map<string, ColumnShape[]> {
  const columns = new Map<string, ColumnShape[]>()
  for (const fields of rows) {
    const [relation, payload] = fields
    if (relation === undefined || payload === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      warnings.push(`${side} columns payload for ${relation} was not valid JSON; ignored`)
      continue
    }
    if (!Array.isArray(parsed)) continue
    const shapes: ColumnShape[] = []
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record.name !== 'string' || typeof record.type !== 'string') continue
      shapes.push({
        name: record.name,
        type: record.type,
        notnull: record.notnull === true,
        default: typeof record.default === 'string' ? record.default : null,
      })
    }
    columns.set(relation, shapes)
  }
  return columns
}

/** Reads relations/columns, constraints and indexes for one database. */
async function snapshotSchema(
  executor: Executor,
  connection: ConnectionParams,
  side: string,
  warnings: string[],
): Promise<SchemaSnapshot | null> {
  const [columnRows, constraintRows, indexRows] = await Promise.all([
    queryRows(executor, { label: `${side} columns`, sql: COLUMNS_SQL, connection }, warnings),
    queryRows(
      executor,
      { label: `${side} constraints`, sql: CONSTRAINTS_SQL, connection },
      warnings,
    ),
    queryRows(executor, { label: `${side} indexes`, sql: INDEXES_SQL, connection }, warnings),
  ])
  if (columnRows === null || constraintRows === null || indexRows === null) return null

  const constraints = new Map<string, Map<string, ConstraintShape>>()
  for (const fields of constraintRows) {
    const [relation, name, validated, ...rest] = fields
    if (relation === undefined || name === undefined) continue
    const byName = constraints.get(relation) ?? new Map<string, ConstraintShape>()
    byName.set(name, {
      definition: rest.join('\t'),
      validated: validated === 't' || validated === 'true',
    })
    constraints.set(relation, byName)
  }

  const indexes = new Map<string, Map<string, IndexShape>>()
  for (const fields of indexRows) {
    const [relation, name, method, ...rest] = fields
    if (relation === undefined || name === undefined) continue
    const byName = indexes.get(relation) ?? new Map<string, IndexShape>()
    byName.set(name, { definition: rest.join('\t'), method: method ?? '' })
    indexes.set(relation, byName)
  }

  return {
    columns: parseColumns(columnRows, side, warnings),
    constraints,
    indexes,
  }
}

function compareColumns(
  relation: string,
  source: readonly ColumnShape[],
  target: readonly ColumnShape[],
): SchemaDifference[] {
  const differences: SchemaDifference[] = []
  const sourceByName = new Map(source.map((column) => [column.name, column]))
  const targetByName = new Map(target.map((column) => [column.name, column]))

  for (const column of source) {
    const counterpart = targetByName.get(column.name)
    if (counterpart === undefined) {
      differences.push({
        relation,
        kind: 'column',
        detail: `column "${column.name}" only in source`,
      })
      continue
    }
    if (counterpart.type !== column.type) {
      differences.push({
        relation,
        kind: 'column',
        detail: `column "${column.name}" type: source=${column.type} target=${counterpart.type}`,
      })
    }
    if (counterpart.notnull !== column.notnull) {
      differences.push({
        relation,
        kind: 'column',
        detail: `column "${column.name}" notnull: source=${column.notnull} target=${counterpart.notnull}`,
      })
    }
    if (counterpart.default !== column.default) {
      differences.push({
        relation,
        kind: 'column',
        detail: `column "${column.name}" default: source=${column.default} target=${counterpart.default}`,
      })
    }
  }

  for (const column of target) {
    if (!sourceByName.has(column.name)) {
      differences.push({
        relation,
        kind: 'column',
        detail: `column "${column.name}" only in target`,
      })
    }
  }

  return differences
}

function compareNamed<T>(
  relation: string,
  kind: 'constraint' | 'index',
  noun: string,
  source: ReadonlyMap<string, T> | undefined,
  target: ReadonlyMap<string, T> | undefined,
  describe: (value: T) => { definition: string; tail: string },
): SchemaDifference[] {
  const differences: SchemaDifference[] = []
  for (const [name, value] of source ?? new Map<string, T>()) {
    const counterpart = target?.get(name)
    if (counterpart === undefined) {
      differences.push({ relation, kind, detail: `${noun} "${name}" only in source` })
      continue
    }
    const left = describe(value)
    const right = describe(counterpart)
    if (left.definition !== right.definition) {
      differences.push({
        relation,
        kind,
        detail: `${noun} "${name}" definition: source=${left.definition} target=${right.definition}`,
      })
    }
    if (left.tail !== right.tail) {
      differences.push({
        relation,
        kind,
        detail: `${noun} "${name}" ${kind === 'constraint' ? 'convalidated' : 'method'}: source=${left.tail} target=${right.tail}`,
      })
    }
  }
  for (const name of target?.keys() ?? []) {
    if (!source?.has(name)) {
      differences.push({ relation, kind, detail: `${noun} "${name}" only in target` })
    }
  }
  return differences
}

function sortDifferences(differences: SchemaDifference[]): SchemaDifference[] {
  return differences.sort(
    (left, right) =>
      left.relation.localeCompare(right.relation) ||
      left.kind.localeCompare(right.kind) ||
      left.detail.localeCompare(right.detail),
  )
}

function compareSchema(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
): SchemaDifference[] {
  const differences: SchemaDifference[] = []
  const relations = new Set([...source.columns.keys(), ...target.columns.keys()])

  for (const relation of relations) {
    const sourceColumns = source.columns.get(relation)
    const targetColumns = target.columns.get(relation)
    if (sourceColumns === undefined) {
      differences.push({ relation, kind: 'relation', detail: 'only in target' })
      continue
    }
    if (targetColumns === undefined) {
      differences.push({ relation, kind: 'relation', detail: 'only in source' })
      continue
    }
    differences.push(...compareColumns(relation, sourceColumns, targetColumns))
    differences.push(
      ...compareNamed(
        relation,
        'constraint',
        'constraint',
        source.constraints.get(relation),
        target.constraints.get(relation),
        (value) => ({ definition: value.definition, tail: String(value.validated) }),
      ),
    )
    differences.push(
      ...compareNamed(
        relation,
        'index',
        'index',
        source.indexes.get(relation),
        target.indexes.get(relation),
        (value) => ({ definition: value.definition, tail: value.method }),
      ),
    )
  }

  return sortDifferences(differences)
}

/**
 * Index-level amcheck. Installing the extension needs superuser; that failure
 * is reported but never by itself fails a verification run.
 */
async function runAmcheck(
  executor: Executor,
  connection: ConnectionParams,
  warnings: string[],
): Promise<VerifyAmcheckReport> {
  let available = false
  let reason: string | null = null

  try {
    const created = await executor.run([...PSQL_ARGS, CREATE_AMCHECK_SQL], {
      env: connectionEnv(connection),
    })
    if (created.exitCode !== 0) {
      reason = redactConnection(firstLine(created.stderr), connection) || 'amcheck unavailable'
      warnings.push(`amcheck unavailable: ${reason}`)
      return { available: false, checked: 0, failed: [], reason }
    }
    available = true

    const listed = await executor.run([...PSQL_ARGS, AMCHECK_INDEXES_SQL], {
      env: connectionEnv(connection),
    })
    if (listed.exitCode !== 0) {
      reason = redactConnection(firstLine(listed.stderr), connection) || 'index listing failed'
      warnings.push(`amcheck index listing failed: ${reason}`)
      return { available: false, checked: 0, failed: [], reason }
    }

    const indexes: Array<{ schema: string; index: string }> = []
    for (const fields of parseRows(listed.stdout)) {
      const [schema, index] = fields
      if (schema === undefined || index === undefined) continue
      indexes.push({ schema, index })
    }

    const selected = indexes.slice(0, MAX_AMCHECK_INDEXES)
    if (indexes.length > selected.length) {
      warnings.push(
        `amcheck truncated: checked ${selected.length} of ${indexes.length} btree indexes`,
      )
    }

    const failed: string[] = []
    let checked = 0
    for (const entry of selected) {
      const qualified = `${quoteIdentifier(entry.schema)}.${quoteIdentifier(entry.index)}`
      // Identifiers are quoted for regclass; embedded quotes are doubled for the literal.
      const literal = qualified.split("'").join("''")
      const result = await executor.run(
        [...PSQL_ARGS, `select bt_index_check('${literal}'::regclass, true)`],
        { env: connectionEnv(connection) },
      )
      checked += 1
      if (result.exitCode !== 0) {
        failed.push(qualified)
        warnings.push(
          `amcheck failed for ${qualified}: ${redactConnection(firstLine(result.stderr), connection)}`,
        )
      }
    }

    return { available, checked, failed, reason }
  } catch (error) {
    reason = redactConnection((error as Error).message, connection)
    warnings.push(`amcheck unavailable: ${reason}`)
    return { available: false, checked: 0, failed: [], reason }
  }
}

/**
 * Restores a logical artifact into a scratch database, compares row counts and
 * schema against the source, runs amcheck on btree indexes, and drops the
 * scratch database unless kept.
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

  const source = withDatabase(options.connection, options.connection.database)
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
  let compared = false
  let schema: VerifySchemaReport = { compared: false, differences: [] }
  let amcheck: VerifyAmcheckReport = { available: false, checked: 0, failed: [], reason: null }

  if (restore.exitCode === 0) {
    try {
      const sourceCounts = await listTableCounts(executor, source)
      const targetCounts = await listTableCounts(executor, target)
      tables = compareCounts(sourceCounts, targetCounts)
      // Both queries returned: an empty-vs-empty comparison is still a proof.
      compared = true
    } catch (error) {
      warnings.push((error as Error).message)
      warnings.push('table count comparison did not run; the restore is unverified')
    }

    const [sourceSchema, targetSchema] = await Promise.all([
      snapshotSchema(executor, source, 'source', warnings),
      snapshotSchema(executor, target, 'target', warnings),
    ])
    if (sourceSchema !== null && targetSchema !== null) {
      schema = { compared: true, differences: compareSchema(sourceSchema, targetSchema) }
    } else {
      warnings.push('schema comparison did not run; the restore is unverified')
    }

    amcheck = await runAmcheck(executor, target, warnings)
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
    ok:
      restore.exitCode === 0 &&
      compared &&
      tables.every((table) => table.match) &&
      schema.compared &&
      schema.differences.length === 0 &&
      amcheck.failed.length === 0,
    compared,
    scratchDatabase: scratch,
    restoreExitCode: restore.exitCode,
    tables,
    schema,
    amcheck,
    warnings,
  }
}
