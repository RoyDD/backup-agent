import { describe, expect, it } from 'vitest'

import { parseDsn } from '@backup-agent/core'
import {
  FakeExecutor,
  type ExecutorCall,
  type ScriptedResponse,
} from '@backup-agent/core/testkit'

import { verifyLogicalRestore } from '../src/verify'

const connection = parseDsn('postgres://backup:secret@10.0.0.5:5433/app')

interface SqlResponse {
  exitCode?: number
  stdout?: string
  stderr?: string
}

interface DbScript {
  count: SqlResponse
  columns: SqlResponse
  constraints: SqlResponse
  indexes: SqlResponse
}

interface Script {
  source: DbScript
  target: DbScript
  restore?: SqlResponse
  extension?: SqlResponse
  listIndexes?: SqlResponse
  /** Keyed by unquoted `schema.index`; missing entries succeed. */
  checks?: Record<string, SqlResponse>
}

const COUNT = 'public.t1\t5\n'
const COLUMNS =
  'public.t1\t[{"name":"id","type":"integer","notnull":true,"default":null},{"name":"price","type":"numeric(10,2)","notnull":false,"default":null}]\n'
const CONSTRAINTS = 'public.t1\tt1_pkey\ttrue\tPRIMARY KEY (id)\n'
const INDEXES =
  'public.t1\tt1_pkey\tbtree\tCREATE UNIQUE INDEX t1_pkey ON public.t1 USING btree (id)\n'

function baseline(): Script {
  const db = (): DbScript => ({
    count: { stdout: COUNT },
    columns: { stdout: COLUMNS },
    constraints: { stdout: CONSTRAINTS },
    indexes: { stdout: INDEXES },
  })
  return {
    source: db(),
    target: db(),
    listIndexes: { stdout: 'public\tt1_pkey\n' },
  }
}

type SqlKind = keyof DbScript | 'extension' | 'listIndexes' | 'check'

function queryKind(sql: string): SqlKind | null {
  if (/create extension/i.test(sql)) return 'extension'
  if (/bt_index_check/.test(sql)) return 'check'
  if (/pg_get_indexdef/.test(sql)) return 'indexes'
  if (/pg_constraint/.test(sql)) return 'constraints'
  if (/pg_attribute/.test(sql)) return 'columns'
  if (/query_to_xml/.test(sql)) return 'count'
  if (/pg_am/.test(sql)) return 'listIndexes'
  return null
}

/** Qualified name as it appears in `bt_index_check('<name>'::regclass, true)`. */
function checkedIndex(sql: string): string {
  const match = /'([^']+)'::regclass/.exec(sql)
  return (match?.[1] ?? '').split('"').join('')
}

/**
 * Routes on SQL shape and on the connection the executor was handed, so the
 * source run and the scratch-database run can answer differently.
 */
function executor(script: Script): FakeExecutor {
  let calls: ExecutorCall[] = []
  const handler = (cmd: readonly string[]): ScriptedResponse | undefined => {
    if (cmd[0] === 'createdb' || cmd[0] === 'dropdb') return { exitCode: 0 }
    if (cmd[0] === 'pg_restore') return script.restore ?? { exitCode: 0 }
    if (cmd[0] !== 'psql') return undefined

    const sql = cmd[cmd.length - 1] ?? ''
    const kind = queryKind(sql)
    if (kind === null) throw new Error(`unrouted SQL: ${sql.slice(0, 80)}`)

    if (kind === 'extension') return script.extension ?? { exitCode: 0 }
    if (kind === 'listIndexes') return script.listIndexes ?? { stdout: '' }
    if (kind === 'check') return script.checks?.[checkedIndex(sql)] ?? { exitCode: 0 }

    const database = calls[calls.length - 1]?.opts?.env?.['PGDATABASE']
    return script[database === 'bk_verify_test' ? 'target' : 'source'][kind]
  }

  const fake = new FakeExecutor({ defaultHandler: handler })
  calls = fake.calls
  return fake
}

const options = {
  connection,
  inputPath: '/tmp/app.dump',
  format: 'custom' as const,
  scratchDatabase: 'bk_verify_test',
}

