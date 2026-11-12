import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { TOOL_DEFINITIONS } from '../tools.js'

const MCP_PATH = fileURLToPath(new URL('../mcp.js', import.meta.url))
const CONTROL_DB = '/tmp/bkagent-mcp-control.db'

let directory
let callsPath
let child
let client
let lines

function writeStub() {
  const stubPath = join(directory, 'stub.mjs')
  writeFileSync(
    stubPath,
    [
      "import { appendFileSync } from 'node:fs'",
      `appendFileSync(${JSON.stringify(callsPath)}, process.argv.slice(2).join(' ') + '\\n')`,
      'process.stdout.write(JSON.stringify({ ok: true, argv: process.argv.slice(2) }) + "\\n")',
      '',
    ].join('\n'),
  )
  return stubPath
}

function startClient() {
  const pending = new Map()
  const readline = createInterface({ input: child.stdout })
  readline.on('line', (line) => {
    lines.push(line)
    const message = JSON.parse(line)
    const slot = pending.get(message.id)
    if (slot !== undefined) {
      pending.delete(message.id)
      slot.resolve(message)
    }
  })

  let nextId = 1
  return {
    request(method, params) {
      const id = nextId
      nextId += 1
      const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(`${JSON.stringify(message)}\n`)
      })
    },
    close() {
      for (const slot of pending.values()) slot.reject(new Error('mcp child closed'))
      pending.clear()
      readline.close()
    },
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'bkagent-mcp-'))
  callsPath = join(directory, 'calls.log')
  const stubPath = writeStub()
  lines = []
  child = spawn(process.execPath, [MCP_PATH], {
    env: {
      ...process.env,
      BKAGENT_CLI: stubPath,
      BKAGENT_KNOWLEDGE_CLI: stubPath,
      BKAGENT_DB: CONTROL_DB,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.setEncoding('utf8')
  client = startClient()
})

afterEach(async () => {
  client.close()
  child.stdin.end()
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('close', resolve))
  }
  rmSync(directory, { recursive: true, force: true })
})

function readCalls() {
  return existsSync(callsPath) ? readFileSync(callsPath, 'utf8') : ''
}

describe('mcp stdio server', () => {
  it('answers initialize with the protocol version and server info', async () => {
    const response = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.0.0' },
    })
    expect(response.error).toBeUndefined()
    expect(response.result.protocolVersion).toBe('2024-11-05')
    expect(response.result.capabilities).toEqual({ tools: {} })
    expect(response.result.serverInfo).toEqual({ name: 'backup-agent', version: '0.1.0' })
  })

  it('lists the eight shared tools with JSON Schema input', async () => {
    const response = await client.request('tools/list')
    const { tools } = response.result
    expect(tools.map((tool) => tool.name)).toEqual([
      'pg_inspect',
      'pg_backup',
      'pg_restore',
      'pg_verify',
      'pg_catalog',
      'pg_report',
      'kb_search',
      'pg_pitr',
    ])
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length)
    for (const tool of tools) {
      expect(typeof tool.description).toBe('string')
      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
      expect(Array.isArray(tool.inputSchema.required)).toBe(true)
    }
  })

  it('runs a read-only tool through the shared handlers and returns CLI JSON', async () => {
    const response = await client.request('tools/call', {
      name: 'pg_report',
      arguments: { since: '7d' },
    })
    expect(response.error).toBeUndefined()
    const text = response.result.content[0].text
    const value = JSON.parse(text)
    expect(value).toEqual({
      ok: true,
      argv: ['report', '--db', CONTROL_DB, '--format', 'json', '--since', '7d'],
    })
    expect(value.ok).toBe(true)
    expect(readCalls().trim()).toBe(value.argv.join(' '))
  })

  it('fails closed on a destructive tool without invoking the CLI', async () => {
    const response = await client.request('tools/call', {
      name: 'pg_restore',
      arguments: { dsn: 'postgres://u@h/db', input: '/tmp/a.dump' },
    })
    expect(response.error).toBeUndefined()
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('approval seam')
    expect(readCalls()).toBe('')
  })

  it('rejects an unknown method with -32601', async () => {
    const response = await client.request('resources/list')
    expect(response.result).toBeUndefined()
    expect(response.error.code).toBe(-32601)
  })

  it('rejects an unknown tool with -32602', async () => {
    const response = await client.request('tools/call', {
      name: 'pg_teleport',
      arguments: {},
    })
    expect(response.error.code).toBe(-32602)
    expect(readCalls()).toBe('')
  })

  it('answers ping and keeps stdout protocol-only', async () => {
    const response = await client.request('ping')
    expect(response.result).toEqual({})
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})
