#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createHandlers, createKnowledgeRunner, createRunner } from './index.js'
import { TOOL_DEFINITIONS } from './tools.js'

/**
 * MCP stdio entry point for the same tool registry the dsh plugin uses
 * (ADR-008). Newline-delimited JSON-RPC 2.0 on stdin/stdout; diagnostics go to
 * stderr only — stdout must stay pure protocol.
 *
 * MCP has no approval channel, so destructive tools are refused here instead of
 * silently running unapproved: fail closed, point at the dsh preset / CLI.
 */

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'backup-agent', version: '0.1.0' }

let cachedHandlers = null

function defaultHandlers() {
  if (cachedHandlers === null) {
    cachedHandlers = createHandlers(createRunner(), createKnowledgeRunner())
  }
  return cachedHandlers
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value }
}

function failure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolListing() {
  return TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }))
}

async function callTool(params, handlers, id) {
  if (!isPlainObject(params)) {
    return failure(id, -32602, 'tools/call requires an object params')
  }
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === params.name)
  if (definition === undefined) {
    return failure(id, -32602, `unknown tool: ${String(params.name)}`)
  }
  const args = params.arguments ?? {}
  if (!isPlainObject(args)) {
    return failure(id, -32602, 'tools/call arguments must be an object')
  }
  if (definition.requiresApproval === true) {
    return result(id, {
      content: [
        {
          type: 'text',
          text:
            `${definition.name} is destructive and requires the dsh approval seam; ` +
            'run it through the pg-dba preset or the CLI',
        },
      ],
      isError: true,
    })
  }
  try {
    const value = await handlers[definition.method](args, {})
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return result(id, { content: [{ type: 'text', text }] })
  } catch (error) {
    return result(id, {
      content: [
        { type: 'text', text: error instanceof Error ? error.message : String(error) },
      ],
      isError: true,
    })
  }
}

/**
 * Handle one decoded JSON-RPC message. Returns the response object, or null for
 * notifications (no `id`), which must not be answered.
 */
export async function handleRequest(request, handlers = defaultHandlers()) {
  if (!isPlainObject(request)) {
    return failure(null, -32600, 'Invalid Request')
  }
  const id = request.id ?? null
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return failure(id, -32600, 'Invalid Request')
  }
  const isNotification = request.id === undefined

  switch (request.method) {
    case 'initialize':
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })

    case 'ping':
      return result(id, {})

    case 'tools/list':
      return result(id, { tools: toolListing() })

    case 'tools/call':
      return await callTool(request.params, handlers, id)

    default:
      if (isNotification) return null
      return failure(id, -32601, `Method not found: ${request.method}`)
  }
}

/**
 * Serve the protocol over a stream pair. Lines are handled sequentially so
 * responses keep request order even when a tool spawns a child process.
 */
export function startServer(options = {}) {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const handlers = options.handlers ?? defaultHandlers()
  const log = options.log ?? ((message) => process.stderr.write(`${message}\n`))

  let buffer = ''
  let queue = Promise.resolve()
  let closed = false

  function write(response) {
    if (response !== null) output.write(`${JSON.stringify(response)}\n`)
  }

  async function handleLine(line) {
    const text = line.trim()
    if (text === '') return
    let request
    try {
      request = JSON.parse(text)
    } catch {
      write(failure(null, -32700, 'Parse error'))
      return
    }
    write(await handleRequest(request, handlers))
  }

  function onLine(line) {
    queue = queue.then(() => handleLine(line)).catch((error) => {
      log(`mcp: failed to handle request: ${error.message}`)
    })
  }

  function onData(chunk) {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      onLine(line)
      index = buffer.indexOf('\n')
    }
  }

  function onEnd() {
    if (buffer.trim() !== '') {
      const rest = buffer
      buffer = ''
      onLine(rest)
    }
    void queue.finally(() => {
      closed = true
    })
  }

  input.setEncoding('utf8')
  input.on('data', onData)
  input.on('end', onEnd)

  return {
    /** Resolves once every queued request has produced its response. */
    async close() {
      input.off('data', onData)
      input.off('end', onEnd)
      await queue
      closed = true
    },
    get closed() {
      return closed
    },
  }
}

function isMainModule() {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  startServer()
}
