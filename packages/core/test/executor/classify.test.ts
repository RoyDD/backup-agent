import { describe, expect, it } from 'vitest'

import { classifyRunResult, extractSqlState } from '../../src/executor/classify'

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
