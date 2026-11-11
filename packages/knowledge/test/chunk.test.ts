import { describe, expect, it } from 'vitest'

import { chunkSource } from '../src/corpus/chunk'
import type { CorpusSource } from '../src/types'

function source(body: string): CorpusSource {
  return {
    sourceId: 'test-doc',
    title: 'Test',
    url: 'mem://test',
    kind: 'md',
    version: 'test-1',
    license: 'MIT',
    body,
  }
}

describe('chunkSource', () => {
  it('keeps the heading path on every passage and drops the document title', () => {
    const chunks = chunkSource(
      source(
        [
          '# Doc Title',
          '## Point-in-Time Recovery',
          'Restore needs a base backup plus every WAL segment written after it.',
          '### recovery_target_lsn',
          'Set recovery_target_lsn to stop replay at an exact log sequence number.',
        ].join('\n'),
      ),
    )
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      'Point-in-Time Recovery',
      'Point-in-Time Recovery > recovery_target_lsn',
    ])
  })

  it('splits a long section near the target size but never mid-paragraph', () => {
    const paragraph = `${'archive_command archives one WAL segment at a time. '.repeat(20)}`
    const body = ['## Archiving', paragraph, paragraph, paragraph, paragraph].join('\n\n')
    const chunks = chunkSource(source(body))
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.chars).toBeLessThanOrEqual(2200 + paragraph.length)
      expect(chunk.text.endsWith('segment at a time.')).toBe(true)
    }
  })

  it('emits one passage per row for long tables so each event stays retrievable', () => {
    const rows = Array.from({ length: 10 }, (_, index) => `| E-0${index + 1} | trigger ${index + 1} | signature ${index + 1} |`)
    const body = ['## 2. E — Environment', '| ID | Trigger | Signature |', '| --- | --- | --- |', ...rows, ''].join('\n')
    const chunks = chunkSource(source(body))
    expect(chunks).toHaveLength(10)
    expect(chunks[0]?.text).toContain('ID: E-01')
    expect(chunks[0]?.text).toContain('Signature: signature 1')
    expect(chunks[0]?.headingPath).toBe('2. E — Environment')
  })

  it('keeps short tables inline instead of exploding them', () => {
    const body = ['## Small', '| Parameter | Meaning |', '| --- | --- |', '| wal_level | replica enables archiving |', '| archive_mode | on starts the archiver |'].join('\n')
    const chunks = chunkSource(source(body))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toContain('| wal_level | replica enables archiving |')
  })

  it('does not treat a heading inside a fenced code block as structure', () => {
    const body = ['## Restore', '```', '# not a heading, just a shell comment', 'restore_command = true', '```'].join('\n')
    const chunks = chunkSource(source(body))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.headingPath).toBe('Restore')
    expect(chunks[0]?.text).toContain('# not a heading')
  })
})
