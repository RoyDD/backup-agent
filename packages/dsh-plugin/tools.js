import { fileURLToPath } from 'node:url'

/**
 * ADR-008: one tool definition, several entry points.
 *
 * The dsh plugin (`index.js`) and the MCP stdio server (`mcp.js`) both consume
 * this list. Nothing here executes anything: argv construction only, so the
 * control plane keeps ownership of policy, credentials and state.
 *
 * `inputSchema` is plain JSON Schema (MCP wire shape). The dsh plugin derives
 * its per-property parameter DSL from it in `index.js`; never duplicate the
 * schema in two places.
 */

const DEFAULT_CLI = fileURLToPath(new URL('../../dist/bkagent.mjs', import.meta.url))
const DEFAULT_KNOWLEDGE_CLI = fileURLToPath(
  new URL('../../dist/bkagent-knowledge.mjs', import.meta.url),
)
export const DEFAULT_KNOWLEDGE_DB = fileURLToPath(
  new URL('../../var/knowledge.sqlite', import.meta.url),
)

export { DEFAULT_CLI, DEFAULT_KNOWLEDGE_CLI }

export function defaultDb() {
  return process.env.BKAGENT_DB ?? '.bkagent/control.db'
}

const DSN = { type: 'string', description: 'postgres:// URI' }
const CONTROL_DB = { type: 'string', description: '控制库路径' }

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

const PITR_TARGETS = [
  ['targetTime', '--target-time'],
  ['targetLsn', '--target-lsn'],
  ['targetName', '--target-name'],
  ['targetXid', '--target-xid'],
]

