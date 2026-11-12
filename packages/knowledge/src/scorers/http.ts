import {
  assertScores,
  type ScorerHealth,
  type ScorerPort,
  type ScorerRequest,
} from '../ports/scorer'

/**
 * Generic HTTP reranker.
 *
 * The payload is this package's own batch contract:
 *   POST {question, context, candidates:[{id, text, headingPath}]}
 *   →    {scores: [number, ...]}
 *
 * SAG2's JEV is served through this backend via a thin adapter: the paper's
 * service has its own request schema, and asserting a shape we cannot verify
 * here would be worse than documenting the seam. Credentials come from an
 * environment variable named by config, never from argv (ADR-006 / secretRef).
 */
export interface HttpScorerOptions {
  url: string
  model?: string
  apiKeyEnv?: string
  timeoutMs?: number
  headers?: Record<string, string>
}

export function httpScorer(options: HttpScorerOptions): ScorerPort {
  const timeoutMs = options.timeoutMs ?? 30_000

  function headers(): Record<string, string> {
    const result: Record<string, string> = { 'content-type': 'application/json', ...options.headers }
    if (options.apiKeyEnv) {
      const key = process.env[options.apiKeyEnv]
      if (key === undefined || key.length === 0) {
        throw new Error(`http scorer: environment variable ${options.apiKeyEnv} is empty`)
      }
      result.authorization = `Bearer ${key}`
    }
    return result
  }

  async function post(body: unknown): Promise<Response> {
    return await fetch(options.url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  return {
    id: `http:${options.url}`,
    async score(request: ScorerRequest): Promise<number[]> {
      if (!options.url) throw new Error('http scorer needs --scorer-url')
      const response = await post({
        ...(options.model ? { model: options.model } : {}),
        question: request.question,
        context: request.context,
        candidates: request.candidates.map((candidate) => ({
          id: candidate.id,
          text: candidate.text,
          headingPath: candidate.headingPath,
        })),
      })
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300)
        throw new Error(`http scorer returned ${response.status}: ${detail}`)
      }
      const parsed = (await response.json()) as { scores?: unknown }
      return assertScores(parsed.scores, request.candidates.length, 'http')
    },
    async health(): Promise<ScorerHealth> {
      if (!options.url) return { ok: false, detail: 'no --scorer-url configured' }
      try {
        const response = await post({ question: '', context: [], candidates: [] })
        if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
        const parsed = (await response.json()) as { scores?: unknown; model?: string }
        assertScores(parsed.scores, 0, 'http')
        return { ok: true, detail: `ready${parsed.model ? ` (${parsed.model})` : ''}` }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
