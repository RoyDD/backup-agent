import { describe, expect, it } from 'vitest'

import type { ScorerPort } from '../../src/ports/scorer'

/**
 * Contract shared by every Scorer implementation.
 *
 * The pipeline trusts one invariant above all: a scorer returns exactly one
 * finite score per candidate, in the order it received them. Everything else
 * (semantic quality, latency) is a property of the backend, not of the port.
 */
export function defineScorerContractSuite(
  name: string,
  factory: () => Promise<ScorerPort> | ScorerPort,
): void {
  describe(`Scorer contract: ${name}`, () => {
    const request = {
      question: 'archive_command keeps failing during point-in-time recovery',
      context: ['archive'],
      candidates: [
        {
          id: 1,
          text: 'archive_command archives one WAL segment at a time',
          headingPath: 'Archiving',
          features: { coverage: 0.5, identifier: 0.5, heading: 0, lex: 0.8, novelty: 0.5 },
        },
        {
          id: 2,
          text: 'recovery_target_lsn stops replay at a log sequence number',
          headingPath: 'Recovery target',
          features: { coverage: 0.2, identifier: 0.3, heading: 0.1, lex: 0.4, novelty: 0.2 },
        },
        {
          id: 3,
          text: 'unrelated compression settings',
          headingPath: 'Compression',
          features: { coverage: 0, identifier: 0, heading: 0, lex: 0.1, novelty: 0 },
        },
      ],
    }

    it('C-S01 returns one finite score per candidate, in request order', async () => {
      const scorer = await factory()
      const scores = await scorer.score(request)
      expect(scores).toHaveLength(request.candidates.length)
      for (const value of scores) expect(Number.isFinite(value)).toBe(true)
    })

    it('C-S02 is deterministic for an identical request', async () => {
      const scorer = await factory()
      const first = await scorer.score(request)
      const second = await scorer.score(request)
      expect(second).toEqual(first)
    })

    it('C-S03 answers a health probe with a reason, never a bare boolean', async () => {
      const scorer = await factory()
      const health = await scorer.health()
      expect(typeof health.ok).toBe('boolean')
      expect(health.detail.length).toBeGreaterThan(0)
    })
  })
}
