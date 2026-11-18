import { describe, expect, it } from 'vitest'

import {
  createApprovalToolHandler,
  createHandlers,
  createRestoreToolHandler,
  defaultDb,
  parseCliResult,
  requireApproval,
} from '../index.js'
import { findToolDefinition } from '../tools.js'

function fakeRun(response = { code: 0, stdout: '{"ok":true}', stderr: '' }) {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    return response
  }
  return { calls, run }
}

describe('dsh plugin handlers', () => {
  it('builds an inspect argv without shell strings', async () => {
    const { calls, run } = fakeRun()
    const result = await createHandlers(run).inspect({ dsn: 'postgres://u@h/db' })
    expect(result).toEqual({ ok: true })
    expect(calls[0]).toEqual(['inspect', '--dsn', 'postgres://u@h/db', '--format', 'json'])
  })

  it('forwards backup options', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).backup({
      dsn: 'postgres://u@h/db',
      out: '/tmp/a.dump',
      database: 'app',
      mode: 'logical',
      format: 'custom',
      db: '/tmp/control.db',
    })
    expect(calls[0]).toEqual([
      'backup',
      '--dsn',
      'postgres://u@h/db',
      '--out',
      '/tmp/a.dump',
      '--database',
      'app',
      '--mode',
      'logical',
      '--format',
      'custom',
      '--db',
      '/tmp/control.db',
    ])
  })

  it('always passes --yes for restore after approval', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).restore({
      dsn: 'postgres://u@h/db',
      input: '/tmp/a.dump',
      database: 'app_restored',
      createDatabase: true,
      clean: true,
    })
    expect(calls[0]).toContain('--yes')
    expect(calls[0]).toContain('--create-database')
    expect(calls[0]).toContain('--clean')
  })

  it('requires dsh approval for a plain non-clean restore', async () => {
    let approvals = 0
    const ctx = {
      get: () => ({ request: async () => { approvals += 1; return 'allowed-once' } }),
    }
    const restore = createRestoreToolHandler(ctx, async (args) => args)
    const result = await restore(
      { input: '/tmp/plain.sql', format: 'plain' },
      { agent: {}, callId: 'c', signal: new AbortController().signal },
    )
    expect(approvals).toBe(1)
    expect(result).toEqual({ input: '/tmp/plain.sql', format: 'plain' })
  })

  it('fails loudly on a non-zero exit', () => {
    expect(() => parseCliResult({ code: 1, stdout: '', stderr: 'boom' })).toThrow('boom')
  })

  it('fails closed without an agent or approval service', async () => {
    const ctx = { get: () => undefined }
    await expect(requireApproval(ctx, {}, 'pg_restore', 'x')).rejects.toThrow('发起主体')
    await expect(
      requireApproval(ctx, { agent: {} }, 'pg_restore', 'x'),
    ).rejects.toThrow('审批服务不可用')
  })

  it('rejects when approval is not granted', async () => {
    const ctx = {
      get: () => ({
        request: async () => 'rejected',
      }),
    }
    await expect(
      requireApproval(ctx, { agent: {}, callId: 'c', signal: new AbortController().signal }, 'pg_restore', 'x'),
    ).rejects.toThrow('未获批准')
  })

  it('passes when approval is allowed once', async () => {
    const ctx = {
      get: () => ({
        request: async () => 'allowed-once',
      }),
    }
    await expect(
      requireApproval(ctx, { agent: {}, callId: 'c', signal: new AbortController().signal }, 'pg_restore', 'x'),
    ).resolves.toBeUndefined()
  })

  it('builds a knowledge ask argv with the query behind the option terminator', async () => {
    const { calls, run } = fakeRun({ code: 0, stdout: '{"hits":[]}', stderr: '' })
    await createHandlers(run).kbSearch({ query: '归档失败', k: 3, db: '/tmp/kb.sqlite' })
    // The query must come after `--`, otherwise a question starting with '-'
    // would be parsed as a flag and rejected by strict parseArgs.
    expect(calls[0]).toEqual([
      'ask',
      '--json',
      '--k',
      '3',
      '--db',
      '/tmp/kb.sqlite',
      '--',
      '归档失败',
    ])
  })

  it('keeps a dash-prefixed question intact', async () => {
    const { calls, run } = fakeRun({ code: 0, stdout: '{"hits":[]}', stderr: '' })
    await createHandlers(run).kbSearch({ query: '为什么 --type=time 不生效' })
    expect(calls[0].at(-1)).toBe('为什么 --type=time 不生效')
    expect(calls[0].at(-2)).toBe('--')
  })

  it('forwards the tool cancellation signal to the backend process', async () => {
    const calls = []
    const run = async (args, env, signal) => {
      calls.push({ args, env, signal })
      return { code: 0, stdout: '{}', stderr: '' }
    }
    const controller = new AbortController()
    await createHandlers(run).report({ since: '7d' }, { signal: controller.signal })
    expect(calls[0].signal).toBe(controller.signal)
  })
})

