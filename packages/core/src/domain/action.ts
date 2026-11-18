/**
 * A step action is the agent's plan expressed in the product's own verbs.
 *
 * The model chooses a command and its flags; it never chooses the execution
 * mechanics. `args` is a flat argv tail (never a shell string), and
 * `ACTION_FLAGS` is the complete set of flags a step may use. Everything the
 * grammar does not name is refused, so a model cannot reach for `--yes`,
 * `--principal`, `--db` or a transport flag to move authority out of the
 * goal layer.
 *
 * This module is pure: no I/O, no environment, no clock. It is the boundary
 * that makes "the agent decides what to do" compatible with "the core decides
 * whether it may".
 */

export const ACTION_COMMANDS = [
  'inspect',
  'providers',
  'backup',
  'restore',
  'verify',
  'pitr',
  'pgbackrest-backup',
  'pgbackrest-restore',
  'pgbackrest-expire',
  'walg-backup',
  'walg-restore',
  'walg-prune',
  'catalog',
  'report',
  'metrics',
  'capacity',
  'asset-list',
  'asset-rpo',
  'trace',
] as const
export type ActionCommand = (typeof ACTION_COMMANDS)[number]

/**
 * Commands whose Plan can reach `destructive`. A step using one of these needs
 * a human approval on the step itself; the goal layer appends `--yes` only
 * after that approval exists, and the CLI gate still runs its own checks
 * (asset registration, proven identity, four-eyes on production).
 */
export const DESTRUCTIVE_ACTION_COMMANDS = [
  'restore',
  'pitr',
  'pgbackrest-restore',
  'pgbackrest-expire',
  'walg-restore',
  'walg-prune',
] as const
export type DestructiveActionCommand = (typeof DESTRUCTIVE_ACTION_COMMANDS)[number]

/**
 * Flags no step may set, whatever the target command accepts. Each of these
 * either carries authority (`--yes`, `--principal`), redirects the run away
 * from the goal's control database (`--db`), moves execution to another host
 * (`--transport` and its sub-flags), or would let a step claim work it did not
 * do (`--state-dir`, `--resume`).
 */
export const DENIED_FLAGS = [
  '--yes',
  '--principal',
  '--db',
  '--transport',
  '--ssh-host',
  '--ssh-port',
  '--known-hosts',
  '--identity',
  '--kubectl-pod',
  '--namespace',
  '--container',
  '--context',
  '--kubeconfig',
  '--state-dir',
  '--resume',
] as const

const READ_ONLY_COMMANDS: ReadonlySet<ActionCommand> = new Set<ActionCommand>([
  'inspect',
  'providers',
  'catalog',
  'report',
  'metrics',
  'capacity',
  'asset-list',
  'asset-rpo',
  'trace',
])

/** Per-command flag allowlist. A flag absent here is refused. */
export const ACTION_FLAGS: Readonly<Record<ActionCommand, readonly string[]>> = {
  inspect: ['--dsn', '--format'],
  providers: ['--dsn', '--format'],
  backup: [
    '--dsn',
    '--out',
    '--mode',
    '--database',
    '--format',
    '--jobs',
    '--compress',
    '--table',
    '--schema',
    '--wal-method',
    '--label',
    '--storage-kind',
    '--storage-root',
    '--remove-local',
  ],
  restore: [
    '--dsn',
    '--input',
    '--database',
    '--format',
    '--create-database',
    '--clean',
    '--if-exists',
    '--no-owner',
    '--jobs',
  ],
  verify: ['--dsn', '--input', '--database', '--format', '--jobs', '--no-owner', '--keep-scratch'],
  pitr: [
    '--dsn',
    '--data-dir',
    '--port',
    '--log',
    '--restore-command',
    '--target-time',
    '--target-lsn',
    '--target-name',
    '--target-xid',
    '--action',
    '--verify-sql',
  ],
  'pgbackrest-backup': ['--config', '--stanza', '--type', '--ensure-stanza'],
  'pgbackrest-restore': [
    '--config',
    '--stanza',
    '--data-dir',
    '--target-type',
    '--target',
    '--start-port',
    '--log',
  ],
  'pgbackrest-expire': ['--config', '--stanza'],
  'walg-backup': ['--data-dir', '--walg'],
  'walg-restore': ['--data-dir', '--backup', '--start-port'],
  'walg-prune': ['--retain-full', '--walg'],
  catalog: ['--target', '--provider', '--since', '--limit', '--history', '--format'],
  report: ['--since', '--format'],
  metrics: [],
  capacity: ['--threshold-gb', '--days'],
  'asset-list': ['--format'],
  'asset-rpo': [],
  trace: ['--ticket', '--plan'],
}

/** Flags that take no value. Every other allowed flag takes exactly one. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  '--create-database',
  '--clean',
  '--if-exists',
  '--no-owner',
  '--keep-scratch',
  '--ensure-stanza',
  '--history',
  '--remove-local',
])

/**
 * Flags a command refuses to run without. A missing one is a decomposition
 * error, not a failed run: the agent's plan is incomplete, so it must be
 * rejected before anything is dispatched.
 */
