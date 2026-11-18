import { describe, expect, it } from 'vitest'

import {
  ACTION_COMMANDS,
  actionArgv,
  isDestructiveAction,
  isReadOnlyAction,
  isStepAction,
  redactAction,
  validateStepAction,
  type StepAction,
} from '../../src/domain/action'

const action = (command: string, args: string[] = []): unknown => ({ command, args })

describe('validateStepAction', () => {
  it('accepts a read-only action', () => {
    expect(validateStepAction(action('inspect', ['--dsn', 'postgres://u@h/db']))).toEqual([])
  })

  it('accepts boolean flags without a value', () => {
    expect(
      validateStepAction(action('restore', ['--dsn', 'postgres://u@h/db', '--input', '/b/a.dump', '--clean'])),
    ).toEqual([])
  })

  it('rejects an unknown command', () => {
    const issues = validateStepAction(action('psql', ['-c', 'drop database x']))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.field).toBe('command')
  })

  it.each(['--yes', '--principal', '--db', '--transport', '--state-dir', '--resume'])(
    'refuses the reserved flag %s',
    (flag) => {
      const issues = validateStepAction(action('restore', ['--input', '/b/a.dump', flag, 'x']))
      expect(issues.some((issue) => issue.message.includes(`${flag} is reserved`))).toBe(true)
    },
  )

  it('refuses a flag the command does not accept', () => {
    const issues = validateStepAction(action('inspect', ['--out', '/tmp/x']))
    expect(issues.some((issue) => issue.message.includes('--out is not allowed for inspect'))).toBe(true)
  })

  it('refuses shell metacharacters anywhere in argv', () => {
    const issues = validateStepAction(action('backup', ['--out', '/tmp/x; rm -rf /']))
    expect(issues.some((issue) => issue.message.includes('shell metacharacter'))).toBe(true)
  })

  it('refuses a DSN that carries a password', () => {
    const issues = validateStepAction(action('inspect', ['--dsn', 'postgres://dba:s3cret@db1/app']))
    expect(issues).toHaveLength(1)
    expect(issues[0]?.message).toContain('must not carry a password')
  })

  it('accepts a passwordless DSN, which is how a persisted goal is resumed', () => {
    expect(validateStepAction(action('inspect', ['--dsn', 'postgres://dba@db1:5432/app']))).toEqual([])
  })

  it('refuses positional tokens', () => {
    const issues = validateStepAction(action('inspect', ['postgres://u@h/db']))
    expect(issues.some((issue) => issue.message.includes('positional'))).toBe(true)
  })

  it('refuses the --flag=value form', () => {
    const issues = validateStepAction(action('inspect', ['--dsn=postgres://u@h/db']))
    expect(issues.some((issue) => issue.message.includes('separate token'))).toBe(true)
  })

  it('refuses a duplicate single-value flag', () => {
    const issues = validateStepAction(action('inspect', ['--dsn', 'a', '--dsn', 'b']))
    expect(issues.some((issue) => issue.message.includes('only once'))).toBe(true)
  })

  it('allows a repeated --table', () => {
    expect(
      validateStepAction(action('backup', ['--out', '/tmp/x.dump', '--table', 'a', '--table', 'b'])),
    ).toEqual([])
  })

  it('requires an integer for numeric flags', () => {
    const issues = validateStepAction(action('backup', ['--out', '/tmp/x.dump', '--jobs', 'many']))
    expect(issues.some((issue) => issue.message.includes('non-negative integer'))).toBe(true)
  })

  it('enforces per-command enumerations', () => {
    const issues = validateStepAction(action('backup', ['--out', '/tmp/x.dump', '--mode', 'telepathy']))
    expect(issues.some((issue) => issue.message.includes('--mode must be one of'))).toBe(true)
  })

  it('treats --format as command-specific', () => {
    // `backup --format` is the dump format; `report --format` is the output format.
    expect(validateStepAction(action('backup', ['--out', '/tmp/x.dump', '--format', 'custom']))).toEqual([])
    expect(validateStepAction(action('report', ['--format', 'json']))).toEqual([])
    expect(validateStepAction(action('report', ['--format', 'custom']))).not.toEqual([])
  })

  it('refuses a flag that is missing its value', () => {
    const issues = validateStepAction(action('backup', ['--out']))
    expect(issues.some((issue) => issue.message.includes('--out requires a value'))).toBe(true)
  })

  it('refuses a non-string argv element', () => {
    const issues = validateStepAction({ command: 'inspect', args: ['--dsn', 42] })
    expect(issues.some((issue) => issue.message.includes('must be a string'))).toBe(true)
  })

  it('refuses an unknown flag for every declared command', () => {
    for (const command of ACTION_COMMANDS) {
      const issues = validateStepAction(action(command, ['--definitely-not-a-flag']))
      expect(issues.length).toBeGreaterThan(0)
    }
  })
})