describe('tool result parsing', () => {
  it('keeps the diagnosis of a failed step run and attaches the exit code', async () => {
    const { run } = fakeRun({
      code: 1,
      stdout: '{"goalId":"g1","state":"running","executed":[],"hint":"remediate","diagnosis":{"signature":"schema:database-missing"}}',
      stderr: 'bkagent: goal run stopped',
    })
    const result = await createHandlers(run).stepRun({ goal: 'g1' })
    // The diagnosis is the only actionable part; an exception would hide it.
    expect(result.hint).toBe('remediate')
    expect(result.diagnosis.signature).toBe('schema:database-missing')
    expect(result.exitCode).toBe(1)
  })

  it('keeps a refusal payload from remediate', async () => {
    const { run } = fakeRun({
      code: 4,
      stdout: '{"refused":"replan is not an available remediation (available: escalate)"}',
      stderr: '',
    })
    const result = await createHandlers(run).remediate({ step: 's1', kind: 'replan', action: {} })
    expect(result.refused).toContain('escalate')
    expect(result.exitCode).toBe(4)
  })

  it('stays strict for tools that do not opt into tolerating failure', async () => {
    const { run } = fakeRun({ code: 3, stdout: '', stderr: 'connect:connection-refused' })
    await expect(createHandlers(run).inspect({ dsn: 'postgres://u@h/db' })).rejects.toThrow(
      'connect:connection-refused',
    )
  })

  it('throws for a tolerated tool when the payload is not JSON', async () => {
    const { run } = fakeRun({ code: 1, stdout: 'not json', stderr: 'kaboom' })
    await expect(createHandlers(run).stepRun({ goal: 'g1' })).rejects.toThrow('kaboom')
  })
})

describe('pg_pitr argv', () => {
  const base = {
    dsn: 'postgres://u@h/db',
    dataDir: '/srv/pgdata',
    port: '55432',
    log: '/tmp/recovery.log',
    restoreCommand: 'cp /archive/%f %p',
  }

  it('builds the documented argv order for an LSN target', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).pitr({
      ...base,
      targetLsn: '0/5000000',
      action: 'promote',
      verifySql: 'select 1',
      stateDir: '/tmp/pitr-state',
      resume: true,
      db: '/tmp/control.db',
    })
    expect(calls[0]).toEqual([
      'pitr',
      '--dsn',
      'postgres://u@h/db',
      '--data-dir',
      '/srv/pgdata',
      '--port',
      '55432',
      '--log',
      '/tmp/recovery.log',
      '--restore-command',
      'cp /archive/%f %p',
      '--target-lsn',
      '0/5000000',
      '--action',
      'promote',
      '--verify-sql',
      'select 1',
      '--state-dir',
      '/tmp/pitr-state',
      '--resume',
      '--yes',
      '--db',
      '/tmp/control.db',
    ])
  })

  it('always passes --yes and the default control db', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).pitr({ ...base, targetTime: '2026-11-12 03:00:00+00' })
    expect(calls[0]).toContain('--yes')
    expect(calls[0].at(-3)).toBe('--yes')
    expect(calls[0].at(-2)).toBe('--db')
    expect(calls[0].at(-1)).toBe(defaultDb())
    expect(calls[0]).toContain('--target-time')
  })

  it('rejects zero or several targets before spawning the CLI', async () => {
    const { calls, run } = fakeRun()
    await expect(createHandlers(run).pitr({ ...base })).rejects.toThrow('exactly one')
    await expect(
      createHandlers(run).pitr({
        ...base,
        targetTime: '2026-11-12 03:00:00+00',
        targetXid: '1234',
      }),
    ).rejects.toThrow('exactly one')
    expect(calls).toEqual([])
  })

  it('routes pitr through the approval seam in the dsh entry point', async () => {
    let approvals = 0
    const ctx = {
      get: () => ({
        request: async ({ toolName, reason }) => {
          approvals += 1
          expect(toolName).toBe('pg_pitr')
          expect(reason).toBeDefined()
          return 'allowed-once'
        },
      }),
    }
    const definition = findToolDefinition('pg_pitr')
    const handler = createApprovalToolHandler(ctx, definition, async () => ({ ok: true }))
    await expect(
      handler(
        { ...base, targetLsn: '0/5000000' },
        { agent: {}, callId: 'c', signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ ok: true })
    expect(approvals).toBe(1)
  })
})

