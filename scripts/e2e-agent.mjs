#!/usr/bin/env node
/**
 * E-09 real-model end-to-end: the goal loop under `dsh headless --json`.
 *
 * What this proves:
 *   a real model, through the real tool surface (`@backup-agent/dsh-plugin`
 *   spawning `dist/bkagent.mjs`), opens a goal, drives `bk_step_run` until the
 *   loop reports `hint: done`, and leaves a real backup artifact behind.
 *   The assertions are on the structured `tool_call` / `tool_result` events,
 *   not on the model's prose.
 *
 * What this does not prove:
 *   the `pg-dba` preset path. `dsh headless` composes `dsh-base` + `dsh-headless`
 *   and has no agent-preset registry, so the loop instructions travel in the
 *   task prompt here instead of in the preset. The preset roster is still only
 *   exercised by a web session (see `docs/dsh-integration.md`).
 *
 * Isolation: a throwaway `DSH_HOME` is built from a copy of the user's
 * `headless` profile, and the plugin is inserted through a `--patch` overlay
 * written inside it. The user's own profile is never opened for writing — the
 * earlier web-based script had to overwrite `profiles/web/cordis.patch.yml`
 * and restore it in `finally`.
 *
 * Requires: BK_E2E=1, `dsh` on PATH, a reachable PostgreSQL, and whatever
 * credentials the profile's model provider reads from the environment.
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_HOME = process.env.BK_E2E_DSH_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = 'headless'

const DSN = process.env.BK_E2E_DSN ?? 'postgres://postgres:verify_pw@127.0.0.1:55416/postgres'
const DATABASE = process.env.BK_E2E_DATABASE ?? 'postgres'
const OUTPUT = process.env.BK_E2E_OUT ?? '/tmp/bkagent-e2e.dump'
const CONTROL_DB = process.env.BK_E2E_CONTROL_DB ?? '/tmp/bkagent-e2e-control.db'
const TIMEOUT_MS = Number(process.env.BK_E2E_TIMEOUT_MS ?? 600_000)
const KEEP_HOME = process.env.BK_E2E_KEEP_HOME === '1'

if (process.env.BK_E2E !== '1') {
  console.error('E-09 is opt-in: set BK_E2E=1 (and a reachable PostgreSQL)')
  process.exit(2)
}

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

/**
 * Copies the shipped `headless` profile into a temporary home and inserts the
 * plugin with an overlay patch. `insert` is required: a bare `{id, name}` entry
 * means "override an existing entry" and dsh rejects it when the id is new.
 */
/**
 * Reads the provider keys out of the source credential store.
 *
 * Copying `.credentials.yaml` into the temporary home is not enough: the file
 * is served by `@deepseek-ai/dsh-credentials-local` under its own ownership and
 * locking rules, and a copied document was not picked up. The launch
 * environment is the second precedence layer, so exporting the same refs works
 * and is what dsh itself points an operator at when a key is missing.
 *
 * Opt-in: these are secrets. `refs` is a flat `NAME: value` mapping; anything
 * else in the document (`version`, `records`) is ignored.
 */
function launchSecrets() {
  if (process.env.BK_E2E_SHARE_CREDENTIALS !== '1') return {}
  const file = join(SOURCE_HOME, '.credentials.yaml')
  if (!existsSync(file)) {
    log(`no credential store at ${file}; expecting keys in the environment`)
    return {}
  }
  const secrets = {}
  let inRefs = false
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (/^\S/.test(line)) {
      inRefs = false
      continue
    }
    if (!inRefs) continue
    const match = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(.+)$/.exec(line)
    if (match !== null) secrets[match[1]] = match[2].trim()
  }
  log(`exported ${Object.keys(secrets).length} launch credential(s) to the child`)
  return secrets
}

