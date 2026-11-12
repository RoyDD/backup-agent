import { describe, expect, it } from 'vitest'

import {
  WAL_SEGMENT_SIZE,
  formatLsn,
  parseBackupLabel,
  parseLsn,
  preflightPitrTarget,
  recoverableWindow,
  walFileNameToLsn,
  walSegmentSize,
} from '../src/index'

// Written by PostgreSQL 16 for a streamed `pg_basebackup` taken on timeline 1.
// The `START WAL LOCATION` LSN and the file name agree: 0/16B3748 sits in
// segment 0x16 of that timeline.
const BACKUP_LABEL = [
  'START WAL LOCATION: 0/16B3748 (file 000000010000000000000016)',
  'CHECKPOINT LOCATION: 0/16B3780',
  'BACKUP METHOD: streamed',
  'BACKUP FROM: primary',
  'START TIME: 2026-01-04 09:12:33 UTC',
  'LABEL: pg_basebackup base backup',
  'START TIMELINE: 1',
  '',
].join('\n')

const FROM = 0x16b3748n // base backup consistent point
const TO = 0x3000000n // exclusive: start of the segment after 000000010000000000000002

const facts = { lastArchivedWal: '000000010000000000000002', backupLabel: BACKUP_LABEL }

function codes(issues: readonly { code: string }[]): string[] {
  return issues.map((issue) => issue.code)
}

describe('parseLsn / formatLsn', () => {
  it.each(['0/0', '0/16B3748', 'FFFFFFFF/FFFFFFFF', '1/2'])('round-trips %s', (text) => {
    const value = parseLsn(text)
    expect(value).not.toBeNull()
    expect(formatLsn(value as bigint)).toBe(text)
  })

  it('parses both halves as 64-bit halves of one number', () => {
    expect(parseLsn('0/16B3748')).toBe(FROM)
    expect(parseLsn('FFFFFFFF/FFFFFFFF')).toBe(0xffffffffffffffffn)
    expect(parseLsn('1/0')).toBe(0x100000000n)
  })

  it('rejects malformed LSNs', () => {
    expect(parseLsn('16B3748')).toBeNull()
    expect(parseLsn('0/')).toBeNull()
    expect(parseLsn('xyz/1')).toBeNull()
    expect(parseLsn('0/123456789')).toBeNull()
  })

  it('refuses to format values outside the 64-bit range', () => {
    expect(() => formatLsn(-1n)).toThrow(RangeError)
    expect(() => formatLsn(0x10000000000000000n)).toThrow(RangeError)
  })
})

describe('walFileNameToLsn', () => {
  it('maps the segment number to a 16 MiB stride', () => {
    expect(walSegmentSize()).toBe(16 * 1024 * 1024)
    expect(WAL_SEGMENT_SIZE).toBe(16 * 1024 * 1024)
    // 32 MiB: log 0, segment 2.
    expect(walFileNameToLsn('000000010000000000000002')).toBe(0x2000000n)
    // 48 MiB: the next segment boundary.
    expect(walFileNameToLsn('000000010000000000000003')).toBe(0x3000000n)
    // The timeline prefix is name-only and does not shift the LSN.
    expect(walFileNameToLsn('000000020000000000000002')).toBe(0x2000000n)
  })

  it('rejects names that are not 24 hex digits', () => {
    expect(walFileNameToLsn('00000001000000000000')).toBeNull()
    expect(walFileNameToLsn('0000000100000000000000000')).toBeNull()
    expect(walFileNameToLsn('00000001000000000000000G')).toBeNull()
    expect(walFileNameToLsn('')).toBeNull()
  })
})

describe('parseBackupLabel', () => {
  it('extracts the start LSN, WAL file and timeline', () => {
    expect(parseBackupLabel(BACKUP_LABEL)).toEqual({
      startLsn: FROM,
      startWalFile: '000000010000000000000016',
      startTimeline: 1,
    })
  })

  it('returns nulls for an empty label', () => {
    expect(parseBackupLabel('')).toEqual({
      startLsn: null,
      startWalFile: null,
      startTimeline: null,
    })
  })

  it('stays lenient about missing or malformed lines', () => {
    expect(parseBackupLabel('LABEL: nothing useful\n')).toEqual({
      startLsn: null,
      startWalFile: null,
      startTimeline: null,
    })
    expect(parseBackupLabel('START WAL LOCATION: 0/16B3748\nSTART TIMELINE: 0\n')).toEqual({
      startLsn: FROM,
      startWalFile: null,
      startTimeline: null,
    })
  })

  it('tolerates CRLF line endings', () => {
    const crlf = BACKUP_LABEL.replace(/\n/g, '\r\n')
    expect(parseBackupLabel(crlf).startLsn).toBe(FROM)
    expect(parseBackupLabel(crlf).startTimeline).toBe(1)
  })
})

