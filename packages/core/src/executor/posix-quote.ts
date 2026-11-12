/**
 * POSIX quoting used *only* as transport encoding for remote command strings.
 *
 * `ssh` does not accept an argv array: it takes one command string and hands it
 * to the login shell on the far side. The argv we want the remote program to
 * receive therefore has to be encoded into a single string that the remote
 * shell reconstructs verbatim. That is transport encoding, not local shell
 * interpretation: the control plane never builds a local shell string and never
 * spawns a shell locally (`spawn(..., { shell: false })` always holds). A quote
 * produced here can only ever be re-parsed by the remote shell that ssh itself
 * starts, and each element is quoted so that it arrives as exactly one
 * argument.
 *
 * `kubectl exec` takes a real argv (everything after `--`), so it never uses
 * this module.
 */

export type RemoteExecutorErrorCode =
  | 'ENV_NOT_SUPPORTED'
  | 'INVALID_HOST'
  | 'INVALID_ARGV'
  | 'SPAWN_FAILED'
  | 'TIMEOUT'

/**
 * Typed failure for remote transports. `run()`/`stream()` report timeouts and
 * non-zero exits as results (the `Executor` contract), so `TIMEOUT` and
 * `SPAWN_FAILED` are reserved for callers that convert a result into an error
 * and for spawns that fail synchronously.
 */
export class RemoteExecutorError extends Error {
  readonly code: RemoteExecutorErrorCode

  constructor(code: RemoteExecutorErrorCode, message: string) {
    super(message)
    this.name = 'RemoteExecutorError'
    this.code = code
  }
}

/** Characters that a POSIX shell cannot reinterpret, so quoting is optional. */
const SAFE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/

/** Rejects arguments a remote command line can never carry. */
export function assertNoNulArguments(argv: readonly string[]): void {
  for (const arg of argv) {
    if (arg.includes('\0')) {
      throw new RemoteExecutorError('INVALID_ARGV', 'argv must not contain a NUL byte')
    }
  }
}

/** Single-quote one argument for a POSIX remote shell; never returns an unquoted unsafe string. */
export function posixQuote(arg: string): string {
  if (arg.includes('\0')) {
    throw new RemoteExecutorError('INVALID_ARGV', 'argv must not contain a NUL byte')
  }
  if (arg === '') return "''"
  if (SAFE_ARGUMENT.test(arg)) return arg
  // `'` cannot appear inside a single-quoted run: close, emit an escaped quote,
  // and reopen. `'\''` is the canonical encoding.
  return `'${arg.replaceAll("'", "'\\''")}'`
}

/**
 * Join an argv into one command string for `ssh host <string>`.
 * Throws `INVALID_ARGV` for an empty argv or any NUL byte.
 */
export function posixCommand(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new RemoteExecutorError('INVALID_ARGV', 'argv must not be empty')
  }
  assertNoNulArguments(argv)
  return argv.map(posixQuote).join(' ')
}
