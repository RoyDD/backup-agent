import { spawn } from 'node:child_process'

import {
  DEFAULT_CLI,
  DEFAULT_KNOWLEDGE_CLI,
  TOOL_DEFINITIONS,
} from './tools.js'

/**
 * The one place a tool call becomes a `bkagent` process (ADR-008).
 *
 * `index.js` (dsh plugin), `mcp.js` (MCP stdio) and the replay gate all drive
 * the same definitions through this module. Keeping it here, free of any dsh
 * import, is what lets the gate exercise the production parse path instead of
 * a copy of it: a gate with its own copy can pass while the real path breaks.
 */

export { DEFAULT_CLI, DEFAULT_KNOWLEDGE_CLI }

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

/**
 * Turns one finished process into the value the tool returns.
 *
 * A non-zero exit is normally a tool failure. `goal run` and `goal remediate`
 * are the exception: they report a decision (a diagnosis with its candidate
 * set, or a refusal) on stdout and still exit non-zero, because a shell script
 * has to be able to tell that the goal did not finish. Dropping that payload
 * would hand the model an exit code and hide the only thing it can act on, so
 * those two definitions opt into `tolerateFailure`: the payload is returned
 * with the exit code attached instead of an exception.
 */
export function parseCliResult(result, options = {}) {
  const text = result.stdout.trim()
  let parsed = null
  if (text !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (result.code !== 0) {
    const carried = options.tolerateFailure === true && parsed !== null && typeof parsed === 'object'
    if (carried) return { ...parsed, exitCode: result.code }
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 2000)
    throw new Error(`bkagent exited ${result.code}${detail === '' ? '' : `: ${detail}`}`)
  }
  if (text === '') return {}
  return parsed ?? { raw: result.stdout }
}

/** Map one shared definition onto a runtime, one method per tool. */
export function createHandlers(run, knowledgeRun = run) {
  const handlers = {}
  for (const definition of TOOL_DEFINITIONS) {
    const execute = definition.cli === 'knowledge' ? knowledgeRun : run
    handlers[definition.method] = async (args, exec) =>
      parseCliResult(await execute(definition.buildArgv(args), {}, exec?.signal), {
        tolerateFailure: definition.tolerateFailure === true,
      })
  }
  return handlers
}