export const TOOL_DEFINITIONS = [
  {
    name: 'pg_inspect',
    method: 'inspect',
    description: '只读：读取 PostgreSQL 实例版本、角色、WAL、归档与数据库清单。',
    inputSchema: objectSchema({ dsn: DSN }, ['dsn']),
    requiresApproval: false,
    buildArgv(args) {
      return ['inspect', '--dsn', args.dsn, '--format', 'json']
    },
  },

  {
    name: 'pg_backup',
    method: 'backup',
    description: '对 PostgreSQL 执行逻辑或物理备份。只读操作，不修改数据库。',
    inputSchema: objectSchema(
      {
        dsn: DSN,
        out: { type: 'string', description: '产物路径' },
        database: { type: 'string', description: '目标数据库' },
        mode: { type: 'string', description: 'logical 或 physical' },
        format: { type: 'string', description: 'custom|directory|plain|tar' },
        jobs: { type: 'number', description: '并行度（仅 directory）' },
        db: CONTROL_DB,
      },
      ['dsn', 'out'],
    ),
    requiresApproval: false,
    buildArgv(args) {
      const argv = ['backup', '--dsn', args.dsn, '--out', args.out]
      if (args.database !== undefined) argv.push('--database', args.database)
      if (args.mode !== undefined) argv.push('--mode', args.mode)
      if (args.format !== undefined) argv.push('--format', args.format)
      if (args.jobs !== undefined) argv.push('--jobs', String(args.jobs))
      argv.push('--db', args.db ?? defaultDb())
      return argv
    },
  },

  {
    name: 'pg_restore',
    method: 'restore',
    description:
      '恢复逻辑备份到目标数据库。所有恢复输入都可能包含破坏性 SQL，执行前须经审批。',
    inputSchema: objectSchema(
      {
        dsn: DSN,
        input: { type: 'string', description: '备份路径' },
        database: { type: 'string', description: '目标数据库' },
        format: { type: 'string', description: 'custom|directory|plain' },
        createDatabase: { type: 'boolean', description: '先创建数据库' },
        clean: { type: 'boolean', description: '恢复前清理对象' },
        noOwner: { type: 'boolean', description: '不恢复属主' },
        db: CONTROL_DB,
      },
      ['dsn', 'input'],
    ),
    requiresApproval: true,
    approvalReason: '所有逻辑恢复输入都可能包含 DROP 等破坏性 SQL',
    // `--yes` is unconditional: the approval seam is the single gate, and the
    // control plane still refuses without a registered asset and approvals.
    buildArgv(args) {
      const argv = ['restore', '--dsn', args.dsn, '--input', args.input, '--yes']
      if (args.database !== undefined) argv.push('--database', args.database)
      if (args.format !== undefined) argv.push('--format', args.format)
      if (args.createDatabase === true) argv.push('--create-database')
      if (args.clean === true) argv.push('--clean')
      if (args.noOwner === true) argv.push('--no-owner')
      argv.push('--db', args.db ?? defaultDb())
      return argv
    },
  },

  {
    name: 'pg_verify',
    method: 'verify',
    description: '将逻辑备份恢复到临时库并比对各表行数，返回一致性报告。',
    inputSchema: objectSchema(
      {
        dsn: DSN,
        input: { type: 'string', description: '备份路径' },
        database: { type: 'string', description: '源数据库' },
        format: { type: 'string', description: 'custom|directory|plain' },
      },
      ['dsn', 'input'],
    ),
    requiresApproval: false,
    buildArgv(args) {
      const argv = ['verify', '--dsn', args.dsn, '--input', args.input]
      if (args.database !== undefined) argv.push('--database', args.database)
      if (args.format !== undefined) argv.push('--format', args.format)
      return argv
    },
  },

  {
    name: 'pg_catalog',
    method: 'catalog',
    description: '只读：列出控制库中的备份产物清单。',
    inputSchema: objectSchema({
      db: CONTROL_DB,
      target: { type: 'string', description: '目标过滤' },
      limit: { type: 'number', description: '返回条数上限' },
    }),
    requiresApproval: false,
    buildArgv(args) {
      const argv = ['catalog', '--db', args.db ?? defaultDb(), '--format', 'json']
      if (args.target !== undefined) argv.push('--target', args.target)
      if (args.limit !== undefined) argv.push('--limit', String(args.limit))
      return argv
    },
  },

  {
    name: 'pg_report',
    method: 'report',
    description: '只读：生成指定时间窗口的备份运行报表（JSON）。',
    inputSchema: objectSchema({
      db: CONTROL_DB,
      since: { type: 'string', description: 'ISO 时间或 Nd，例如 7d' },
    }),
    requiresApproval: false,
    buildArgv(args) {
      const argv = ['report', '--db', args.db ?? defaultDb(), '--format', 'json']
      if (args.since !== undefined) argv.push('--since', args.since)
      return argv
    },
  },

  {
    name: 'kb_search',
    method: 'kbSearch',
    description:
      '只读：在 PostgreSQL 备份恢复证据库（SAG2）中检索原文段落，返回 source#ordinal、标题路径与得分。只返回证据，不生成结论。',
    inputSchema: objectSchema(
      {
        query: { type: 'string', description: '检索问题' },
        k: { type: 'number', description: '返回条数，默认 5' },
        db: { type: 'string', description: '知识索引路径' },
      },
      ['query'],
    ),
    requiresApproval: false,
    // The knowledge CLI owns its own executable; the runner picks it.
    cli: 'knowledge',
    buildArgv(args) {
      // Options first, then the `--` terminator: a question that starts with '-'
      // (for example "why does --type=time not apply") is a query, not a flag.
      const argv = ['ask', '--json']
      if (args.k !== undefined) argv.push('--k', String(args.k))
      argv.push(
        '--db',
        args.db ?? process.env.BK_KNOWLEDGE_DB ?? DEFAULT_KNOWLEDGE_DB,
        '--',
        String(args.query),
      )
      return argv
    },
  },

  {
    name: 'pg_pitr',
    method: 'pitr',
    description:
      '执行 PostgreSQL 时间点恢复（PITR）。破坏性操作：写入恢复目标 data directory 并以 promote/pause/shutdown 结束，执行前须经审批。',
    inputSchema: objectSchema(
      {
        dsn: DSN,
        dataDir: { type: 'string', description: '恢复目标的 data directory（PGDATA）' },
        port: { type: 'string', description: '恢复实例监听端口' },
        log: { type: 'string', description: '恢复实例日志路径' },
        restoreCommand: {
          type: 'string',
          description: 'restore_command，例如 cp /archive/%f %p',
        },
        targetTime: { type: 'string', description: '目标时间（target-time）' },
        targetLsn: { type: 'string', description: '目标 LSN（target-lsn）' },
        targetName: { type: 'string', description: '目标恢复点名称（target-name）' },
        targetXid: { type: 'string', description: '目标事务 ID（target-xid）' },
        action: { type: 'string', enum: ['promote', 'pause', 'shutdown'] },
        verifySql: { type: 'string', description: '恢复后断言 SQL' },
        stateDir: { type: 'string', description: '检查点目录，用于跨进程续跑' },
        resume: { type: 'boolean', description: '从 stateDir 的检查点续跑' },
        db: CONTROL_DB,
      },
      ['dsn', 'dataDir', 'port', 'log', 'restoreCommand'],
    ),
    requiresApproval: true,
    approvalReason: 'PITR 会重放 WAL 并结束恢复目标实例，属于破坏性操作',
    buildArgv(args) {
      // JSON Schema cannot express "exactly one target"; the CLI refuses too,
      // but failing here keeps the error next to the caller.
      const targets = PITR_TARGETS.filter(([key]) => args[key] !== undefined)
      if (targets.length !== 1) {
        throw new Error(
          `pg_pitr requires exactly one of ` +
            `${PITR_TARGETS.map(([key]) => key).join('|')}; got ${targets.length}`,
        )
      }
      const argv = [
        'pitr',
        '--dsn',
        args.dsn,
        '--data-dir',
        args.dataDir,
        '--port',
        String(args.port),
        '--log',
        args.log,
        '--restore-command',
        args.restoreCommand,
        targets[0][1],
        String(args[targets[0][0]]),
      ]
      if (args.action !== undefined) argv.push('--action', args.action)
      if (args.verifySql !== undefined) argv.push('--verify-sql', args.verifySql)
      if (args.stateDir !== undefined) argv.push('--state-dir', args.stateDir)
      if (args.resume === true) argv.push('--resume')
      argv.push('--yes', '--db', args.db ?? defaultDb())
      return argv
    },
  },
]

export function findToolDefinition(name) {
  return TOOL_DEFINITIONS.find((definition) => definition.name === name)
}
