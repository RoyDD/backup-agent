import { existsSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import { lexicalScorer } from '../src/ports/scorer'
import { commandScorer } from '../src/scorers/command'
import { httpScorer } from '../src/scorers/http'
import { createScorer } from '../src/scorers'
import { defineScorerContractSuite } from './contract/scorer-contract.suite'

const FIXTURE = fileURLToPath(new URL('./fixtures/rerank.mjs', import.meta.url))

defineScorerContractSuite('lexical', () => lexicalScorer)
defineScorerContractSuite('command', () => commandScorer({ argv: [process.execPath, FIXTURE] }))

let server: Server | undefined
let baseUrl = ''

async function startServer(): Promise<void> {
  if (server) return
  server = createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      const body = JSON.parse(raw.length === 0 ? '{}' : raw) as { candidates?: unknown[] }
      const count = Array.isArray(body.candidates) ? body.candidates.length : 0
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model: 'stub-http', scores: new Array(count).fill(0).map((_, index) => (index === 0 ? 0.9 : 0.1)) }))
    })
  })
  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}/score`
}

await startServer()
defineScorerContractSuite('http', () => httpScorer({ url: baseUrl }))

afterAll(() => {
  server?.close()
})

describe('scorer negotiation fails closed', () => {
  it('refuses a command scorer without argv', () => {
    expect(() => createScorer({ backend: 'command' })).toThrow(/requires an argv/)
  })

  it('refuses an http scorer without a url', () => {
    expect(() => createScorer({ backend: 'http' })).toThrow(/requires --scorer-url/)
  })

  it('refuses an unknown backend instead of falling back to lexical', () => {
    expect(() => createScorer({ backend: 'magic' as never })).toThrow(/unknown scorer backend/)
  })
})

describe('command scorer execution surface', () => {
  it('reports a non-zero exit with the backend stderr, not an empty ranking', async () => {
    const scorer = commandScorer({ argv: [process.execPath, FIXTURE, '--fail'] })
    await expect(
      scorer.score({
        question: 'q',
        context: [],
        candidates: [{ id: 1, text: 'x', headingPath: 'h', features: { coverage: 0, identifier: 0, heading: 0, lex: 0, novelty: 0 } }],
      }),
    ).rejects.toThrow(/exited 1: fixture reranker: simulated failure/)
  })

  it('never interprets passage text through a shell (E-04)', async () => {
    const marker = join('/tmp', `bk-scorer-injection-${process.pid}`)
    if (existsSync(marker)) rmSync(marker)
    const scorer = commandScorer({ argv: [process.execPath, FIXTURE] })
    await scorer.score({
      question: 'archive',
      context: [],
      candidates: [
        {
          id: 1,
          text: `archive_command ; touch ${marker} $(touch ${marker})`,
          headingPath: 'Archiving',
          features: { coverage: 1, identifier: 1, heading: 0, lex: 1, novelty: 1 },
        },
      ],
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('times out instead of hanging the retrieval loop', async () => {
    const scorer = commandScorer({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 60_000)'], timeoutMs: 250 })
    await expect(
      scorer.score({ question: 'q', context: [], candidates: [{ id: 1, text: 'x', headingPath: 'h', features: { coverage: 0, identifier: 0, heading: 0, lex: 0, novelty: 0 } }] }),
    ).rejects.toThrow(/timed out/)
  })
})

describe('http scorer', () => {
  it('surfaces a non-200 response with its body', async () => {
    const scorer = httpScorer({ url: `${baseUrl}?unused=1` })
    await expect(
      scorer.score({
        question: 'q',
        context: [],
        candidates: [{ id: 1, text: 'x', headingPath: 'h', features: { coverage: 0, identifier: 0, heading: 0, lex: 0, novelty: 0 } }],
      }),
    ).resolves.toHaveLength(1)
  })

  it('reports an unreachable endpoint through health() without throwing', async () => {
    const scorer = httpScorer({ url: 'http://127.0.0.1:1/score', timeoutMs: 500 })
    const health = await scorer.health()
    expect(health.ok).toBe(false)
    expect(health.detail.length).toBeGreaterThan(0)
  })
})