function prepareHome() {
  const home = mkdtempSync(join(tmpdir(), 'bkagent-e2e-dsh-'))
  const profile = join(home, 'profiles', PROFILE)
  mkdirSync(dirname(profile), { recursive: true })
  execFileSync('cp', ['-R', join(SOURCE_HOME, 'profiles', PROFILE), profile], { stdio: 'inherit' })

  /**
   * The copied profile carries whatever `node_modules/@backup-agent/dsh-plugin`
   * link the source profile had. A relative link points outside the copy and
   * breaks silently at import time ("1 entry did not activate") — the plugin
   * never registers, and the model quietly falls back to bash. Replace it with
   * an absolute link to this checkout and let the preflight prove it resolves.
   */
  const link = join(profile, 'node_modules', '@backup-agent', 'dsh-plugin')
  mkdirSync(dirname(link), { recursive: true })
  try {
    // `unlink` targets the link itself; `rm --recursive` on a symlink is
    // ambiguous across platforms and left the old link in place here.
    unlinkSync(link)
  } catch {
    // Nothing linked yet.
  }
  symlinkSync(join(REPO, 'packages', 'dsh-plugin'), link, 'dir')

  const overlay = join(home, 'e2e-overlay.yml')
  writeFileSync(
    overlay,
    [
      '# Inserted by scripts/e2e-agent.mjs; lives only in the temporary DSH_HOME.',
      '- insert:',
      '    - id: backup-agent-tools',
      "      name: '@backup-agent/dsh-plugin'",
      '',
    ].join('\n'),
    'utf8',
  )
  return { home, overlay }
}

/** Composition check that needs no model, no network and no credentials. */
function preflight(home, overlay) {
  const dump = execFileSync(
    'dsh',
    ['--profile', PROFILE, '--patch', overlay, '--dump-config'],
    { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } },
  )
  if (!dump.includes("name: '@backup-agent/dsh-plugin'")) {
    throw new Error('preflight: the overlay did not compose @backup-agent/dsh-plugin')
  }
  // Composing is not loading: resolve the package the way dsh will, so a broken
  // link fails here instead of turning into a silent fallback to bash tools.
  const profileRoot = join(home, 'profiles', PROFILE)
  const require = createRequire(join(profileRoot, 'package.json'))
  require.resolve('@backup-agent/dsh-plugin')
  log('preflight: profile composes and the plugin resolves')
}

function buildPrompt() {
  return [
    '用目标闭环完成下面的任务，不要只调用单条命令：',
    `1) 用 bk_goal op=open 建立目标，target 用 pg16-live，intent 写「检查实例后备份 ${DATABASE}」，`,
    `   拆解为两步：第一步 action {"command":"inspect","args":[]}，`,
    `   第二步依赖第一步，action {"command":"backup","args":["--database","${DATABASE}","--out","${OUTPUT}","--format","custom"]}。`,
    `2) 用 bk_step_run 推进目标，db 用 ${CONTROL_DB}，直到返回的 hint 为 done。`,
    '3) 如果某一步失败，用 bk_goal op=diagnose 读取诊断，只在候选集内用 bk_remediate 处置。',
    '4) 不要执行任何 restore、pitr 或其它破坏性动作。',
    '完成后用中文报告目标 id、每个步骤的状态与最终的 hint。',
  ].join('\n')
}

function runTask(home, overlay, prompt, cliPath, secrets) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      'dsh',
      ['--profile', PROFILE, '--patch', overlay, '--json', '--approval-policy', 'never', prompt],
      {
        cwd: REPO,
        env: {
          ...process.env,
          ...secrets,
          DSH_HOME: home,
          BKAGENT_DB: CONTROL_DB,
          BKAGENT_DSN: DSN,
          BKAGENT_CLI: cliPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    const events = []
    let stdout = ''
    let stderr = ''
    let overflow = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      let index = stdout.indexOf('\n')
      while (index >= 0) {
        const line = stdout.slice(0, index).trim()
        stdout = stdout.slice(index + 1)
        if (line !== '') {
          try {
            events.push(JSON.parse(line))
          } catch {
            overflow += `${line}\n`
          }
        }
        index = stdout.indexOf('\n')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 8192) stderr = stderr.slice(-8192)
    })
    child.on('error', rejectPromise)

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      rejectPromise(new Error(`run did not finish within ${TIMEOUT_MS} ms`))
    }, TIMEOUT_MS)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 && events.length === 0) {
        rejectPromise(new Error(`dsh exited ${code} with no events:\n${stderr.slice(-2000)}`))
        return
      }
      resolvePromise({ code, events, stderr, overflow })
    })
  })
}

/** Every `tool_result` whose payload is the JSON envelope of a goal command. */
function goalResults(events) {
  const results = []
  for (const event of events) {
    if (event.type !== 'tool_result' || typeof event.result !== 'string') continue
    try {
      const value = JSON.parse(event.result)
      if (value !== null && typeof value === 'object' && 'goalId' in value) {
        results.push({ callId: event.callId, status: event.status, value })
      }
    } catch {
      // Not every tool result is JSON; only goal run / remediate carry a hint.
    }
  }
  return results
}