describe('goal and memory argv', () => {
  const STEPS = [
    {
      intent: '检查实例',
      action: { command: 'inspect', args: ['--dsn', 'postgres://u@h/db'] },
    },
    {
      intent: '恢复到新库',
      action: {
        command: 'restore',
        args: ['--dsn', 'postgres://u@h/db', '--input', '/tmp/a.dump'],
      },
      dependsOn: [1],
    },
  ]
  const CONSTRAINTS = { maxSteps: 5, maxStepAttempts: 2, allowDestructive: false }

  it('builds goal add argv for op open with a decomposition and constraints', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).goal({
      op: 'open',
      target: 'prod-app',
      intent: '把 app 恢复到新库并比对行数',
      steps: STEPS,
      constraints: CONSTRAINTS,
      principal: 'ops',
      db: '/tmp/control.db',
    })
    expect(calls[0]).toEqual([
      'goal',
      'add',
      '--target',
      'prod-app',
      '--intent',
      '把 app 恢复到新库并比对行数',
      '--steps-json',
      JSON.stringify(STEPS),
      '--constraints-json',
      JSON.stringify(CONSTRAINTS),
      '--principal',
      'ops',
      '--db',
      '/tmp/control.db',
    ])
  })

  it('omits the optional open flags and uses the default control db', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).goal({ op: 'open', target: 'prod-app', intent: '巡检' })
    expect(calls[0]).toEqual([
      'goal',
      'add',
      '--target',
      'prod-app',
      '--intent',
      '巡检',
      '--db',
      defaultDb(),
    ])
  })

  it('builds goal plan argv with the serialised steps', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).goal({
      op: 'plan',
      goal: 'g1',
      steps: STEPS,
      db: '/tmp/control.db',
    })
    expect(calls[0]).toEqual([
      'goal',
      'plan',
      '--goal',
      'g1',
      '--steps-json',
      JSON.stringify(STEPS),
      '--db',
      '/tmp/control.db',
    ])
  })

  it('maps next, status and diagnose onto their subcommands', async () => {
    const { calls, run } = fakeRun()
    const handlers = createHandlers(run)
    await handlers.goal({ op: 'next', goal: 'g1' })
    await handlers.goal({ op: 'status', goal: 'g1' })
    await handlers.goal({ op: 'diagnose', step: 's1' })
    expect(calls).toEqual([
      ['goal', 'next', '--goal', 'g1', '--db', defaultDb()],
      ['goal', 'show', '--goal', 'g1', '--db', defaultDb()],
      ['goal', 'diagnose', '--step', 's1', '--db', defaultDb()],
    ])
  })

  it('refuses an op whose required fields are missing, before spawning', async () => {
    const { calls, run } = fakeRun()
    const handlers = createHandlers(run)
    await expect(handlers.goal({ op: 'plan', goal: 'g1' })).rejects.toThrow('requires steps')
    await expect(handlers.goal({ op: 'open', target: 'prod-app' })).rejects.toThrow(
      'requires intent',
    )
    await expect(handlers.goal({ op: 'next' })).rejects.toThrow('requires goal')
    await expect(handlers.goal({ op: 'diagnose' })).rejects.toThrow('requires step')
    await expect(handlers.goal({ op: 'launch' })).rejects.toThrow('unknown op')
    expect(calls).toEqual([])
  })

  it('builds goal run argv for one step', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).stepRun({ goal: 'g1', db: '/tmp/control.db' })
    expect(calls[0]).toEqual([
      'goal',
      'run',
      '--goal',
      'g1',
      '--db',
      '/tmp/control.db',
    ])
  })

  it('builds goal remediate argv with a replan action', async () => {
    const { calls, run } = fakeRun()
    const action = { command: 'backup', args: ['--dsn', 'postgres://u@h/db', '--out', '/tmp/b'] }
    await createHandlers(run).remediate({
      step: 's1',
      kind: 'replan',
      action,
      reason: '归档路径不存在',
      db: '/tmp/control.db',
    })
    expect(calls[0]).toEqual([
      'goal',
      'remediate',
      '--step',
      's1',
      '--kind',
      'replan',
      '--action-json',
      JSON.stringify(action),
      '--reason',
      '归档路径不存在',
      '--db',
      '/tmp/control.db',
    ])
  })

  it('builds a retry without an action and the default control db', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).remediate({ step: 's1', kind: 'retry' })
    expect(calls[0]).toEqual([
      'goal',
      'remediate',
      '--step',
      's1',
      '--kind',
      'retry',
      '--db',
      defaultDb(),
    ])
  })

  it('refuses a replan without a new action, before spawning', async () => {
    const { calls, run } = fakeRun()
    await expect(createHandlers(run).remediate({ step: 's1', kind: 'replan' })).rejects.toThrow(
      'requires action',
    )
    expect(calls).toEqual([])
  })

  it('builds memory search argv with filters and a numeric limit', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).recall({
      target: 'prod-app',
      signature: 'sqlstate:42P01',
      query: '归档失败',
      limit: 5,
      db: '/tmp/control.db',
    })
    expect(calls[0]).toEqual([
      'memory',
      'search',
      '--target',
      'prod-app',
      '--signature',
      'sqlstate:42P01',
      '--query',
      '归档失败',
      '--limit',
      '5',
      '--db',
      '/tmp/control.db',
    ])
  })

  it('searches all memory when no filter is given', async () => {
    const { calls, run } = fakeRun()
    await createHandlers(run).recall({})
    expect(calls[0]).toEqual(['memory', 'search', '--db', defaultDb()])
  })
})