const REQUIRED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  backup: ['--out'],
  restore: ['--input'],
  verify: ['--input'],
  pitr: ['--data-dir', '--port', '--log', '--restore-command'],
  'pgbackrest-backup': ['--config', '--stanza'],
  'pgbackrest-restore': ['--config', '--stanza', '--data-dir'],
  'pgbackrest-expire': ['--config', '--stanza'],
  'walg-backup': ['--data-dir'],
  'walg-restore': ['--data-dir'],
  'walg-prune': ['--retain-full'],
}

/** `pitr` accepts exactly one recovery target. */
const PITR_TARGET_FLAGS = ['--target-time', '--target-lsn', '--target-name', '--target-xid'] as const

/**
 * Commands that persist to the control database. Only these receive the goal
 * layer's `--db`; the read-only probes (`inspect`, `providers`) do not accept
 * it and would fail on an unknown option.
 */
const CONTROL_DB_COMMANDS: ReadonlySet<ActionCommand> = new Set<ActionCommand>([
  'backup',
  'restore',
  'verify',
  'pitr',
  'pgbackrest-backup',
  'pgbackrest-restore',
  'pgbackrest-expire',
  'walg-backup',
  'walg-restore',
  'walg-prune',
  'catalog',
  'report',
  'metrics',
  'capacity',
  'asset-list',
  'asset-rpo',
  'trace',
])

/** Flags that may appear more than once. */
const REPEATABLE_FLAGS: ReadonlySet<string> = new Set(['--table', '--schema'])

/** Flags whose value must be a non-negative integer. */
const INTEGER_FLAGS: ReadonlySet<string> = new Set([
  '--jobs',
  '--compress',
  '--port',
  '--start-port',
  '--limit',
  '--threshold-gb',
  '--days',
  '--retain-full',
])

/**
 * Per-command enumerations. Only the flags whose value set is closed are
 * listed; `--format` is deliberately per command because it means different
 * things to `backup` (dump format) and to `report` (output format).
 */
const ACTION_ENUMS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  inspect: { '--format': ['json', 'text'] },
  providers: { '--format': ['json', 'text'] },
  backup: {
    '--mode': ['logical', 'physical'],
    '--format': ['custom', 'directory', 'plain', 'tar'],
    '--wal-method': ['stream', 'fetch'],
    '--storage-kind': ['fs', 'nfs', 's3'],
  },
  restore: { '--format': ['custom', 'directory', 'plain'] },
  verify: { '--format': ['custom', 'directory', 'plain'] },
  pitr: { '--action': ['promote', 'pause', 'shutdown'] },
  'pgbackrest-backup': { '--type': ['full', 'diff', 'incr'] },
  'pgbackrest-restore': {
    '--target-type': ['time', 'lsn', 'xid', 'name', 'immediate'],
  },
  catalog: { '--format': ['json', 'text'] },
  report: { '--format': ['markdown', 'json'] },
  'asset-list': { '--format': ['json', 'text'] },
}

/** Characters that would turn an argv token into a shell construct. */
const SHELL_METACHARACTERS = /[;&|$`<>(){}\\\n\r\t\0]/

/** `scheme://user:secret@host` — a password embedded in a DSN. */
const INLINE_CREDENTIAL = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^@\s]*@/i

export interface StepAction {
  readonly command: ActionCommand
  readonly args: readonly string[]
}

export interface ActionIssue {
  readonly field: 'command' | 'args'
  readonly message: string
}

export function isActionCommand(value: unknown): value is ActionCommand {
  return typeof value === 'string' && (ACTION_COMMANDS as readonly string[]).includes(value)
}

export function isDestructiveAction(action: StepAction): boolean {
  return (DESTRUCTIVE_ACTION_COMMANDS as readonly string[]).includes(action.command)
}

export function isReadOnlyAction(action: StepAction): boolean {
  return READ_ONLY_COMMANDS.has(action.command)
}

/** Commands whose stdout can be requested as JSON. */
const JSON_FORMAT_COMMANDS: ReadonlySet<ActionCommand> = new Set<ActionCommand>([
  'inspect',
  'providers',
  'catalog',
  'asset-list',
])

/**
 * Normalises the argv tail: refuses duplicates of single-value flags, refuses
 * positional tokens, and orders nothing (the caller's order is preserved so a
 * repeated `--table` keeps its meaning).
 */
