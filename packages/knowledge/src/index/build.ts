import { mkdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { chunkSource } from '../corpus/chunk'
import { DEFAULT_CORPUS_DIR, DEFAULT_DB_PATH, loadSources } from '../corpus/sources'
import { tokenString } from '../text/tokenize'

export const SCHEMA_VERSION = '3'
/** Bumped whenever chunking changes, because it changes passage boundaries and scores. */
export const CHUNK_POLICY = 'section/2200/table-row-split/v1'

export interface BuildStats {
  dbPath: string
  sources: number
  passages: number
  chars: number
  bytes: number
  ms: number
}

export interface BuildOptions {
  dbPath?: string
  corpusDir?: string
  /** Keep an existing database instead of rebuilding it. Default: rebuild. */
  reuse?: boolean
  /** Index the project documents (plan, failure catalog) alongside the snapshot. Default: true. */
  includeLocalDocs?: boolean
}

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE passage(
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  version TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  chars INTEGER NOT NULL,
  tier TEXT NOT NULL DEFAULT 'primary'
);
CREATE INDEX passage_source ON passage(source_id, ordinal);
CREATE TABLE term_df(term TEXT PRIMARY KEY, df INTEGER NOT NULL);
CREATE VIRTUAL TABLE passage_fts USING fts5(
  heading_path,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`

function removeDatabase(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`
    if (existsSync(target)) rmSync(target)
  }
}

export function buildIndex(options: BuildOptions = {}): BuildStats {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH
  const corpusDir = options.corpusDir ?? DEFAULT_CORPUS_DIR
  const started = Date.now()

  if (!options.reuse) removeDatabase(dbPath)
  mkdirSync(dirname(dbPath), { recursive: true })

  const sources = loadSources(corpusDir, { includeLocalDocs: options.includeLocalDocs })
  const chunks = sources.flatMap((source) => chunkSource(source))

  const db = new DatabaseSync(dbPath)
  try {
    db.exec(SCHEMA)
    db.exec('BEGIN')
    const insertPassage = db.prepare(
      'INSERT INTO passage(id, source_id, version, heading_path, ordinal, text, chars, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const insertFts = db.prepare('INSERT INTO passage_fts(rowid, heading_path, body) VALUES (?, ?, ?)')
    const insertTerm = db.prepare('INSERT INTO term_df(term, df) VALUES (?, ?)')
    const insertMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)')

    let totalChars = 0
    const documentFrequency = new Map<string, number>()
    chunks.forEach((chunk, index) => {
      const id = index + 1
      totalChars += chunk.chars
      const bodyTokens = tokenString(chunk.text)
      insertPassage.run(
        id,
        chunk.sourceId,
        chunk.version,
        chunk.headingPath,
        chunk.ordinal,
        chunk.text,
        chunk.chars,
        chunk.tier ?? 'primary',
      )
      insertFts.run(id, tokenString(chunk.headingPath), bodyTokens)
      // Distinct-per-passage counts, which is exactly what idf needs.
      for (const token of new Set(bodyTokens.split(' '))) {
        if (token.length === 0) continue
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
      }
    })
    for (const [term, df] of documentFrequency) insertTerm.run(term, df)

    const meta: Array<[string, string]> = [
      ['schema_version', SCHEMA_VERSION],
      ['chunk_policy', CHUNK_POLICY],
      ['bm25_weights', 'heading_path=2.0,body=1.0'],
      ['tokenizer', 'ascii-word + cjk-unigram-bigram'],
      ['built_at', new Date().toISOString()],
      ['sources', String(sources.length)],
      ['passages', String(chunks.length)],
      ['chars', String(totalChars)],
      ['corpus_dir', corpusDir],
    ]
    for (const [key, value] of meta) insertMeta.run(key, value)

    db.exec('COMMIT')
  } finally {
    db.close()
  }

  return {
    dbPath,
    sources: sources.length,
    passages: chunks.length,
    chars: chunks.reduce((sum, chunk) => sum + chunk.chars, 0),
    bytes: statSync(dbPath).size,
    ms: Date.now() - started,
  }
}

export function openIndex(dbPath = DEFAULT_DB_PATH): DatabaseSync {
  if (!existsSync(dbPath)) {
    throw new Error(`knowledge index missing at ${dbPath}; run \`bkagent knowledge index\` first`)
  }
  return new DatabaseSync(dbPath, { readOnly: true })
}

export function readMeta(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>
  const result: Record<string, string> = {}
  for (const row of rows) result[row.key] = row.value
  return result
}
