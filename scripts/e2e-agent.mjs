#!/usr/bin/env node
/**
 * E-09 real-model E2E regression.
 *
 * Drives one dsh web session on the `pg-dba` preset through the web API:
 *   session/create -> session/prompt -> inspect session log -> assert
 *
 * Requires:
 *   BK_E2E=1, dsh on PATH, zstd on PATH, a reachable PostgreSQL.
 * Temporarily patches the web profile's default preset to pg-dba and restores
 * it in finally; the user's settings file is not touched.
 */
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = 'web'
const PATCH = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
const PRESET = join(DSH_HOME, '.agent-presets', 'pg-dba')

const DSN = process.env.BK_E2E_DSN ?? 'postgres://postgres:verify_pw@127.0.0.1:55416/postgres'
const DATABASE = process.env.BK_E2E_DATABASE ?? 'bk_ops_src'
const OUTPUT = process.env.BK_E2E_OUT ?? '/tmp/bkagent-e2e.dump'
const CONTROL_DB = process.env.BK_E2E_CONTROL_DB ?? '/tmp/bkagent-e2e-control.db'
const PORT = Number(process.env.BK_E2E_PORT ?? 8899)
const TIMEOUT_MS = Number(process.env.BK_E2E_TIMEOUT_MS ?? 300_000)

if (process.env.BK_E2E !== '1') {
  console.error('E-09 is opt-in: set BK_E2E=1 (and a reachable PostgreSQL)')
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(message) {
  console.error(`[e2e] ${message}`)
}

function ensureBundle() {
  const cli = join(REPO, 'dist', 'bkagent.mjs')
  if (!existsSync(cli)) {
    log('building CLI bundle')
    execFileSync('pnpm', ['build:cli'], { cwd: REPO, stdio: 'inherit' })
  }
  return cli
}

function ensurePreset() {
  rmSync(PRESET, { recursive: true, force: true })
  mkdirSync(dirname(PRESET), { recursive: true })
  execFileSync('cp', ['-R', join(REPO, 'presets', 'pg-dba'), PRESET], { stdio: 'inherit' })
}

function ensurePluginLinked() {
  const manifest = JSON.parse(readFileSync(join(DSH_HOME, 'profiles', PROFILE, 'package.json'), 'utf8'))
  const deps = manifest.dependencies ?? {}
  if (deps['@backup-agent/dsh-plugin'] === undefined) {
    log('linking @backup-agent/dsh-plugin into the web profile')
    execFileSync('dsh', ['plugin', `--profile`, PROFILE, 'add', `link:${join(REPO, 'packages', 'dsh-plugin')}`], {
      stdio: 'inherit',
    })
  }
}

async function waitForToken(child, timeoutMs = 60_000) {
  let output = ''
  const match = () =>
    output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = match()
    if (found) return { base: `http://127.0.0.1:${found[1]}`, token: found[2] }
    await sleep(200)
  }
  throw new Error(`dsh web did not print a token URL:\n${output.slice(-2000)}`)
}