describe('isStepAction', () => {
  it('is true only for a valid action', () => {
    expect(isStepAction(action('metrics'))).toBe(true)
    expect(isStepAction(action('metrics', ['--db', 'x']))).toBe(false)
  })
})

describe('action classification', () => {
  it('marks the destructive verbs', () => {
    expect(isDestructiveAction({ command: 'restore', args: [] })).toBe(true)
    expect(isDestructiveAction({ command: 'walg-prune', args: [] })).toBe(true)
    expect(isDestructiveAction({ command: 'backup', args: [] })).toBe(false)
  })

  it('marks the read-only verbs', () => {
    expect(isReadOnlyAction({ command: 'catalog', args: [] })).toBe(true)
    expect(isReadOnlyAction({ command: 'backup', args: [] })).toBe(false)
  })
})

describe('redactAction', () => {
  it('masks a DSN password before the action is persisted', () => {
    const redacted = redactAction({
      command: 'inspect',
      args: ['--dsn', 'postgres://dba:s3cret@db1:5432/app'],
    })
    expect(redacted.args).toEqual(['--dsn', 'postgres://dba:***@db1:5432/app'])
    expect(JSON.stringify(redacted)).not.toContain('s3cret')
  })

  it('leaves a passwordless DSN alone', () => {
    const action: StepAction = { command: 'inspect', args: ['--dsn', 'postgres://db1/app'] }
    expect(redactAction(action)).toEqual(action)
  })
})

describe('actionArgv', () => {
  const backup: StepAction = { command: 'backup', args: ['--dsn', 'postgres://u@h/db', '--out', '/tmp/x.dump'] }

  it('appends the control database last', () => {
    const argv = actionArgv(backup, { controlDb: '/db/control.db', approveDestructive: false })
    expect(argv.slice(-2)).toEqual(['--db', '/db/control.db'])
  })

  it('never adds --yes for a non-destructive action', () => {
    const argv = actionArgv(backup, { controlDb: '/db/control.db', approveDestructive: false })
    expect(argv).not.toContain('--yes')
  })

  it('refuses to build argv for an unapproved destructive action', () => {
    const restore: StepAction = { command: 'restore', args: ['--input', '/b/a.dump'] }
    expect(() => actionArgv(restore, { controlDb: '/db/control.db', approveDestructive: false })).toThrow(
      /without approval/,
    )
  })

  it('adds --yes for an approved destructive action', () => {
    const restore: StepAction = { command: 'restore', args: ['--input', '/b/a.dump'] }
    const argv = actionArgv(restore, { controlDb: '/db/control.db', approveDestructive: true })
    expect(argv).toContain('--yes')
    expect(argv.indexOf('--yes')).toBeLessThan(argv.indexOf('--db'))
  })

  it('requests JSON output for JSON-capable commands without overriding the caller', () => {
    expect(actionArgv(backup, { controlDb: '/db', approveDestructive: false, jsonOutput: true })).not.toContain(
      '--format',
    )
    const inspect: StepAction = { command: 'inspect', args: ['--dsn', 'postgres://u@h/db'] }
    expect(actionArgv(inspect, { controlDb: '/db', approveDestructive: false, jsonOutput: true })).toContain('json')
  })
})
