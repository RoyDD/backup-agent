import { describe, expect, it } from 'vitest'

import {
  classifyRunResult,
  classifyStepFailure,
  extractSqlState,
  failureSignature,
} from '../../src/executor/classify'

const failure = (stderr: string, exitCode = 1): Parameters<typeof classifyRunResult>[0] => ({
  timedOut: false,
  signal: null,
  exitCode,
  stderr,
})

describe('extractSqlState', () => {
  it('reads a labelled SQLSTATE', () => {
    expect(extractSqlState('ERROR: relation "x" does not exist SQL state: 42P01')).toBe('42P01')
    expect(extractSqlState('no state here')).toBeNull()
  })
})

describe('classifyRunResult — catalog signatures', () => {
  const cases: ReadonlyArray<[string, string, 'transient' | 'permanent' | 'manual']> = [
    ['PITR target missed', 'ERROR:  invalid input syntax for type integer: "pitr target not reached: recovery ended before the configured target"', 'manual'],
    ['E-01 wrong password', 'FATAL:  password authentication failed for user "postgres"', 'manual'],
    ['E-04 pg_hba', 'FATAL: no pg_hba.conf entry for host "10.0.0.1"', 'manual'],
    ['E-07 disk full', 'pg_dump: error: could not write to output file: No space left on device', 'manual'],
    ['E-08 too many files', 'could not open file: Too many open files', 'transient'],
    ['E-09 too many clients', 'FATAL: sorry, too many clients already', 'transient'],
    ['S-02 table denied', 'ERROR: permission denied for table secret_t', 'manual'],
    ['S-03 lock timeout', 'ERROR: canceling statement due to statement timeout', 'transient'],
    ['S-10 connect reset', 'server closed the connection unexpectedly: connection reset by peer', 'transient'],
    ['R-01 version mismatch', 'pg_restore: error: unsupported version (1.16) in file header', 'permanent'],
    ['R-02 missing owner', 'ERROR: role "tmp_owner" does not exist', 'manual'],
    ['R-05 already exists', 'ERROR: relation "t" already exists', 'permanent'],
    ['R-09 read-only', 'ERROR: cannot execute CREATE TABLE in a read-only transaction', 'permanent'],
    ['P-01 target not reached', 'FATAL: recovery ended before configured recovery target was reached', 'manual'],
    ['P-02 target too early', 'FATAL: requested recovery stop point is before consistent recovery point', 'manual'],
    ['P-06 conflicting targets', 'FATAL: multiple recovery targets specified', 'permanent'],
    ['V-01 manifest size', 'pg_verifybackup: error: "base/1/112" has size 8199 on disk but size 8192 in the manifest', 'manual'],
    ['V-02 missing file', 'pg_verifybackup: error: "PG_VERSION" is present in the manifest but not on disk', 'manual'],
    ['A-07 exit 127', 'command not found', 'permanent'],
  ]

  for (const [name, stderr, expected] of cases) {
    it(`${name} -> ${expected}`, () => {
      expect(classifyRunResult(failure(stderr))).toBe(expected)
    })
  }

  it('treats a timeout as transient regardless of stderr', () => {
    expect(
      classifyRunResult({ timedOut: true, signal: null, exitCode: -1, stderr: 'permission denied' }),
    ).toBe('transient')
  })

  it('maps SQLSTATE classes when no signature matches', () => {
    expect(classifyRunResult(failure('ERROR: connection failure SQL state: 08006'))).toBe('transient')
    expect(classifyRunResult(failure('ERROR: deadlock detected SQL state: 40P01'))).toBe('transient')
    expect(classifyRunResult(failure('ERROR: undefined table SQL state: 42P01'))).toBe('permanent')
    expect(classifyRunResult(failure('ERROR: cannot execute SQL state: 25006'))).toBe('permanent')
  })

  it('treats a signal-only termination as manual', () => {
    expect(
      classifyRunResult({ timedOut: false, signal: 'SIGTERM', exitCode: -1, stderr: '' }),
    ).toBe('manual')
  })
})

describe('failureSignature', () => {
  it('names the catalogued signature', () => {
    expect(failureSignature(failure('FATAL:  password authentication failed for user "postgres"'))).toBe(
      'auth:password',
    )
    expect(failureSignature(failure('ERROR: relation "x" does not exist SQL state: 42P01'))).toBe(
      'sqlstate:42P01',
    )
    expect(failureSignature(failure('pg_dump: error: could not connect'))).toBe('connect:refused')
  })

  it('falls back to the exit code when nothing matches', () => {
    expect(failureSignature(failure('something unexpected', 7))).toBe('exit:7')
    expect(failureSignature({ timedOut: true, signal: null, exitCode: -1, stderr: '' })).toBe(
      'timeout',
    )
  })

  it('is stable for the same failure and free of volatile detail', () => {
    const a = failureSignature(failure('FATAL:  password authentication failed for user "a"'))
    const b = failureSignature(failure('FATAL:  password authentication failed for user "b"'))
    expect(a).toBe(b)
    expect(a).not.toContain('"a"')
  })
})

describe('classifyStepFailure', () => {
  it('lets a recognised signature win over the CLI exit code', () => {
    // The CLI reports every connection problem as exit 3, but a rejected
    // password is a human decision, not a transient fault.
    const classified = classifyStepFailure(
      failure('bkagent: CONNECT_FAILED: FATAL:  password authentication failed for user "postgres"', 3),
    )
    expect(classified).toEqual({ errorClass: 'manual', signature: 'auth:password' })
  })

  it('treats a bare exit 3 as a transient connection failure', () => {
    expect(classifyStepFailure(failure('bkagent: something went wrong', 3))).toEqual({
      errorClass: 'transient',
      signature: 'connect:refused',
    })
  })

  it('treats exit 2 as a wrong action and exit 4 as a rejected plan', () => {
    expect(classifyStepFailure(failure('', 2)).signature).toBe('usage:invalid-action')
    expect(classifyStepFailure(failure('', 4))).toEqual({
      errorClass: 'manual',
      signature: 'plan:rejected',
    })
  })

  it('keeps a catalogued permanent failure permanent at exit 1', () => {
    const classified = classifyStepFailure(
      failure('pg_dump: error: FATAL:  database "app" does not exist', 1),
    )
    expect(classified.errorClass).toBe('permanent')
    expect(classified.signature).toBe('schema:database-missing')
  })
})
