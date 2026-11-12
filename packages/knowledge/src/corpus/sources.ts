import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseFrontmatter } from '../text/frontmatter'
import type { CorpusSource } from '../types'

/**
 * Workspace root, discovered rather than assumed.
 *
 * From source (`packages/knowledge/src/corpus/`) it is three levels up; from the
 * esbuild bundle (`dist/bkagent-knowledge.mjs`) it is one. Walking up to the
 * `pnpm-workspace.yaml` marker keeps both entry points on the same paths — a
 * hard-coded `../..` silently pointed the default index at `/home/roy/var`.
 */
function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(startDir, '..')
}

/** `.../code` — the pnpm workspace root. */
export const REPO_ROOT = findRepoRoot(dirname(fileURLToPath(import.meta.url)))
export const PACKAGE_ROOT = join(REPO_ROOT, 'packages', 'knowledge')
export const DEFAULT_CORPUS_DIR = process.env['BK_KNOWLEDGE_CORPUS'] ?? join(REPO_ROOT, 'knowledge-corpus')
export const DEFAULT_DB_PATH = process.env['BK_KNOWLEDGE_DB'] ?? join(REPO_ROOT, 'var', 'knowledge.sqlite')

/**
 * Project documents that are part of the evidence base but are not snapshots:
 * they live where their owners keep them and are read in place, so the index can
 * never silently drift from the document an engineer is editing.
 */
const LOCAL_DOCS: Array<{ sourceId: string; version: string; path: string; title: string }> = [
  {
    sourceId: 'local-plan-v1.0',
    version: 'plan-1.0',
    path: resolve(REPO_ROOT, '../docs/plan-v1.0.md'),
    title: 'backup-agent 方案 v1.0（冻结基线）',
  },
  {
    sourceId: 'local-plan-v1.1',
    version: 'plan-1.1',
    path: resolve(REPO_ROOT, '../docs/plan-v1.1.md'),
    title: 'backup-agent 方案 v1.1',
  },
  {
    sourceId: 'local-failure-catalog',
    version: 'catalog-1.0',
    path: join(REPO_ROOT, 'docs/failure-catalog.md'),
    title: 'PostgreSQL 备份恢复故障模式目录 v1.0',
  },
  {
    sourceId: 'local-failure-evidence',
    version: 'catalog-1.0',
    path: join(REPO_ROOT, 'docs/failure-catalog/evidence-2026-11-11.md'),
    title: '故障目录复现证据 2026-11-11',
  },
]

function readLocalDocs(): CorpusSource[] {
  const sources: CorpusSource[] = []
  for (const doc of LOCAL_DOCS) {
    if (!existsSync(doc.path)) continue
    sources.push({
      origin: 'local',
      tier: 'primary',
      sourceId: doc.sourceId,
      title: doc.title,
      url: doc.path,
      kind: 'md',
      version: doc.version,
      license: 'internal',
      body: readFileSync(doc.path, 'utf8'),
    })
  }
  return sources
}

function readDir(dir: string, origin: 'snapshot' | 'wiki'): CorpusSource[] {
  if (!existsSync(dir)) return []
  const sources: CorpusSource[] = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.md')) continue
    const raw = readFileSync(join(dir, name), 'utf8')
    const { fields, body } = parseFrontmatter(raw)
    sources.push({
      sourceId: fields['source_id'] ?? basename(name, '.md'),
      title: fields['title'] ?? basename(name, '.md'),
      url: fields['url'] ?? '',
      kind: fields['kind'] === 'md' ? 'md' : 'html',
      origin,
      tier: fields['tier'] === 'evidence' ? 'evidence' : 'primary',
      version: fields['version'] ?? 'unknown',
      license: fields['license'] ?? 'unknown',
      fetchedAt: fields['fetched_at'],
      sha256: fields['sha256'],
      body,
    })
  }
  return sources
}

/**
 * `knowledge-corpus/wiki/` holds summaries of llm-wiki articles that belong to the
 * evidence base but are curated elsewhere. They are kept separate from the pinned
 * upstream snapshot so `manifest.json` keeps meaning "what was fetched, when".
 */
function readSnapshot(corpusDir: string): CorpusSource[] {
  return readDir(corpusDir, 'snapshot')
}

function readWikiExports(corpusDir: string): CorpusSource[] {
  return readDir(join(corpusDir, 'wiki'), 'wiki')
}

export function loadSources(corpusDir = DEFAULT_CORPUS_DIR, options: { includeLocalDocs?: boolean } = {}): CorpusSource[] {
  const sources = [...readSnapshot(corpusDir), ...readWikiExports(corpusDir)]
  if (options.includeLocalDocs !== false) sources.push(...readLocalDocs())
  if (sources.length === 0) {
    throw new Error(`no corpus sources found (looked in ${corpusDir} and the project docs)`)
  }
  return sources
}
