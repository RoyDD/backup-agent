#!/usr/bin/env node
/**
 * Fixture reranker for the Scorer contract suite.
 *
 * Speaks the same JSON contract a real local model shim would: one request on
 * stdin, `{scores}` on stdout. `--fail` simulates a broken backend.
 */
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  raw += chunk
})
process.stdin.on('end', () => {
  const flags = process.argv.slice(2)
  if (flags.includes('--fail')) {
    process.stderr.write('fixture reranker: simulated failure\n')
    process.exit(1)
  }
  let request = { question: '', candidates: [] }
  try {
    request = JSON.parse(raw.length === 0 ? '{}' : raw)
  } catch {
    process.stderr.write('fixture reranker: bad json\n')
    process.exit(2)
  }
  const words = String(request.question ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const candidates = Array.isArray(request.candidates) ? request.candidates : []
  const scores = candidates.map((candidate) => {
    const text = String(candidate.text ?? '').toLowerCase()
    if (words.length === 0) return 0
    let hits = 0
    for (const word of words) if (text.includes(word)) hits += 1
    return hits / words.length
  })
  process.stdout.write(JSON.stringify({ model: 'fixture-1', scores }))
})
