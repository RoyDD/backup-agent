import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Cordis plugin exposing the backup-agent CLI as typed dsh tools.
 * Every tool is a thin adapter: argv is built here, execution and policy stay
 * in the control plane (`bkagent`). No SQL or shell string is accepted.
 */
export const name = 'backup-agent-tools'
export const inject = ['tools']

const DEFAULT_CLI = fileURLToPath(new URL('../../dist/bkagent.mjs', import.meta.url))
const DEFAULT_KNOWLEDGE_CLI = fileURLToPath(
  new URL('../../dist/bkagent-knowledge.mjs', import.meta.url),
)
const DEFAULT_KNOWLEDGE_DB = fileURLToPath(
  new URL('../../var/knowledge.sqlite', import.meta.url),
)

export function createRunner(options = {}) {
  const cliPath = options.cliPath ?? process.env.BKAGENT_CLI ?? DEFAULT_CLI
  return async function run(args, env = {}) {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout += chunk
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    })
  }
}

export function createKnowledgeRunner(options = {}) {
  return createRunner({
    cliPath:
      options.cliPath ?? process.env.BKAGENT_KNOWLEDGE_CLI ?? DEFAULT_KNOWLEDGE_CLI,
  })
}

export function parseCliResult(result) {
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 2000)
    throw new Error(`bkagent exited ${result.code}${detail === '' ? '' : `: ${detail}`}`)
  }
  const text = result.stdout.trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: result.stdout }
  }
}

function defaultDb() {
  return process.env.BKAGENT_DB ?? '.bkagent/control.db'
}

export function createHandlers(run, knowledgeRun = run) {
  return {
    async inspect(args) {
      return parseCliResult(await run(['inspect', '--dsn', args.dsn, '--format', 'json']))
    },

    async backup(args) {
      const argv = ['backup', '--dsn', args.dsn, '--out', args.out]
      if (args.database !== undefined) argv.push('--database', args.database)
      if (args.mode !== undefined) argv.push('--mode', args.mode)
      if (args.format !== undefined) argv.push('--format', args.format)
      if (args.jobs !== undefined) argv.push('--jobs', String(args.jobs))
      if (args.db !== undefined) argv.push('--db', args.db)
      return parseCliResult(await run(argv))
    },

    async restore(args) {
      const argv = ['restore', '--dsn', args.dsn, '--input', args.input, '--yes']
      if (args.database !== undefined) argv.push('--database', args.database)
      if (args.format !== undefined) argv.push('--format', args.format)
      if (args.createDatabase === true) argv.push('--create-database')
      if (args.clean === true) argv.push('--clean')
      if (args.noOwner === true) argv.push('--no-owner')
      if (args.db !== undefined) argv.push('--db', args.db)
      return parseCliResult(await run(argv))
    },

    async verify(args) {
      const argv = ['verify', '--dsn', args.dsn, '--input', args.input]
      if (args.database !== undefined) argv.push('--database', args.database)
      if (args.format !== undefined) argv.push('--format', args.format)
      return parseCliResult(await run(argv))
    },

    async catalog(args) {
      const argv = ['catalog', '--db', args.db ?? defaultDb(), '--format', 'json']
      if (args.target !== undefined) argv.push('--target', args.target)
      if (args.limit !== undefined) argv.push('--limit', String(args.limit))
      return parseCliResult(await run(argv))
    },

    async report(args) {
      const argv = ['report', '--db', args.db ?? defaultDb(), '--format', 'json']
      if (args.since !== undefined) argv.push('--since', args.since)
      return parseCliResult(await run(argv))
    },

    async kbSearch(args) {
      const argv = ['ask', args.query, '--json']
      if (args.k !== undefined) argv.push('--k', String(args.k))
      argv.push(
        '--db',
        args.db ?? process.env.BK_KNOWLEDGE_DB ?? DEFAULT_KNOWLEDGE_DB,
      )
      return parseCliResult(await knowledgeRun(argv))
    },
  }
}

/**
 * ADR-006: a destructive tool has no identity of its own. The request is
 * routed through the dsh approval seam for the calling agent; a missing agent
 * or answerer fails closed.
 */
