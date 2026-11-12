#!/usr/bin/env node
/**
 * Evidence scorer shim for an OpenAI-compatible chat model.
 *
 * This is the "JEV slot": SAG2 scores every candidate passage with a semantic
 * judge before the next expansion round. The paper uses `typesafe/jev-1.13`
 * through a decisions API; every provider reachable here speaks chat
 * completions instead, so the shim turns one batch into one prompt and parses
 * the scores back into the Scorer contract.
 *
 * Contract (stdin → stdout):
 *   {"question": "...", "context": ["term", ...],
 *    "candidates": [{"id": 1, "text": "...", "headingPath": "..."}, ...]}
 *   → {"scores": [0.9, 0.2, ...]}      // one per candidate, input order
 *
 * Configuration (environment only — never argv, never logs):
 *   BK_SCORER_BASE_URL   e.g. http://llm-gw.i2yun.com/v1
 *   BK_SCORER_MODEL      e.g. qwen
 *   BK_SCORER_API_KEY    bearer token (or BK_SCORER_KEY_ENV naming another var)
 *   BK_SCORER_BATCH      candidates per request (default 12)
 *   BK_SCORER_CONCURRENCY parallel requests (default 4)
 *   BK_SCORER_TIMEOUT_MS per request (default 60000)
 *   BK_SCORER_SESSION   optional value for x-opencode-session (OpenCode Go routing)
 *
 * Exit codes: 0 ok, 2 bad input/configuration, 3 the model answered but the
 * response could not be trusted (missing ids, unparseable). A partial answer is
 * never turned into a silent zero: a wrong ranking is worse than a loud failure.
 */
const MAX_PASSAGE_CHARS = 900

function fail(code, message) {
  process.stderr.write(`rerank-llm: ${message}\n`)
  process.exit(code)
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      raw += chunk
    })
    process.stdin.on('end', () => resolve(raw))
  })
}

const SYSTEM_PROMPT = [
  'You judge retrieval evidence for a PostgreSQL backup and recovery knowledge base.',
  'For every passage, score how much it supplies evidence NECESSARY to answer the question,',
  'given the context already gathered by earlier rounds.',
  '1.0 = directly answers or supplies the mechanism; 0.5 = related but insufficient;',
  '0.0 = unrelated or merely repeats the context.',
  'Reply with JSON only, no prose: {"scores":[{"id":<passage id>,"score":<0..1>}]}',
  'Include every passage id exactly once.',
].join(' ')

function buildUserPrompt(question, context, batch) {
  const lines = [`Question: ${question}`]
  if (context.length > 0) lines.push(`Already covered terms: ${context.join(', ')}`)
  lines.push('', 'Passages:')
  for (const candidate of batch) {
    const text = String(candidate.text ?? '').replace(/\s+/g, ' ').slice(0, MAX_PASSAGE_CHARS)
    lines.push(`${candidate.id} | ${candidate.headingPath || '(no heading)'} | ${text}`)
  }
  return lines.join('\n')
}

function parseScores(content, expectedIds) {
  const cleaned = String(content ?? '')
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim()
  const start = Math.min(...[cleaned.indexOf('{'), cleaned.indexOf('[')].filter((index) => index >= 0))
  if (!Number.isFinite(start)) return null
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'))
  if (end <= start) return null

  let parsed
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }

  const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed.scores) ? parsed.scores : null
  if (!entries) return null

  const byId = new Map()
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const id = Number(entry.id)
    const score = Number(entry.score)
    if (!Number.isFinite(id) || !Number.isFinite(score)) continue
    byId.set(id, Math.min(1, Math.max(0, score)))
  }

  // Trust requires coverage: a missing id would silently become the worst rank.
  const missing = expectedIds.filter((id) => !byId.has(id))
  if (missing.length > 0) return { incomplete: missing }
  return { scores: expectedIds.map((id) => byId.get(id)) }
}