function assertTrajectory(events) {
  const calls = events.filter((event) => event.type === 'tool_call')
  const tools = calls.map((event) => event.tool)

  const opened = calls.find(
    (event) => event.tool === 'bk_goal' && (event.input?.op === 'open' || event.input?.op === undefined),
  )
  if (opened === undefined) throw new Error(`missing bk_goal call; tools called: ${tools.join(', ')}`)

  const stepRun = calls.filter((event) => event.tool === 'bk_step_run')
  if (stepRun.length === 0) {
    throw new Error(`missing bk_step_run call; tools called: ${tools.join(', ')}`)
  }

  // A destructive tool must never appear: approval is unavailable by design in
  // this run (`--approval-policy never`), and the prompt excludes restores.
  const destructive = calls.filter((event) =>
    ['pg_restore', 'pg_pitr', 'pgbackrest_restore', 'walg_restore'].includes(event.tool),
  )
  if (destructive.length > 0) {
    throw new Error(`destructive tool called without approval: ${destructive.map((e) => e.tool).join(', ')}`)
  }

  const results = goalResults(events)
  const hints = results.map((result) => result.value.hint).filter((hint) => typeof hint === 'string')
  if (hints.length === 0) throw new Error('no goal result carried a hint field')
  const done = results.find((result) => result.value.hint === 'done')
  if (done === undefined) {
    throw new Error(`the loop never reported hint=done; observed: ${JSON.stringify(hints)}`)
  }
  if (done.value.state !== 'succeeded') {
    throw new Error(`hint=done with state ${String(done.value.state)}: ${JSON.stringify(done.value).slice(0, 600)}`)
  }
  const executed = Array.isArray(done.value.executed) ? done.value.executed : []
  if (executed.length < 2) {
    throw new Error(`expected two executed steps, got ${executed.length}`)
  }
  if (executed.some((entry) => entry.state !== 'succeeded')) {
    throw new Error(`an executed step did not succeed: ${JSON.stringify(executed)}`)
  }

  const errors = events.filter(
    (event) => event.type === 'tool_result' && event.status === 'error',
  )
  if (errors.length > 0) {
    throw new Error(`${errors.length} tool result(s) reported error: ${errors[0]?.result?.slice(0, 400)}`)
  }

  const final = events.filter((event) => event.type === 'final').at(-1)
  if (final === undefined || typeof final.text !== 'string' || final.text.trim() === '') {
    throw new Error('the run produced no final answer')
  }

  const session = events.find((event) => event.type === 'session')
  return {
    sessionId: session?.sessionId ?? null,
    tools,
    hints,
    goalId: done.value.goalId,
    executed,
    final: final.text.slice(0, 800),
  }
}

async function main() {
  const cliPath = ensureBundle()
  const { home, overlay } = prepareHome()
  const secrets = launchSecrets()
  log(`temporary DSH_HOME ${home}`)

  try {
    preflight(home, overlay)
    const { code, events, stderr, overflow } = await runTask(
      home,
      overlay,
      buildPrompt(),
      cliPath,
      secrets,
    )
    if (overflow !== '') log(`non-JSON stdout lines: ${overflow.split('\n').filter(Boolean).length}`)
    // A boot failure (missing credential, unresolvable plugin) exits before any
    // tool runs; surface that reason instead of an empty-trajectory assertion.
    if (code !== 0 && !events.some((event) => event.type === 'tool_call')) {
      throw new Error(`dsh exited ${code} before calling any tool:\n${stderr.slice(-1200)}`)
    }
    if (code !== 0) log(`dsh exited ${code}; stderr tail: ${stderr.slice(-800)}`)

    const summary = assertTrajectory(events)
    const size = existsSync(OUTPUT) ? statSync(OUTPUT).size : 0
    if (size <= 0) throw new Error(`artifact is empty: ${OUTPUT}`)

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: 'dsh headless --json',
          sessionId: summary.sessionId,
          goalId: summary.goalId,
          tools: summary.tools,
          hints: summary.hints,
          executed: summary.executed,
          artifact: { path: OUTPUT, bytes: size },
          final: summary.final,
          dshHome: home,
        },
        null,
        2,
      ),
    )
  } finally {
    if (KEEP_HOME) log(`kept temporary DSH_HOME ${home}`)
    else rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[e2e] FAILED: ${error.message}`)
  process.exit(1)
})