async function createSession(base, cookie) {
  const response = await fetch(`${base}/api/session/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'create',
      method: 'session/create',
      payload: { args: { request: { cwd: REPO } } },
    }),
  })
  const body = await response.json()
  if (!body.result?.ok) throw new Error(`session/create failed: ${JSON.stringify(body)}`)
  return body.result.value
}

async function promptSession(base, cookie, sessionId, text) {
  const response = await fetch(`${base}/api/session/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'prompt',
      method: 'session/prompt',
      payload: {
        args: {
          request: {
            requestId: `e2e-${Date.now()}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: 'Asia/Shanghai',
          },
        },
      },
    }),
  })
  const body = await response.json()
  if (!body.result?.ok) throw new Error(`session/prompt failed: ${JSON.stringify(body)}`)
}

function findSessionLog(sessionId) {
  const roots = join(DSH_HOME, 'sessions')
  const found = execFileSync('find', [roots, '-type', 'd', '-name', `*${sessionId}*`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  for (const dir of found) {
    const file = join(dir, 'session.jsonl.zstd')
    if (existsSync(file)) return file
  }
  return null
}

function readSessionJsonl(file) {
  const text = execFileSync('zstd', ['-d', '-c', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function toolResultText(event) {
  let text = ''
  for (const part of event.data.message.content ?? []) {
    for (const block of part.content ?? []) {
      if (block.type === 'text') text += block.text
    }
  }
  return text
}

async function waitForCompletion(sessionId) {
  const deadline = Date.now() + TIMEOUT_MS
  let lastSize = -1
  let stable = 0
  while (Date.now() < deadline) {
    const file = findSessionLog(sessionId)
    if (file !== null) {
      const size = statSync(file).size
      const events = readSessionJsonl(file)
      const calls = events.filter((e) => e.type === 'tool/call').map((e) => e.data.name)
      const results = events.filter((e) => e.type === 'tool/result')
      const final = events
        .filter((e) => e.type === 'assistant/message')
        .map((e) => (e.data.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''))
        .filter(Boolean)
        .at(-1)
      if (size === lastSize) stable += 1
      else stable = 0
      if (calls.includes('pg_verify') && results.length > 0 && final && stable >= 2) {
        return { file, events, calls, results, final }
      }
      lastSize = size
    }
    await sleep(2_000)
  }
  throw new Error(`session did not finish within ${TIMEOUT_MS} ms`)
}

async function main() {
  ensureBundle()
  ensurePreset()
  ensurePluginLinked()

  const patchBackup = `${PATCH}.e2e-backup`
  copyFileSync(PATCH, patchBackup)
  writeFileSync(
    PATCH,
    `- id: agent-presets\n  config:\n    default: pg-dba\n`,
    'utf8',
  )

  let child
  try {
    child = spawn('dsh', ['web', '--no-open', '--port', String(PORT)], {
      cwd: REPO,
      env: { ...process.env, BKAGENT_DB: CONTROL_DB },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const { base, token } = await waitForToken(child)
    const root = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
    const cookies = root.headers.getSetCookie?.() ?? []
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ')
    if (!cookie) throw new Error('dsh web did not issue a session cookie')

    const created = await createSession(base, cookie)
    log(`session ${created.sessionId} on preset ${created.agentPreset}`)
    if (created.agentPreset !== 'pg-dba') {
      throw new Error(`expected preset pg-dba, got ${created.agentPreset}`)
    }

    const prompt = [
      '请依次调用 pg_inspect、pg_backup、pg_verify：',
      `检查 ${DSN} 的实例状态；`,
      `将数据库 ${DATABASE} 备份为 custom 格式到 ${OUTPUT}，db 参数使用 ${CONTROL_DB}；`,
      '然后校验该备份。完成后用中文报告每个工具的返回状态。',
    ].join('')
    await promptSession(base, cookie, created.sessionId, prompt)

    const { calls, results, final, file } = await waitForCompletion(created.sessionId)
    const required = ['pg_inspect', 'pg_backup', 'pg_verify']
    for (const name of required) {
      if (!calls.includes(name)) throw new Error(`missing tool call: ${name}`)
    }

    const verifyResult = results
      .map((event) => ({ callId: event.data.message.source?.callId, text: toolResultText(event) }))
      .filter((entry) => entry.text.includes('"scratchDatabase"'))
      .at(-1)
    if (verifyResult === undefined) throw new Error('pg_verify produced no verification report')
    const report = JSON.parse(verifyResult.text)
    if (report.ok !== true) throw new Error(`pg_verify ok=false: ${verifyResult.text.slice(0, 400)}`)

    const size = statSync(OUTPUT).size
    if (size <= 0) throw new Error(`artifact is empty: ${OUTPUT}`)

    const failures = results.filter((event) => event.data.message.isError === true)
    if (failures.length > 0) throw new Error(`${failures.length} tool result(s) reported isError`)

    console.log(
      JSON.stringify(
        {
          ok: true,
          sessionId: created.sessionId,
          preset: created.agentPreset,
          tools: calls,
          artifact: { path: OUTPUT, bytes: size },
          verify: report,
          final: final.slice(0, 800),
          sessionLog: file,
        },
        null,
        2,
      ),
    )
  } finally {
    if (child !== undefined) {
      child.kill('SIGTERM')
    }
    copyFileSync(patchBackup, PATCH)
    rmSync(patchBackup, { force: true })
  }
}

main().catch((error) => {
  console.error(`[e2e] FAILED: ${error.message}`)
  process.exit(1)
})
