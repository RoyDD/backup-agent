/**
 * Recoverable PITR window arithmetic (plan §9).
 *
 * The rule is:
 *
 *   recoverableWindow = [baseBackup.consistentPointLsn, lastArchivedLsn] ∩ retentionWindow
 *
 * This module only computes the first term, from facts the control plane can
 * obtain locally without an archive listing:
 *
 *  - `baseBackup.consistentPointLsn`: the `START WAL LOCATION` line of
 *    `<dataDir>/backup_label`, which PostgreSQL writes when the base backup
 *    starts.
 *  - `lastArchivedLsn`: `pg_stat_archiver.last_archived_wal` on the live
 *    instance, converted to the *end* of that segment. The upper bound is
 *    exclusive: the last archived 16 MiB segment covers WAL up to, but not
 *    including, the start LSN of the following segment.
 *
 * The retention intersection is deliberately not evaluated here. Retention is
 * a provider/repository fact (`Repository` port, provider retention command),
 * not an instance fact, so the caller intersects this interval with whatever
 * retention window it has established.
 *
 * Known limitation, not faked: this is *interval* arithmetic, not an archive
 * audit. WAL-gap enumeration and cross-timeline `.history` checks are out of
 * scope because the archive is provider-owned (ADR-003) and the control plane
 * holds no archive listing. Consequently a target inside the window is not
 * proof that the required segments and history file still exist; the provider's
 * restore path remains authoritative. A target that fails these checks is
 * refused before any subprocess runs.
 *
 * Pure functions only: no I/O, no process access, no dependencies, so the CLI
 * can import this module directly before building a restore Plan.
 */

/** PostgreSQL's fixed WAL segment size (`--wal-segsize` default). */
export const WAL_SEGMENT_SIZE = 16 * 1024 * 1024

const LSN_PATTERN = /^([0-9A-Fa-f]{1,8})\/([0-9A-Fa-f]{1,8})$/
const WAL_FILE_PATTERN = /^[0-9A-Fa-f]{24}$/
const WAL_LOCATION_LINE =
  /^START WAL LOCATION:[ \t]*([0-9A-Fa-f]{1,8}\/[0-9A-Fa-f]{1,8})(?:[ \t]*\(file[ \t]+([^\s)]+)\))?/i
const START_TIMELINE_LINE = /^START TIMELINE:[ \t]*(\d+)[ \t]*$/i
const UINT32_MASK = 0xffffffffn
const MAX_LSN = 0xffffffffffffffffn

/**
 * Parses PostgreSQL's textual LSN form (`'0/16B3748'`) into the numeric log
 * sequence number. Returns null for anything that is not `hex/hex` with at most
 * eight hex digits per half.
 */
export function parseLsn(text: string): bigint | null {
  const match = LSN_PATTERN.exec(text.trim())
  if (match === null) return null
  const [, high, low] = match
  if (high === undefined || low === undefined) return null
  return (BigInt(`0x${high}`) << 32n) | BigInt(`0x${low}`)
}

/**
 * Inverse of {@link parseLsn}: `23797448n` → `'0/16B3748'`. Uppercase hex, no
 * zero padding, because that is the form PostgreSQL prints. Throws for values
 * outside the 64-bit LSN range rather than silently truncating.
 */
export function formatLsn(value: bigint): string {
  if (value < 0n || value > MAX_LSN) {
    throw new RangeError(`LSN ${value.toString()} is outside the 64-bit range`)
  }
  const high = (value >> 32n) & UINT32_MASK
  const low = value & UINT32_MASK
  return `${high.toString(16).toUpperCase()}/${low.toString(16).toUpperCase()}`
}

/**
 * WAL segment size used for filename arithmetic. `timelineAware` is a `never`
 * parameter: cross-timeline handling (`.history` files, per-timeline segment
 * numbering) is explicitly not implemented here — see the module comment.
 */
export function walSegmentSize(timelineAware?: never): number {
  void timelineAware
  return WAL_SEGMENT_SIZE
}

/**
 * Converts a WAL file name (`TTTTTTTTLLLLLLLLSSSSSSSS`, 24 hex digits) to the
 * LSN at which that segment starts: `(log << 32) + segment * 16MiB`. The
 * timeline prefix participates in the file name only, never in the LSN.
 * Returns null for a name that is not 24 hex digits.
 */
export function walFileNameToLsn(name: string): bigint | null {
  const trimmed = name.trim()
  if (!WAL_FILE_PATTERN.test(trimmed)) return null
  const log = BigInt(`0x${trimmed.slice(8, 16)}`)
  const segment = BigInt(`0x${trimmed.slice(16, 24)}`)
  return (log << 32n) + segment * BigInt(WAL_SEGMENT_SIZE)
}

export interface BackupLabelFacts {
  startLsn: bigint | null
  startWalFile: string | null
  startTimeline: number | null
}

/**
 * Leniently parses the lines of `<dataDir>/backup_label` that matter here:
 *
 *   START WAL LOCATION: 0/16B3748 (file 000000010000000000000016)
 *   START TIMELINE: 1
 *
 * Missing or malformed lines yield nulls instead of throwing; other lines
 * (`CHECKPOINT LOCATION`, `BACKUP METHOD`, `LABEL`, `START TIME`, …) are
 * ignored.
 */
