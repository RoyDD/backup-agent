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

/**
 * JSON Schema cannot express "this field is required for that enum value", so
 * each `op` branch checks its own fields here. Failing before `spawn` keeps the
 * error next to the caller instead of turning into a CLI usage exit.
 */
function requireArg(args, key, tool) {
  const value = args[key]
  if (value === undefined || value === null) {
    throw new Error(`${tool} requires ${key}`)
  }
  return value
}

const GOAL_OPS = ['open', 'plan', 'next', 'status', 'diagnose']
const REMEDIATION_KINDS = ['retry', 'replan', 'escalate', 'abandon']

/**
 * Mirrors `ACTION_COMMANDS` in `packages/core/src/domain/action.ts`. The enum
 * only narrows what the model may propose; the core re-validates every action
 * (command, allowed flags, required flags, enum values, shell metacharacters),
 * so a drift here costs the tool a verb — it can never widen what the control
 * plane accepts.
 */
const ACTION_COMMANDS = [
  'inspect',
  'providers',
  'backup',
  'restore',
  'verify',
  'pitr',
  'pgbackrest-backup',
  'pgbackrest-restore',
  'pgbackrest-expire',
  'walg-backup',
  'walg-restore',
  'walg-prune',
  'catalog',
  'report',
  'metrics',
  'capacity',
  'asset-list',
  'asset-rpo',
  'trace',
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

  /**
   * The goal loop (see `docs/agent-loop.md`). `approve-step` is deliberately
   * not exposed as a tool. Approval is a human CLI action; with no tool that
   * can approve a step, no destructive step can ever become runnable from MCP
   * or from a model alone. Marking `bk_step_run` destructive instead would gate
   * read-only steps for no additional safety.
   */
  {
    name: 'bk_goal',
    method: 'goal',
    description:
      '目标与步骤：open 建立目标并持久化拆解，plan 提交或修订拆解，next 取下一个可运行步骤，status 查看目标与步骤状态，diagnose 返回失败诊断与候选修复集。',
    inputSchema: objectSchema(
      {
        op: {
          type: 'string',
          enum: GOAL_OPS,
          description: 'open|plan|next|status|diagnose',
        },
        goal: { type: 'string', description: '目标 id（plan/next/status 必填）' },
        step: { type: 'string', description: '步骤 id（diagnose 必填）' },
        target: { type: 'string', description: '目标资产 id（open 必填）' },
        intent: { type: 'string', description: '操作者原话（open 必填）' },
        steps: {
          type: 'array',
          description:
            '拆解步骤数组（open/plan 必填）：每项含 intent、action{command,args}、可选 dependsOn（1 基序号）与 maxAttempts',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['intent', 'action'],
            properties: {
              intent: { type: 'string', description: '该步为什么存在' },
              action: {
                type: 'object',
                additionalProperties: false,
                required: ['command', 'args'],
                properties: {
                  command: {
                    type: 'string',
                    enum: ACTION_COMMANDS,
                    description: '产品动词，受 capability grammar 约束',
                  },
                  args: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '扁平 argv 尾巴；值紧跟其 flag，禁止 --yes/--db/--principal',
                  },
                },
              },
              dependsOn: {
                type: 'array',
                items: { type: 'integer' },
                description: '依赖的更早步骤序号（1 基）',
              },
              maxAttempts: { type: 'integer', description: '该步尝试预算' },
            },
          },
        },
        constraints: {
          type: 'object',
          additionalProperties: true,
          description:
            '目标约束对象：maxSteps、maxStepAttempts、maxGoalAttempts、allowDestructive',
        },
        principal: { type: 'string', description: '发起主体 id' },
        db: CONTROL_DB,
      },
      ['op'],
    ),
    requiresApproval: false,
    buildArgv(args) {
      const db = args.db ?? defaultDb()
      switch (args.op) {
        case 'open': {
          const target = requireArg(args, 'target', 'bk_goal op=open')
          const intent = requireArg(args, 'intent', 'bk_goal op=open')
          const argv = ['goal', 'add', '--target', target, '--intent', intent]
          if (args.steps !== undefined) {
            argv.push('--steps-json', JSON.stringify(args.steps))
          }
          if (args.constraints !== undefined) {
            argv.push('--constraints-json', JSON.stringify(args.constraints))
          }
          if (args.principal !== undefined) argv.push('--principal', args.principal)
          argv.push('--db', db)
          return argv
        }
        case 'plan': {
          const goal = requireArg(args, 'goal', 'bk_goal op=plan')
          const steps = requireArg(args, 'steps', 'bk_goal op=plan')
          return [
            'goal',
            'plan',
            '--goal',
            goal,
            '--steps-json',
            JSON.stringify(steps),
            '--db',
            db,
          ]
        }
        case 'next': {
          const goal = requireArg(args, 'goal', 'bk_goal op=next')
          return ['goal', 'next', '--goal', goal, '--db', db]
        }
        case 'status': {
          const goal = requireArg(args, 'goal', 'bk_goal op=status')
          return ['goal', 'show', '--goal', goal, '--db', db]
        }
        case 'diagnose': {
          const step = requireArg(args, 'step', 'bk_goal op=diagnose')
          return ['goal', 'diagnose', '--step', step, '--db', db]
        }
        default:
          throw new Error(
            `bk_goal: unknown op ${String(args.op)}; expected ${GOAL_OPS.join('|')}`,
          )
      }
    },
  },

  {
    name: 'bk_step_run',
    method: 'stepRun',
    description:
      '按目标顺序执行下一个可运行步骤：拼接 argv、调用同一条 CLI 入口、记录尝试与诊断。破坏性步骤只有已获人工审批时才可执行。',
    inputSchema: objectSchema(
      {
        goal: { type: 'string', description: '目标 id' },
        db: CONTROL_DB,
      },
      ['goal'],
    ),
    requiresApproval: false,
    buildArgv(args) {
      return ['goal', 'run', '--goal', args.goal, '--db', args.db ?? defaultDb()]
    },
  },

  {
    name: 'bk_remediate',
    method: 'remediate',
    description:
      '按诊断给出的候选集修订单个失败步骤：retry 重试、replan 替换该步动作、escalate 转人工、abandon 放弃。候选集之外的选择会被控制面拒绝。',
    inputSchema: objectSchema(
      {
        step: { type: 'string', description: '步骤 id' },
        kind: {
          type: 'string',
          enum: REMEDIATION_KINDS,
          description: 'retry|replan|escalate|abandon',
        },
        action: {
          type: 'object',
          additionalProperties: true,
          description: 'replan 的新动作：{command, args}（kind=replan 必填）',
        },
        reason: { type: 'string', description: '处置理由' },
        db: CONTROL_DB,
      },
      ['step', 'kind'],
    ),
    requiresApproval: false,
    buildArgv(args) {
      const argv = ['goal', 'remediate', '--step', args.step, '--kind', args.kind]
      // `replan` is an in-place action swap; without a new action it would be a
      // no-op retry wearing a different name, so refuse it here.
      if (args.kind === 'replan' && args.action === undefined) {
        throw new Error('bk_remediate kind=replan requires action')
      }
      if (args.action !== undefined) {
        argv.push('--action-json', JSON.stringify(args.action))
      }
      if (args.reason !== undefined) argv.push('--reason', args.reason)
      argv.push('--db', args.db ?? defaultDb())
      return argv
    },
  },

  {
    name: 'bk_recall',
    method: 'recall',
    description:
      '只读：检索该目标与失败签名的历史记忆（成功先例与教训），用于在拆解和选策略之前复用既有结论。',
    inputSchema: objectSchema({
      target: { type: 'string', description: '目标资产 id' },
      signature: { type: 'string', description: '失败签名，例如 sqlstate:42P01' },
      query: { type: 'string', description: '自由文本查询' },
      limit: { type: 'number', description: '返回条数上限' },
      db: CONTROL_DB,
    }),
    requiresApproval: false,
    buildArgv(args) {
      const argv = ['memory', 'search']
      if (args.target !== undefined) argv.push('--target', args.target)
      if (args.signature !== undefined) argv.push('--signature', args.signature)
      if (args.query !== undefined) argv.push('--query', args.query)
      if (args.limit !== undefined) argv.push('--limit', String(args.limit))
      argv.push('--db', args.db ?? defaultDb())
      return argv
    },
  },
]

export function findToolDefinition(name) {
  return TOOL_DEFINITIONS.find((definition) => definition.name === name)
}
