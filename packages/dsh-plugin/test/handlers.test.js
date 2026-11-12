import { describe, expect, it } from 'vitest'

import {
  createHandlers,
  createRestoreToolHandler,
  parseCliResult,
  requireApproval,
} from '../index.js'

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

  it('builds a knowledge ask argv', async () => {
    const { calls, run } = fakeRun({ code: 0, stdout: '{"hits":[]}', stderr: '' })
    await createHandlers(run).kbSearch({ query: '归档失败', k: 3, db: '/tmp/kb.sqlite' })
    expect(calls[0]).toEqual([
      'ask',
      '归档失败',
      '--json',
      '--k',
      '3',
      '--db',
      '/tmp/kb.sqlite',
    ])
  })
})