export function parseBackupLabel(text: string): BackupLabelFacts {
  let startLsn: bigint | null = null
  let startWalFile: string | null = null
  let startTimeline: number | null = null

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (startLsn === null) {
      const match = WAL_LOCATION_LINE.exec(line)
      if (match !== null) {
        const [, lsn, file] = match
        startLsn = lsn === undefined ? null : parseLsn(lsn)
        if (file !== undefined && WAL_FILE_PATTERN.test(file)) startWalFile = file
      }
    }
    if (startTimeline === null) {
      const match = START_TIMELINE_LINE.exec(line)
      if (match !== null) {
        const [, timeline] = match
        if (timeline !== undefined) {
          const parsed = Number.parseInt(timeline, 10)
          // PostgreSQL timelines start at 1; 0 is not a real timeline.
          if (Number.isInteger(parsed) && parsed >= 1) startTimeline = parsed
        }
      }
    }
  }

  return { startLsn, startWalFile, startTimeline }
}

export interface PitrWindowFacts {
  /** `pg_stat_archiver.last_archived_wal`, already probed from the live instance. */
  lastArchivedWal: string | null
  /** Read from `<dataDir>/backup_label`. */
  backupLabel: string | null
}

export interface PitrWindowIssue {
  code:
    | 'PITR_NO_BASE_BACKUP_LABEL'
    | 'PITR_NO_ARCHIVE_FACT'
    | 'PITR_TARGET_BEFORE_BACKUP'
    | 'PITR_TARGET_BEYOND_ARCHIVE'
    | 'PITR_TARGET_UNPARSEABLE'
  message: string
}

export interface RecoverableWindow {
  from: bigint | null
  /** Exclusive upper bound: the LSN just past the last archived segment. */
  to: bigint | null
  evaluated: boolean
}

interface ResolvedFacts {
  from: bigint | null
  to: bigint | null
  startWalFile: string | null
}

function resolveFacts(facts: PitrWindowFacts): ResolvedFacts {
  const label = facts.backupLabel === null ? null : parseBackupLabel(facts.backupLabel)
  const from = label?.startLsn ?? null
  const archived =
    facts.lastArchivedWal === null || facts.lastArchivedWal.trim() === ''
      ? null
      : walFileNameToLsn(facts.lastArchivedWal)
  const to = archived === null ? null : archived + BigInt(WAL_SEGMENT_SIZE)
  return {
    from,
    to,
    startWalFile: label?.startWalFile ?? null,
  }
}

/**
 * Computes the locally observable part of the recoverable window. Both bounds
 * are null when the corresponding fact is missing or unparseable; `evaluated`
 * reports whether the interval could be established at all. The retention
 * intersection is the caller's job (see the module comment).
 */
export function recoverableWindow(facts: PitrWindowFacts): RecoverableWindow {
  const { from, to } = resolveFacts(facts)
  return { from, to, evaluated: from !== null && to !== null }
}

/**
 * Refuses an LSN recovery target that the control plane can prove is outside
 * the recoverable window, before any subprocess runs. An empty array means the
 * target is inside `[from, to)`.
 *
 * Only call this for LSN targets: time, xid and name targets cannot be mapped
 * to an LSN without replaying WAL, so no local preflight is possible for them.
 */
export function preflightPitrTarget(
  target: { lsn?: string | null },
  facts: PitrWindowFacts,
): PitrWindowIssue[] {
  const issues: PitrWindowIssue[] = []
  const { from, to, startWalFile } = resolveFacts(facts)

  if (from === null) {
    issues.push({
      code: 'PITR_NO_BASE_BACKUP_LABEL',
      message:
        'no usable base backup label (backup_label missing or without START WAL LOCATION); ' +
        'the recoverable window cannot be established',
    })
  }

  if (to === null) {
    issues.push({
      code: 'PITR_NO_ARCHIVE_FACT',
      message:
        'no usable archive fact (pg_stat_archiver.last_archived_wal missing or unparseable); ' +
        'the recoverable window cannot be established',
    })
  }

  const wanted = target.lsn === null || target.lsn === undefined ? null : parseLsn(target.lsn)
  if (wanted === null) {
    issues.push({
      code: 'PITR_TARGET_UNPARSEABLE',
      message: `PITR target LSN ${JSON.stringify(target.lsn ?? null)} could not be parsed`,
    })
    return issues
  }

  if (from !== null && wanted < from) {
    const label = startWalFile === null ? '' : ` (base backup WAL file ${startWalFile})`
    issues.push({
      code: 'PITR_TARGET_BEFORE_BACKUP',
      message:
        `PITR target ${formatLsn(wanted)} is before the base backup consistent point ` +
        `${formatLsn(from)}${label}`,
    })
  }

  if (to !== null && wanted >= to) {
    issues.push({
      code: 'PITR_TARGET_BEYOND_ARCHIVE',
      message:
        `PITR target ${formatLsn(wanted)} is at or beyond the end of the last archived WAL ` +
        `segment (exclusive upper bound ${formatLsn(to)})`,
    })
  }

  return issues
}
