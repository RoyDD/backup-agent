#!/usr/bin/env node
/**
 * bkagent knowledge — evidence retrieval over the PG backup/recovery corpus.
 *
 * Every command is deterministic and offline: no embeddings, no model calls.
 * `ask` returns passages, never an answer; interpretation belongs to the agent
 * layer, which keeps this package free of business semantics.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { PACKAGE_ROOT, buildIndex, openIndex, readMeta, DEFAULT_DB_PATH, DEFAULT_CORPUS_DIR } from './index'
import type { BuildStats } from './index'
import { runPipeline, type RetrievalMode } from './retrieval/pipeline'
import { loadQuestions, runEval } from './eval/run'

const USAGE = `bkagent knowledge — PostgreSQL backup/recovery evidence base

Usage:
  bkagent knowledge index [--db <path>] [--corpus <dir>] [--json]
  bkagent knowledge ask <question> [--k N] [--db <path>] [--json] [--source <id>]...
                                  [--expand aliases|none] [--mode bm25|sag2|expand-only]
                                  [--rounds N] [--seed-k N] [--terms N] [--diversify on|off]
  bkagent knowledge eval [--questions <path>] [--k N] [--db <path>] [--json <out>]
                         [--expand aliases|none] [--mode bm25|sag2|expand-only] [--rounds N]
                         [--seed-k N] [--terms N] [--diversify on|off]
  bkagent knowledge stats [--db <path>]
`

function formatStats(stats: BuildStats): string {
  return [
    `indexed   ${stats.passages} passages from ${stats.sources} sources`,
    `text      ${stats.chars} chars (${(stats.chars / 1024).toFixed(0)} KiB)`,
    `database  ${stats.dbPath} (${(stats.bytes / 1024).toFixed(0)} KiB)`,
    `build     ${stats.ms} ms`,
  ].join('\n')
}

function commandIndex(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      corpus: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  const stats = buildIndex({
    dbPath: values.db ?? DEFAULT_DB_PATH,
    corpusDir: values.corpus ?? DEFAULT_CORPUS_DIR,
  })
  process.stdout.write(values.json ? `${JSON.stringify(stats, null, 2)}\n` : `${formatStats(stats)}\n`)
  return 0
}

function commandAsk(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      k: { type: 'string', default: '10' },
      json: { type: 'boolean', default: false },
      source: { type: 'string', multiple: true },
      expand: { type: 'string', default: 'aliases' },
      mode: { type: 'string', default: 'sag2' },
      rounds: { type: 'string' },
      'seed-k': { type: 'string' },
      terms: { type: 'string' },
      diversify: { type: 'string', default: 'off' },
    },
  })
  const question = positionals.join(' ').trim()
  if (question.length === 0) {
    process.stderr.write('error: missing question\n')
    return 2
  }

  const db = openIndex(values.db ?? DEFAULT_DB_PATH)
  try {
    const { hits, trace } = runPipeline(db, question, {
      k: Number(values.k),
      ...(values.source ? { sources: values.source } : {}),
      expandAliases: values.expand !== 'none',
      mode: values.mode as RetrievalMode,
      ...(values.rounds ? { rounds: Number(values.rounds) } : {}),
      ...(values['seed-k'] ? { seedK: Number(values['seed-k']) } : {}),
      ...(values.terms ? { termsPerRound: Number(values.terms) } : {}),
      diversify: values.diversify === 'on',
    })
    if (values.json) {
      process.stdout.write(`${JSON.stringify({ question, hits, trace }, null, 2)}\n`)
      return 0
    }
    process.stdout.write(
      `mode ${trace.mode} · rounds ${trace.rounds} · candidates ${trace.candidates} · ${trace.ms} ms\n`,
    )
    if (hits.length === 0) {
      process.stdout.write('no evidence found\n')
      return 0
    }
    hits.forEach((hit, index) => {
      const preview = hit.text.replace(/\s+/g, ' ').slice(0, 220)
      process.stdout.write(
        `${String(index + 1).padStart(2)}. ${hit.sourceId}#${hit.ordinal} [${hit.version}] ${hit.headingPath}\n` +
          `    score ${hit.score.toFixed(3)} · ${preview}\n`,
      )
    })
    return 0
  } finally {
    db.close()
  }
}

function commandEval(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      questions: { type: 'string', default: join(PACKAGE_ROOT, 'eval', 'questions.jsonl') },
      k: { type: 'string', default: '10' },
      json: { type: 'string' },
      expand: { type: 'string', default: 'aliases' },
      mode: { type: 'string', default: 'sag2' },
      rounds: { type: 'string' },
      'seed-k': { type: 'string' },
      terms: { type: 'string' },
      diversify: { type: 'string', default: 'off' },
    },
  })

  const db = openIndex(values.db ?? DEFAULT_DB_PATH)
  try {
    const total = loadQuestions(values.questions).length
    const { summary, results } = runEval(db, {
      questionsPath: values.questions,
      k: Number(values.k),
      expand: values.expand !== 'none',
      mode: values.mode as RetrievalMode,
      ...(values.rounds ? { rounds: Number(values.rounds) } : {}),
      ...(values['seed-k'] ? { seedK: Number(values['seed-k']) } : {}),
      ...(values.terms ? { termsPerRound: Number(values.terms) } : {}),
      diversify: values.diversify === 'on',
    })

    const pct = (value: number): string => `${(value * 100).toFixed(2)}%`
    const lines = [
      `questions ${summary.questions} (${total} loaded)`,
      `unresolved gold refs ${summary.unresolvedGold.length}`,
      `retrieval ${String(summary.settings['retrieval'])} · rounds ${String(summary.settings['rounds'])} · ` +
        `expand ${String(summary.settings['expand'])} · diversify ${String(summary.settings['diversify'])}`,
      `latency mean ${summary.latency.mean.toFixed(1)} ms · p50 ${summary.latency.p50} ms · p95 ${summary.latency.p95} ms`,
      `R@1 ${pct(summary.recallAt['1'] ?? 0)}  R@2 ${pct(summary.recallAt['2'] ?? 0)}  ` +
        `R@5 ${pct(summary.recallAt['5'] ?? 0)}  R@10 ${pct(summary.recallAt['10'] ?? 0)}  MRR@10 ${summary.mrrAt10.toFixed(4)}`,
      '',
    ]
    for (const [kind, value] of Object.entries(summary.byKind)) {
      lines.push(
        `${kind.padEnd(12)} n=${String(value.questions).padStart(3)}  ` +
          `R@5 ${pct(value.recallAt['5'] ?? 0)}  R@10 ${pct(value.recallAt['10'] ?? 0)}`,
      )
    }
    lines.push('')
    for (const [lang, value] of Object.entries(summary.byLang)) {
      lines.push(
        `lang ${lang.padEnd(4)}    n=${String(value.questions).padStart(3)}  ` +
          `R@5 ${pct(value.recallAt['5'] ?? 0)}  R@10 ${pct(value.recallAt['10'] ?? 0)}`,
      )
    }
    if (summary.unresolvedGold.length > 0) {
      lines.push('', 'unresolved:')
      for (const entry of summary.unresolvedGold.slice(0, 10)) {
        const detail = [entry.ref.heading, entry.ref.contains, entry.ref.passage].filter(Boolean).join(' :: ')
        lines.push(`  ${entry.id} -> ${entry.ref.source} :: ${detail}`)
      }
    }
    process.stdout.write(`${lines.join('\n')}\n`)

    if (values.json) {
      mkdirSync(dirname(values.json), { recursive: true })
      writeFileSync(values.json, `${JSON.stringify({ summary, results }, null, 2)}\n`, 'utf8')
      process.stdout.write(`\nwritten ${values.json}\n`)
    }
    return summary.unresolvedGold.length > 0 ? 1 : 0
  } finally {
    db.close()
  }
}

function commandStats(args: string[]): number {
  const { values } = parseArgs({ args, options: { db: { type: 'string' } } })
  const db = openIndex(values.db ?? DEFAULT_DB_PATH)
  try {
    const meta = readMeta(db)
    const rows = db
      .prepare('SELECT source_id, version, count(*) AS passages, sum(chars) AS chars FROM passage GROUP BY source_id, version ORDER BY source_id')
      .all() as Array<{ source_id: string; version: string; passages: number; chars: number }>
    const lines = [Object.entries(meta).map(([key, value]) => `${key}=${value}`).join('  '), '']
    for (const row of rows) {
      lines.push(`${row.source_id.padEnd(30)} ${row.version.padEnd(14)} ${String(row.passages).padStart(5)} passages  ${row.chars} chars`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  } finally {
    db.close()
  }
}

export function runKnowledgeCli(argv: string[]): number {
  const [command, ...rest] = argv
  switch (command) {
    case 'index':
      return commandIndex(rest)
    case 'ask':
      return commandAsk(rest)
    case 'eval':
      return commandEval(rest)
    case 'stats':
      return commandStats(rest)
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE)
      return 0
    default:
      process.stderr.write(`error: unknown command "${command}"\n\n${USAGE}`)
      return 2
  }
}
