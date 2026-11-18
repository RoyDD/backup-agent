import { spawn } from 'node:child_process'

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_CLI,
  DEFAULT_KNOWLEDGE_CLI,
  TOOL_DEFINITIONS,
  defaultDb,
  findToolDefinition,
} from './tools.js'

/**
 * Cordis plugin exposing the backup-agent CLI as typed dsh tools.
 * Every tool is a thin adapter: argv is built in `tools.js` (ADR-008: the same
 * definitions feed the MCP server), execution and policy stay in the control
 * plane (`bkagent`). No SQL or shell string is accepted.
 */
export const name = 'backup-agent-tools'
export const inject = ['tools']

const DEFAULT_APPROVAL_REASON = '该工具会修改目标实例或数据目录，执行前须经审批'

export { defaultDb }

export function createRunner(options = {}) {
  const cliPath = options.cliPath ?? process.env.BKAGENT_CLI ?? DEFAULT_CLI
  /**
   * `signal` comes from the tool exec context: a cancelled tool call must kill
   * the backend process, not leave a backup running with nobody waiting.
   */
  return async function run(args, env = {}, signal) {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(signal === undefined ? {} : { signal }),
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

/** Map one shared definition onto the dsh runtime, one method per tool. */
export function createHandlers(run, knowledgeRun = run) {
  const handlers = {}
  for (const definition of TOOL_DEFINITIONS) {
    const execute = definition.cli === 'knowledge' ? knowledgeRun : run
    handlers[definition.method] = async (args, exec) =>
      parseCliResult(await execute(definition.buildArgv(args), {}, exec?.signal))
  }
  return handlers
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

/** Wrap any handler behind the approval seam for its definition. */
export function createApprovalToolHandler(ctx, definition, execute) {
  return async (args, exec) => {
    await requireApproval(
      ctx,
      exec,
      definition.name,
      definition.approvalReason ?? DEFAULT_APPROVAL_REASON,
    )
    return execute(args, exec)
  }
}

/** Kept for existing callers and tests; a thin wrapper over the generic seam. */
export function createRestoreToolHandler(ctx, restore) {
  return createApprovalToolHandler(ctx, findToolDefinition('pg_restore'), restore)
}

/** JSON Schema (shared with MCP) -> dsh per-property parameter DSL. */
export function toParameterSchema(inputSchema) {
  const required = new Set(inputSchema.required ?? [])
  const parameters = {}
  for (const [key, property] of Object.entries(inputSchema.properties ?? {})) {
    parameters[key] = toParameterSpec(property, required.has(key))
  }
  return parameters
}

/**
 * The dsh authoring DSL is not raw JSON Schema, so this projection recurses
 * instead of forwarding nodes:
 *
 * - object nodes need an explicit boolean `additionalProperties`;
 * - array nodes carry their element schema as `items`, which is compiled with
 *   the same DSL (and therefore the same rules);
 * - requiredness is a per-property `required: true`, never a `required: [...]`
 *   array, and `required` is not allowed on an `items` node at all.
 *
 * A node that keeps the JSON Schema shape makes the compiler reject the whole
 * tool, so the preset would fail to load rather than reject one argument.
 */
function toParameterSpec(property, isRequired = false) {
  const spec = { type: property.type }
  if (property.description !== undefined) spec.description = property.description
  if (property.enum !== undefined) spec.enum = property.enum
  // Only forward openness the source declared; never invent it.
  if (property.additionalProperties !== undefined) {
    spec.additionalProperties = property.additionalProperties
  }
  if (property.items !== undefined) {
    spec.items = toParameterSpec(property.items)
  }
  if (property.properties !== undefined) {
    const required = new Set(property.required ?? [])
    const properties = {}
    for (const [key, child] of Object.entries(property.properties)) {
      properties[key] = toParameterSpec(child, required.has(key))
    }
    spec.properties = properties
  }
  if (isRequired) spec.required = true
  return spec
}

function textTool(definition, execute) {
  return defineTool({
    name: definition.name,
    description: definition.description,
    parameters: toParameterSchema(definition.inputSchema),
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

  for (const definition of TOOL_DEFINITIONS) {
    const handler = handlers[definition.method]
    ctx.tools.register(
      textTool(
        definition,
        definition.requiresApproval === true
          ? createApprovalToolHandler(ctx, definition, handler)
          : handler,
      ),
    )
  }
}