export async function requireApproval(ctx, exec, toolName, reason) {
  if (exec.agent === undefined) {
    throw new Error('没有可用的发起主体，拒绝破坏性操作')
  }
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new Error('审批服务不可用，拒绝破坏性操作')
  }
  const outcome = await approval.request({
    agent: exec.agent,
    toolName,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  if (outcome !== 'allowed-once') {
    throw new Error(`操作未获批准：${outcome}`)
  }
}

function textTool(toolName, description, parameters, execute) {
  return defineTool({
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const value = await execute(args, exec)
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    },
  })
}

export function apply(ctx) {
  const run = createRunner()
  const knowledgeRun = createKnowledgeRunner()
  const handlers = createHandlers(run, knowledgeRun)

  ctx.tools.register(
    textTool(
      'pg_inspect',
      '只读：读取 PostgreSQL 实例版本、角色、WAL、归档与数据库清单。',
      { dsn: { type: 'string', required: true, description: 'postgres:// URI' } },
      (args) => handlers.inspect(args),
    ),
  )

  ctx.tools.register(
    textTool(
      'pg_backup',
      '对 PostgreSQL 执行逻辑或物理备份。只读操作，不修改数据库。',
      {
        dsn: { type: 'string', required: true, description: 'postgres:// URI' },
        out: { type: 'string', required: true, description: '产物路径' },
        database: { type: 'string', description: '目标数据库' },
        mode: { type: 'string', description: 'logical 或 physical' },
        format: { type: 'string', description: 'custom|directory|plain|tar' },
        jobs: { type: 'number', description: '并行度（仅 directory）' },
        db: { type: 'string', description: '控制库路径' },
      },
      (args) => handlers.backup(args),
    ),
  )

  ctx.tools.register(
    textTool(
      'pg_restore',
      '恢复逻辑备份到目标数据库。建库或 --clean 属于破坏性操作，须经审批。',
      {
        dsn: { type: 'string', required: true, description: 'postgres:// URI' },
        input: { type: 'string', required: true, description: '备份路径' },
        database: { type: 'string', description: '目标数据库' },
        format: { type: 'string', description: 'custom|directory|plain' },
        createDatabase: { type: 'boolean', description: '先创建数据库' },
        clean: { type: 'boolean', description: '恢复前清理对象' },
        noOwner: { type: 'boolean', description: '不恢复属主' },
        db: { type: 'string', description: '控制库路径' },
      },
      async (args, exec) => {
        if (args.clean === true || args.createDatabase === true) {
          await requireApproval(
            ctx,
            exec,
            'pg_restore',
            '恢复计划包含建库或清理，属于破坏性操作',
          )
        }
        return handlers.restore(args)
      },
    ),
  )

  ctx.tools.register(
    textTool(
      'pg_verify',
      '将逻辑备份恢复到临时库并比对各表行数，返回一致性报告。',
      {
        dsn: { type: 'string', required: true, description: 'postgres:// URI' },
        input: { type: 'string', required: true, description: '备份路径' },
        database: { type: 'string', description: '源数据库' },
        format: { type: 'string', description: 'custom|directory|plain' },
      },
      (args) => handlers.verify(args),
    ),
  )

  ctx.tools.register(
    textTool(
      'pg_catalog',
      '只读：列出控制库中的备份产物清单。',
      {
        db: { type: 'string', description: '控制库路径' },
        target: { type: 'string', description: '目标过滤' },
        limit: { type: 'number', description: '返回条数上限' },
      },
      (args) => handlers.catalog(args),
    ),
  )

  ctx.tools.register(
    textTool(
      'kb_search',
      '只读：在 PostgreSQL 备份恢复证据库（SAG2）中检索原文段落，返回 source#ordinal、标题路径与得分。只返回证据，不生成结论。',
      {
        query: { type: 'string', required: true, description: '检索问题' },
        k: { type: 'number', description: '返回条数，默认 5' },
        db: { type: 'string', description: '知识索引路径' },
      },
      (args) => handlers.kbSearch(args),
    ),
  )

  ctx.tools.register(
    textTool(
      'pg_report',
      '只读：生成指定时间窗口的备份运行报表（JSON）。',
      {
        db: { type: 'string', description: '控制库路径' },
        since: { type: 'string', description: 'ISO 时间或 Nd，例如 7d' },
      },
      (args) => handlers.report(args),
    ),
  )
}