describe('recoverableWindow', () => {
  it('spans the consistent point to the end of the last archived segment', () => {
    expect(recoverableWindow(facts)).toEqual({
      from: FROM,
      to: TO,
      evaluated: true,
    })
  })

  it('reports an unevaluated window when a fact is missing', () => {
    expect(recoverableWindow({ lastArchivedWal: null, backupLabel: BACKUP_LABEL })).toEqual({
      from: FROM,
      to: null,
      evaluated: false,
    })
    expect(recoverableWindow({ lastArchivedWal: facts.lastArchivedWal, backupLabel: null })).toEqual(
      { from: null, to: TO, evaluated: false },
    )
    expect(recoverableWindow({ lastArchivedWal: 'garbage', backupLabel: '' })).toEqual({
      from: null,
      to: null,
      evaluated: false,
    })
  })
})

describe('preflightPitrTarget', () => {
  it('accepts a target exactly at the base backup consistent point', () => {
    expect(preflightPitrTarget({ lsn: formatLsn(FROM) }, facts)).toEqual([])
  })

  it('refuses a target before the base backup', () => {
    const issues = preflightPitrTarget({ lsn: formatLsn(FROM - 1n) }, facts)
    expect(codes(issues)).toEqual(['PITR_TARGET_BEFORE_BACKUP'])
    expect(issues[0]?.message).toContain(formatLsn(FROM - 1n))
    expect(issues[0]?.message).toContain('000000010000000000000016')
  })

  it('accepts the last WAL byte and refuses the exclusive upper bound', () => {
    expect(preflightPitrTarget({ lsn: formatLsn(TO - 1n) }, facts)).toEqual([])
    expect(codes(preflightPitrTarget({ lsn: formatLsn(TO) }, facts))).toEqual([
      'PITR_TARGET_BEYOND_ARCHIVE',
    ])
    expect(codes(preflightPitrTarget({ lsn: formatLsn(TO + 0x1000000n) }, facts))).toEqual([
      'PITR_TARGET_BEYOND_ARCHIVE',
    ])
  })

  it('reports an unparseable target separately from the window bounds', () => {
    expect(codes(preflightPitrTarget({ lsn: 'not-an-lsn' }, facts))).toEqual([
      'PITR_TARGET_UNPARSEABLE',
    ])
    expect(codes(preflightPitrTarget({}, facts))).toEqual(['PITR_TARGET_UNPARSEABLE'])
  })

  it('refuses to preflight without a base backup label', () => {
    expect(
      codes(preflightPitrTarget({ lsn: formatLsn(FROM) }, { ...facts, backupLabel: null })),
    ).toEqual(['PITR_NO_BASE_BACKUP_LABEL'])
    expect(
      codes(preflightPitrTarget({ lsn: formatLsn(FROM) }, { ...facts, backupLabel: 'LABEL: x\n' })),
    ).toEqual(['PITR_NO_BASE_BACKUP_LABEL'])
  })

  it('refuses to preflight without an archive fact', () => {
    expect(
      codes(
        preflightPitrTarget({ lsn: formatLsn(FROM) }, { ...facts, lastArchivedWal: null }),
      ),
    ).toEqual(['PITR_NO_ARCHIVE_FACT'])
    expect(
      codes(
        preflightPitrTarget({ lsn: formatLsn(FROM) }, { ...facts, lastArchivedWal: 'short' }),
      ),
    ).toEqual(['PITR_NO_ARCHIVE_FACT'])
  })

  it('reports every missing fact at once', () => {
    expect(
      codes(preflightPitrTarget({ lsn: formatLsn(FROM) }, { lastArchivedWal: null, backupLabel: null })),
    ).toEqual(['PITR_NO_BASE_BACKUP_LABEL', 'PITR_NO_ARCHIVE_FACT'])
  })
})
