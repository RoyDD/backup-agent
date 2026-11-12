import { execFileSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  posixCommand,
  posixQuote,
  RemoteExecutorError,
} from '../../src/executor/posix-quote'

/**
 * The property under test is byte-identical round-tripping through a real
 * `/bin/sh`: whatever the control plane encodes must arrive at the remote
 * program as exactly one argument with exactly the same bytes.
 */
const ROUND_TRIP_CASES: readonly string[] = [
  'a; echo pwned',
  '$(id)',
  '`id`',
  '${HOME}',
  'it\'s',
  '*',
  '?',
  '~',
  'a|b',
  'a&&b',
  'a > /tmp/x',
  '--type=time',
  '',
  ' leading and trailing ',
  'two words',
  'line1\nline2',
  'tab\there',
  "'; rm -rf /; echo '",
  '"double"',
  '\\backslash\\',
  'plain-value_1@host:5432/db.name',
]

describe('posixQuote', () => {
  it.each(ROUND_TRIP_CASES)('round-trips %j through sh -c', (arg) => {
    const command = posixCommand(['printf', '%s', arg])
    const output = execFileSync('sh', ['-c', command], { encoding: 'utf8' })
    expect(output).toBe(arg)
  })

  it.each(ROUND_TRIP_CASES)('leaves no unquoted metacharacter for %j', (arg) => {
    const quoted = posixQuote(arg)
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
      expect(quoted).toBe(arg)
      return
    }
    // Anything unsafe must be wrapped in single quotes, with `'` encoded.
    expect(quoted.startsWith("'")).toBe(true)
    expect(quoted.endsWith("'")).toBe(true)
    expect(quoted).not.toBe(arg)
  })

  it('quotes an empty argument as a single empty string', () => {
    expect(posixQuote('')).toBe("''")
  })

  it('encodes an embedded single quote as the canonical sequence', () => {
    expect(posixQuote("it's")).toBe("'it'\\''s'")
    expect(execFileSync('sh', ['-c', posixCommand(['printf', '%s', "it's"])], {
      encoding: 'utf8',
    })).toBe("it's")
  })

  it('joins argv with spaces, one element per argument', () => {
    expect(posixCommand(['pgbackrest', '--stanza=main', 'backup'])).toBe(
      'pgbackrest --stanza=main backup',
    )
    expect(posixCommand(['sh', '-c', 'echo hi'])).toBe("sh -c 'echo hi'")
  })

  it('rejects a NUL byte with a typed INVALID_ARGV error', () => {
    let caught: unknown
    try {
      posixQuote('a\0b')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(RemoteExecutorError)
    expect((caught as RemoteExecutorError).code).toBe('INVALID_ARGV')

    expect(() => posixCommand(['printf', '%s', 'a\0b'])).toThrow(RemoteExecutorError)
    expect(() => posixCommand([])).toThrow(/must not be empty/)
  })
})
