import { describe, expect, it } from 'vitest'

import { expandQuery } from '../src/text/aliases'

describe('expandQuery', () => {
  it('maps a chinese term to the identifiers an engineer would have typed', () => {
    const result = expandQuery('归档失败后 PITR 窗口怎么断的')
    expect(result.query).toContain('archive_command')
    expect(result.query).toContain('archiver')
    expect(result.applied).toContain('归档失败')
  })

  it('prefers the longest surface form and consumes the matched span', () => {
    const result = expandQuery('时间点恢复的目标')
    expect(result.applied).toContain('时间点恢复')
    // "恢复" is part of the longer match and must not fire again as "restore".
    expect(result.applied).not.toContain('恢复')
    expect(result.added).toContain('point-in-time recovery')
  })

  it('expands english abbreviations too', () => {
    const result = expandQuery('does pitr need a base backup for wal')
    expect(result.added).toContain('point-in-time')
    expect(result.added).toContain('write ahead log')
  })

  it('deduplicates appended terms and leaves unknown questions alone', () => {
    const result = expandQuery('归档 归档')
    expect(new Set(result.added).size).toBe(result.added.length)

    const untouched = expandQuery('what is the weather in berlin')
    expect(untouched.query).toBe('what is the weather in berlin')
    expect(untouched.added).toEqual([])
  })

  it('can be disabled for ablation runs', () => {
    const result = expandQuery('归档', { enabled: false })
    expect(result.query).toBe('归档')
  })
})