async function requestScores(baseUrl, model, apiKey, body, timeoutMs) {
  const attempt = async (withJsonMode) => {
    const payload = {
      model,
      temperature: 0,
      max_tokens: Math.min(4000, 120 + body.length * 12),
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(body.question, body.context ?? [], body.candidates) },
      ],
      ...(withJsonMode ? { response_format: { type: 'json_object' } } : {}),
    }
    return await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'user-agent': 'backup-agent-knowledge/0.1',
        ...(process.env.BK_SCORER_SESSION ? { 'x-opencode-session': process.env.BK_SCORER_SESSION } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  let response
  try {
    response = await attempt(true)
  } catch (error) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined
    const detail = cause && typeof cause === 'object' ? [cause.code, cause.message].filter(Boolean).join(' ') : ''
    throw new Error(`request failed: ${error instanceof Error ? error.message : String(error)}${detail ? ` (${detail})` : ''}`)
  }
  if (response.status === 400 || response.status === 422) {
    // Some gateways reject response_format; the parser handles prose-wrapped JSON.
    response = await attempt(false)
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`HTTP ${response.status}: ${detail}`)
  }
  const json = await response.json()
  return json?.choices?.[0]?.message?.content ?? ''
}

async function main() {
  const raw = await readStdin()
  let request
  try {
    request = JSON.parse(raw.length === 0 ? '{}' : raw)
  } catch {
    fail(2, 'stdin is not valid JSON')
  }

  const candidates = Array.isArray(request.candidates) ? request.candidates : []
  if (candidates.length === 0) {
    // Health probe: answer without spending a request.
    process.stdout.write(JSON.stringify({ model: process.env.BK_SCORER_MODEL ?? 'unset', scores: [] }))
    return
  }

  const baseUrl = process.env.BK_SCORER_BASE_URL ?? ''
  const model = process.env.BK_SCORER_MODEL ?? ''
  const keyEnv = process.env.BK_SCORER_KEY_ENV ?? ''
  const apiKey = process.env.BK_SCORER_API_KEY ?? (keyEnv ? process.env[keyEnv] : '') ?? ''
  if (!baseUrl) fail(2, 'BK_SCORER_BASE_URL is not set')
  if (!model) fail(2, 'BK_SCORER_MODEL is not set')
  if (!apiKey) fail(2, 'no API key: set BK_SCORER_API_KEY or BK_SCORER_KEY_ENV')

  const batchSize = Math.max(1, Number(process.env.BK_SCORER_BATCH ?? 12))
  const concurrency = Math.max(1, Number(process.env.BK_SCORER_CONCURRENCY ?? 4))
  const timeoutMs = Math.max(1000, Number(process.env.BK_SCORER_TIMEOUT_MS ?? 60_000))

  const batches = []
  for (let index = 0; index < candidates.length; index += batchSize) {
    batches.push(candidates.slice(index, index + batchSize))
  }

  const results = new Map()
  let cursor = 0
  const errors = []

  /**
   * A model that drops an id would silently rank that passage last. Ask again for
   * only the missing ones, at most twice, then fail loudly.
   */
  async function scoreBatch(batch) {
    let pending = batch
    for (let attempt = 0; attempt < 3 && pending.length > 0; attempt += 1) {
      const ids = pending.map((candidate) => Number(candidate.id))
      let content = ''
      let lastError
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          content = await requestScores(baseUrl, model, apiKey, {
            question: request.question,
            context: request.context,
            candidates: pending,
          }, timeoutMs)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          // Transport failures and gateway hiccups are worth one more try; a bad
          // configuration would fail identically, and the loud exit still applies.
          await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
        }
      }
      if (lastError) throw lastError
      const parsed = parseScores(content, ids)
      if (!parsed) {
        throw new Error(`unparseable response: ${String(content).slice(0, 160)}`)
      }
      if (!parsed.incomplete) {
        parsed.scores.forEach((score, offset) => results.set(ids[offset], score))
        return
      }
      // Recover the ids that did arrive, then retry only the remainder.
      const returned = new Set(ids.filter((id) => !parsed.incomplete.includes(id)))
      if (parsed.scores) {
        parsed.scores.forEach((score, offset) => {
          const id = ids[offset]
          if (returned.has(id)) results.set(id, score)
        })
      }
      pending = pending.filter((candidate) => parsed.incomplete.includes(Number(candidate.id)))
    }
    if (pending.length > 0) {
      throw new Error(`missing ids after retries: ${pending.map((candidate) => candidate.id).join(',')}`)
    }
  }

  async function worker() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= batches.length) return
      const batch = batches[index]
      try {
        await scoreBatch(batch)
      } catch (error) {
        errors.push(`batch ${index}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()))

  if (errors.length > 0) {
    fail(3, `model responses were not trustworthy (${errors.length}/${batches.length} batches): ${errors.slice(0, 3).join(' | ')}`)
  }

  const scores = candidates.map((candidate) => results.get(Number(candidate.id)) ?? 0)
  process.stdout.write(JSON.stringify({ model, scores }))
}

await main()
