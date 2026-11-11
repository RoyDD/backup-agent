import { describe, expect, it } from 'vitest'

import { toMatchQuery, tokenize } from '../src/text/tokenize'

describe('tokenize', () => {
  it('keeps identifiers whole', () => {
    expect(tokenize('pg_stat_archiver.failed_count and archive_command')).toEqual([
      'pg_stat_archiver.failed_count',
      'archive_command',
    ])
  })

  it('explodes chinese runs into unigrams and bigrams so FTS5 can match', () => {
    const tokens = tokenize('归档失败')
    expect(tokens).toContain('归档')
    expect(tokens).toContain('档失')
    expect(tokens).toContain('失败')
  })

  it('drops chinese stop characters that would match everything', () => {
    expect(tokenize('的')).toEqual([])
  })

  it('builds a quoted OR query with distinct terms', () => {
    expect(toMatchQuery('WAL 归档 WAL')).toBe('"wal" OR "归" OR "档" OR "归档"')
  })
})