describe('verifyLogicalRestore', () => {
  it('compares row counts and reports a verified restore point', async () => {
    const report = await verifyLogicalRestore(executor(baseline()), options)

    expect(report.ok).toBe(true)
    expect(report.compared).toBe(true)
    expect(report.restoreExitCode).toBe(0)
    expect(report.tables).toEqual([
      { relation: 'public.t1', source: 5, target: 5, match: true },
    ])
    expect(report.schema).toEqual({ compared: true, differences: [] })
    expect(report.amcheck).toEqual({
      available: true,
      checked: 1,
      failed: [],
      reason: null,
    })
    expect(report.warnings).toEqual([])
  })

  it('never reports ok when the source count query fails', async () => {
    const script = baseline()
    script.source.count = { exitCode: 1, stderr: 'permission denied for table t1\n' }

    const report = await verifyLogicalRestore(executor(script), options)

    expect(report.ok).toBe(false)
    expect(report.compared).toBe(false)
    expect(report.tables).toEqual([])
    expect(report.warnings.some((warning) => /permission denied/.test(warning))).toBe(true)
    expect(report.warnings.some((warning) => /did not run/.test(warning))).toBe(true)
  })

  it('skips comparison when the restore itself failed', async () => {
    const script = baseline()
    script.restore = { exitCode: 1, stderr: 'pg_restore: error: corrupted archive' }

    const report = await verifyLogicalRestore(executor(script), options)

    expect(report.ok).toBe(false)
    expect(report.compared).toBe(false)
    expect(report.restoreExitCode).toBe(1)
    expect(report.tables).toEqual([])
    expect(report.schema).toEqual({ compared: false, differences: [] })
    expect(report.amcheck).toEqual({
      available: false,
      checked: 0,
      failed: [],
      reason: null,
    })
    expect(report.warnings).toEqual(['restore exited with code 1'])
  })

  it('reports a column type difference in the scratch database', async () => {
    const script = baseline()
    script.target.columns = {
      stdout:
        'public.t1\t[{"name":"id","type":"integer","notnull":true,"default":null},{"name":"price","type":"text","notnull":false,"default":null}]\n',
    }

    const report = await verifyLogicalRestore(executor(script), options)

    expect(report.ok).toBe(false)
    expect(report.schema.compared).toBe(true)
    expect(report.schema.differences).toEqual([
      {
        relation: 'public.t1',
        kind: 'column',
        detail: 'column "price" type: source=numeric(10,2) target=text',
      },
    ])
  })

  it('reports a relation that exists only in the scratch database', async () => {
    const script = baseline()
    script.target.count = { stdout: `${COUNT}public.t2\t0\n` }
    script.target.columns = {
      stdout: `${COLUMNS}public.t2\t[{"name":"id","type":"integer","notnull":true,"default":null}]\n`,
    }

    const report = await verifyLogicalRestore(executor(script), options)

    expect(report.ok).toBe(false)
    expect(report.schema.differences).toEqual([
      { relation: 'public.t2', kind: 'relation', detail: 'only in target' },
    ])
  })

  it('reports a constraint that is not validated in the scratch database', async () => {
    const script = baseline()
    script.target.constraints = {
      stdout: 'public.t1\tt1_pkey\tfalse\tPRIMARY KEY (id)\n',
    }

    const report = await verifyLogicalRestore(executor(script), options)

    expect(report.ok).toBe(false)
    expect(report.schema.differences).toEqual([
      {
        relation: 'public.t1',
        kind: 'constraint',
        detail: 'constraint "t1_pkey" convalidated: source=true target=false',
      },
    ])
  })

  it('does not fail the run when amcheck cannot be installed', async () => {
    const script = baseline()
    script.extension = {
      exitCode: 1,
      stderr: 'ERROR:  permission denied to create extension "amcheck"\n',
    }

    const report = await verifyLogicalRestore(executor(script), options)

    expect(report.ok).toBe(true)
    expect(report.amcheck.available).toBe(false)
    expect(report.amcheck.checked).toBe(0)
    expect(report.amcheck.failed).toEqual([])
    expect(report.amcheck.reason).toContain('permission denied')
    expect(report.warnings.some((warning) => /amcheck unavailable/.test(warning))).toBe(true)
  })

  it('fails the run when an index check reports corruption', async () => {
    const script = baseline()
    script.listIndexes = { stdout: 'public\tt1_pkey\npublic\tt1_id_idx\n' }
    script.checks = {
      'public.t1_id_idx': {
        exitCode: 1,
        stderr: 'ERROR:  index "t1_id_idx" is corrupted\n',
      },
    }

    const report = await verifyLogicalRestore(executor(script), options)

    expect(report.ok).toBe(false)
    expect(report.amcheck.available).toBe(true)
    expect(report.amcheck.checked).toBe(2)
    expect(report.amcheck.failed).toEqual(['"public"."t1_id_idx"'])
    expect(
      report.warnings.some((warning) =>
        /amcheck failed for "public"\."t1_id_idx": .*corrupted/.test(warning),
      ),
    ).toBe(true)
  })
})
