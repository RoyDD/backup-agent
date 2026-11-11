import { parseArgs } from 'node:util'
import { LocalExecutor, type Executor } from '@backup-agent/core'

import { InspectError, inspectInstance, parseDsn, type InstanceInfo } from './inspect'

const USAGE = `bkagent — PostgreSQL backup and restore agent

Usage:
  bkagent inspect --dsn <postgres://user:pass@host:port/db> [--format json|text]

Environment:
  BKAGENT_DSN    Default DSN when --dsn is omitted

Exit codes:
  0  success
  2  usage error
  3  connection failure
  4  probe failure
`

export interface CliDeps {
  executor?: Executor
  stdout?: (text: string) => void
  stderr?: (text: string) => void
  env?: NodeJS.ProcessEnv
}

function renderText(info: InstanceInfo): string {
  const lines = [
    `version:            ${info.version}`,
    `server_version_num: ${info.serverVersionNum}`,
    `user:               ${info.currentUser}`,
    `database:           ${info.currentDatabase}`,
    `in_recovery:        ${info.inRecovery}`,
    `system_identifier:  ${info.systemIdentifier ?? '(unavailable)'}`,
    `wal_level:          ${info.walLevel}`,
    `archive_mode:       ${info.archiveMode}`,
    `databases:          ${info.databases.join(', ')}`,
    `execution_site:     ${info.executionSite}`,
  ]
  for (const warning of info.warnings) lines.push(`warning:            ${warning}`)
  return `${lines.join('\n')}\n`
}

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const write = deps.stdout ?? ((text: string) => process.stdout.write(text))
  const writeError = deps.stderr ?? ((text: string) => process.stderr.write(text))
  const env = deps.env ?? process.env
  const executor = deps.executor ?? new LocalExecutor()

  const [command, ...rest] = argv
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    write(USAGE)
    return command === undefined ? 2 : 0
  }
  if (command !== 'inspect') {
    writeError(`bkagent: unknown command "${command}"\n`)
    return 2
  }

  let parsed: { dsn?: string; format?: string }
  try {
    const result = parseArgs({
      args: [...rest],
      allowPositionals: false,
      options: {
        dsn: { type: 'string' },
        format: { type: 'string', default: 'json' },
      },
    })
    parsed = { dsn: result.values.dsn, format: result.values.format }
  } catch (error) {
    writeError(`bkagent: ${(error as Error).message}\n`)
    return 2
  }

  const dsn = parsed.dsn ?? env.BKAGENT_DSN
  if (dsn === undefined || dsn.trim() === '') {
    writeError('bkagent: --dsn or BKAGENT_DSN is required\n')
    return 2
  }
  const format = parsed.format ?? 'json'
  if (format !== 'json' && format !== 'text') {
    writeError(`bkagent: unsupported format "${format}"\n`)
    return 2
  }

  try {
    const connection = parseDsn(dsn)
    const info = await inspectInstance(executor, connection)
    write(format === 'json' ? `${JSON.stringify(info, null, 2)}\n` : renderText(info))
    return 0
  } catch (error) {
    if (error instanceof InspectError) {
      writeError(`bkagent: ${error.code}: ${error.message}\n`)
      if (error.code === 'INVALID_DSN') return 2
      return error.code === 'CONNECT_FAILED' ? 3 : 4
    }
    writeError(`bkagent: ${(error as Error).message}\n`)
    return 4
  }
}