export function validateStepAction(value: unknown): ActionIssue[] {
  const issues: ActionIssue[] = []
  if (typeof value !== 'object' || value === null) {
    return [{ field: 'command', message: 'action must be an object' }]
  }
  const candidate = value as { command?: unknown; args?: unknown }

  if (!isActionCommand(candidate.command)) {
    issues.push({
      field: 'command',
      message: `command must be one of ${ACTION_COMMANDS.join(', ')}`,
    })
    return issues
  }
  const command = candidate.command
  const allowed = new Set(ACTION_FLAGS[command])

  if (!Array.isArray(candidate.args)) {
    issues.push({ field: 'args', message: 'args must be an array of strings' })
    return issues
  }

  const args: unknown[] = candidate.args
  const seen = new Set<string>()
  const present = new Set<string>()
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (typeof token !== 'string') {
      issues.push({ field: 'args', message: `args[${index}] must be a string` })
      continue
    }
    if (token === '') {
      issues.push({ field: 'args', message: `args[${index}] must not be empty` })
      continue
    }
    if (SHELL_METACHARACTERS.test(token)) {
      issues.push({
        field: 'args',
        message: `args[${index}] contains a shell metacharacter: ${JSON.stringify(token)}`,
      })
      continue
    }
    if (token === '--') {
      issues.push({ field: 'args', message: 'args must not contain a `--` separator' })
      continue
    }
    if (token.includes('=') && token.startsWith('-')) {
      issues.push({
        field: 'args',
        message: `args[${index}] must pass a value as a separate token, not ${JSON.stringify(token)}`,
      })
      continue
    }

    if (!token.startsWith('-')) {
      issues.push({
        field: 'args',
        message: `args[${index}] is positional; every value must follow its flag`,
      })
      continue
    }

    if ((DENIED_FLAGS as readonly string[]).includes(token)) {
      issues.push({ field: 'args', message: `${token} is reserved by the goal layer` })
      continue
    }
    if (!allowed.has(token)) {
      issues.push({
        field: 'args',
        message: `${token} is not allowed for ${command}; allowed: ${[...allowed].join(' ') || '(none)'}`,
      })
      continue
    }
    present.add(token)
    if (!REPEATABLE_FLAGS.has(token)) {
      if (seen.has(token)) {
        issues.push({ field: 'args', message: `${token} may appear only once` })
        continue
      }
      seen.add(token)
    }

    if (BOOLEAN_FLAGS.has(token)) continue

    const next = args[index + 1]
    if (typeof next !== 'string' || next.startsWith('--')) {
      issues.push({ field: 'args', message: `${token} requires a value` })
      continue
    }
    index += 1

    if (SHELL_METACHARACTERS.test(next)) {
      issues.push({
        field: 'args',
        message: `the value of ${token} contains a shell metacharacter: ${JSON.stringify(next)}`,
      })
      continue
    }

    // A goal is persisted and resumed, so an action must not carry a credential:
    // the redacted copy in the control database is what a later run would read,
    // and a plaintext DSN in argv is visible to every local process. Credentials
    // travel through `BKAGENT_DSN`, `.pgpass`, peer or GSSAPI instead.
    if (token === '--dsn' && INLINE_CREDENTIAL.test(next)) {
      issues.push({
        field: 'args',
        message:
          '--dsn must not carry a password; export BKAGENT_DSN or use .pgpass / peer / GSSAPI',
      })
      continue
    }

    if (INTEGER_FLAGS.has(token) && !/^\d+$/.test(next)) {
      issues.push({ field: 'args', message: `${token} requires a non-negative integer` })
      continue
    }
    const enumValues = ACTION_ENUMS[command]?.[token]
    if (enumValues !== undefined && !enumValues.includes(next)) {
      issues.push({
        field: 'args',
        message: `${token} must be one of ${enumValues.join('|')}`,
      })
    }
  }

  for (const required of REQUIRED_FLAGS[command] ?? []) {
    if (!present.has(required)) {
      issues.push({ field: 'args', message: `${command} requires ${required}` })
    }
  }

  if (command === 'pitr') {
    const targets = PITR_TARGET_FLAGS.filter((flag) => present.has(flag))
    if (targets.length !== 1) {
      issues.push({
        field: 'args',
        message: `pitr requires exactly one of ${PITR_TARGET_FLAGS.join(' ')}, got ${targets.length}`,
      })
    }
  }

  return issues
}

export function isStepAction(value: unknown): value is StepAction {
  return validateStepAction(value).length === 0
}

/**
 * Removes credentials from a DSN before an action is persisted. Actions land in
 * `goal_steps`, `step_attempts` and `memory_entries`, all of which are read by
 * reporting surfaces, so a password must never be stored there.
 */
export function redactAction(action: StepAction): StepAction {
  return {
    command: action.command,
    args: action.args.map((token) =>
      token.includes('://') ? token.replace(/\/\/([^:/@]+):[^@/]*@/, '//$1:***@') : token,
    ),
  }
}

/**
 * Builds the argv the control plane will execute: the action's own argv, the
 * goal layer's control database, and — only for an approved destructive step —
 * `--yes`. The caller is responsible for having checked the approval first.
 */
export function actionArgv(
  action: StepAction,
  options: { controlDb: string; approveDestructive: boolean; jsonOutput?: boolean },
): string[] {
  const argv = [action.command, ...action.args]
  const destructive = isDestructiveAction(action)
  if (destructive) {
    if (!options.approveDestructive) {
      throw new Error(`refusing to build argv for destructive ${action.command} without approval`)
    }
    argv.push('--yes')
  }
  if (options.jsonOutput === true && JSON_FORMAT_COMMANDS.has(action.command)) {
    if (!argv.includes('--format')) argv.push('--format', 'json')
  }
  if (CONTROL_DB_COMMANDS.has(action.command)) argv.push('--db', options.controlDb)
  return argv
}
