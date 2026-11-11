#!/usr/bin/env node
/**
 * Fetches the offline evidence corpus for the PG backup/recovery knowledge base.
 *
 * The corpus is a pinned snapshot: every source records url, version, license
 * and a sha256 over the converted body, so an index can be rebuilt deterministically
 * and each retrieved passage can be traced back to a published document.
 *
 * Sources that fail after two attempts are recorded as `failed` in the manifest and
 * do not abort the run; the rest of the corpus is still usable.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as cheerio from 'cheerio'
import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const CORPUS_DIR = join(PKG_ROOT, '..', '..', 'knowledge-corpus')
const FETCHED_AT = new Date().toISOString().slice(0, 10)

const SOURCES = [
  // PostgreSQL 16 core chapters
  ['pg16-continuous-archiving', 'https://www.postgresql.org/docs/16/continuous-archiving.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'archive_command'],
  ['pg16-backup', 'https://www.postgresql.org/docs/16/backup.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'pg_dump'],
  ['pg16-backup-dump', 'https://www.postgresql.org/docs/16/backup-dump.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'pg_dumpall'],
  ['pg16-app-pgbasebackup', 'https://www.postgresql.org/docs/16/app-pgbasebackup.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'pg_basebackup'],
  ['pg16-app-pgrestore', 'https://www.postgresql.org/docs/16/app-pgrestore.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'pg_restore'],
  ['pg16-app-pgdump', 'https://www.postgresql.org/docs/16/app-pgdump.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'pg_dump'],
  ['pg16-app-pgverifybackup', 'https://www.postgresql.org/docs/16/app-pgverifybackup.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'pg_verifybackup'],
  ['pg16-runtime-config-wal', 'https://www.postgresql.org/docs/16/runtime-config-wal.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'wal_level'],
  ['pg16-wal-internals', 'https://www.postgresql.org/docs/16/wal-internals.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'WAL'],
  ['pg16-monitoring-stats', 'https://www.postgresql.org/docs/16/monitoring-stats.html', 'html', 'pg16', 'PostgreSQL License', '#docContent', 'pg_stat_archiver'],
  // Version deltas for the 14-17 compatibility matrix
  ['pg17-continuous-archiving', 'https://www.postgresql.org/docs/17/continuous-archiving.html', 'html', 'pg17', 'PostgreSQL License', '#docContent', 'archive_command'],
  ['pg15-continuous-archiving', 'https://www.postgresql.org/docs/15/continuous-archiving.html', 'html', 'pg15', 'PostgreSQL License', '#docContent', 'archive_command'],
  ['pg14-continuous-archiving', 'https://www.postgresql.org/docs/14/continuous-archiving.html', 'html', 'pg14', 'PostgreSQL License', '#docContent', 'archive_command'],
  ['pg17-app-pgbasebackup', 'https://www.postgresql.org/docs/17/app-pgbasebackup.html', 'html', 'pg17', 'PostgreSQL License', '#docContent', 'pg_basebackup'],
  // Providers
  ['pgbr-user-guide', 'https://pgbackrest.org/user-guide.html', 'html', 'pgbackrest-2.x', 'MIT', 'body', 'pgbackrest'],
  ['pgbr-command', 'https://pgbackrest.org/command.html', 'html', 'pgbackrest-2.x', 'MIT', 'body', 'archive-push'],
  ['walg-postgresql', 'https://raw.githubusercontent.com/wal-g/wal-g/master/docs/PostgreSQL.md', 'md', 'walg-master', 'Apache-2.0', null, 'WAL-G'],
  ['walg-readme', 'https://raw.githubusercontent.com/wal-g/wal-g/master/docs/README.md', 'md', 'walg-master', 'Apache-2.0', null, 'WAL-G'],
].map(([sourceId, url, kind, version, license, selector, expected]) => ({
  sourceId,
  url,
  kind,
  version,
  license,
  selector,
  expected,
}))

const SCRIPT_STYLE_REMOVE = [
  'script',
  'style',
  'noscript',
  'nav',
  'header',
  'footer',
  'form',
  '#navigation',
  '#pgNavbar',
  '.navheader',
  '.navfooter',
  '.c2c',
  '.code-copy',
  '.toc',
  '#docComments',
  // pgBackRest repeats the section list at the top of every page.
  'div.section1-toc',
  'div.section-toc',
  '.page-toc',
  '.page-header',
]

const NAV_NOISE = /^(prev|up|next|home|legal notice|copyright|documentation|contents?)$/i

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  hr: '---',
})
turndown.use(gfm)
turndown.remove(['script', 'style', 'noscript'])

async function fetchWithRetry(url, attempts = 3) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120_000),
        headers: { 'user-agent': 'backup-agent-knowledge-corpus/0.1 (+offline snapshot)' },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { body: await response.text(), status: response.status }
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 4000 * attempt))
    }
  }
  // raw.githubusercontent.com intermittently rejects undici's connection while plain curl succeeds.
  try {
    const body = execFileSync(
      'curl',
      ['-sSL', '--max-time', '120', '--retry', '2', '-A', 'backup-agent-knowledge-corpus/0.1', url],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    if (body.length > 0) return { body, status: 200 }
  } catch {
    // fall through to the original error
  }
  throw lastError
}

/** Drops the site chrome that survives container selection (link-only nav rows, badges). */
function stripLeadingNav(markdown) {
  const lines = markdown.split('\n')
  let fenced = false
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) fenced = !fenced
    if (!fenced && /^#{1,6}\s/.test(lines[index])) {
      // Only treat an early heading as the end of site chrome; a late one means
      // fence tracking drifted and slicing would destroy real content.
      return index > 0 && index <= 40 ? lines.slice(index).join('\n') : markdown
    }
  }
  return markdown
}

/**
 * Heading anchors (`[#](#RUNTIME-CONFIG-WAL)`) and turndown's identifier escaping
 * (`pg\_basebackup`) both break lexical matching: the anchor pollutes the heading
 * path and the escape splits `pg_basebackup` into two tokens.
 */
function cleanMarkdown(markdown) {
  return markdown
    .replace(/\[#\]\([^)]*\)/g, '')
    .replace(/^#{1,6}\s+.*$/gm, (line) => line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+$/, ''))
    .replace(/\\([_*`[\]()-])/g, '$1')
}

function tidyMarkdown(markdown, kind) {
  const base = kind === 'html' ? stripLeadingNav(markdown) : markdown
  const cleaned = kind === 'html' ? cleanMarkdown(base) : base
  return cleaned
    .split('\n')
    .filter((line) => !NAV_NOISE.test(line.trim()))
    .join('\n')
    .replace(/<\/?[a-z][^>\n]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function htmlToMarkdown(html, selector) {
  const $ = cheerio.load(html)
  for (const target of SCRIPT_STYLE_REMOVE) $(target).remove()

  // pgBackRest expresses hierarchy with <div class="sectionN-title"> instead of
  // h1-h6, so its documents convert to a flat wall of transcripts. Synthesise
  // headings one level deeper (section1 -> h2) so the chunker keeps the path and
  // the document title stays out of it.
  for (let level = 1; level <= 4; level += 1) {
    $(`div.section${level}-title`).each((_, element) => {
      const title = $(element).text().replace(/\s+/g, ' ').trim()
      if (title.length === 0) return
      const heading = $('<h' + String(Math.min(level + 1, 6)) + '></h' + String(Math.min(level + 1, 6)) + '>')
      heading.text(title)
      $(element).before(heading)
    })
  }

  // Turndown only fences `pre > code`; bare <pre> blocks (pgBackRest commands,
  // PostgreSQL programlistings) would otherwise become escaped paragraphs, and a
  // leading `#` comment inside them would then be mistaken for a heading.
  $('div.config-line-list, div.execute-body').each((_, element) => {
    const lines = $(element)
      .find('pre')
      .map((__, pre) => $(pre).text().replace(/\s+$/, ''))
      .get()
      .filter((line) => line.length > 0)
    if (lines.length === 0) return
    $(element).replaceWith($('<pre><code></code></pre>').children('code').text(lines.join('\n')).parent())
  })
  $('pre').each((_, element) => {
    const block = $(element)
    if (block.children('code').length > 0) return
    const text = block.text()
    block.empty().append($('<code></code>').text(text))
  })

  let container = selector ? $(selector) : $('body')
  let text = container.text()
  if (!container.length || text.length < 3000) {
    container = $('body')
    text = container.text()
  }
  const title = $('h1').first().text().trim() || $('title').text().trim()
  return { title, markdown: tidyMarkdown(turndown.turndown(container.html() ?? ''), 'html') }
}

function markdownTitle(markdown) {
  const heading = markdown.split('\n').find((line) => line.startsWith('# '))
  if (heading) return heading.replace(/^#\s+/, '').trim()
  const first = markdown.split('\n').find((line) => line.trim().length > 0)
  return (first ?? 'untitled').trim().slice(0, 120)
}

function frontmatter(entry, title, body) {
  const sha256 = createHash('sha256').update(body, 'utf8').digest('hex')
  const lines = [
    '---',
    `source_id: ${entry.sourceId}`,
    `title: ${title.replace(/\s+/g, ' ')}`,
    `url: ${entry.url}`,
    `kind: ${entry.kind}`,
    `version: ${entry.version}`,
    `license: ${entry.license}`,
    `fetched_at: ${FETCHED_AT}`,
    `sha256: ${sha256}`,
    `chars: ${body.length}`,
    '---',
    '',
  ]
  return { text: `${lines.join('\n')}${body}\n`, sha256 }
}

async function main() {
  mkdirSync(CORPUS_DIR, { recursive: true })
  const manifest = { generated_at: new Date().toISOString(), sources: [] }
  let ok = 0

  for (const entry of SOURCES) {
    const record = {
      source_id: entry.sourceId,
      url: entry.url,
      kind: entry.kind,
      version: entry.version,
      license: entry.license,
      status: 'failed',
      http_status: null,
      bytes: 0,
      chars: 0,
      sha256: null,
      expected_keyword_found: false,
      error: null,
    }
    try {
      const { body: raw, status } = await fetchWithRetry(entry.url)
      record.http_status = status
      record.bytes = Buffer.byteLength(raw, 'utf8')

      const converted =
        entry.kind === 'md'
          ? { title: markdownTitle(raw), markdown: raw.trim() }
          : htmlToMarkdown(raw, entry.selector)

      const body = converted.markdown
      if (body.length < 3000) throw new Error(`converted body too short (${body.length} chars)`)

      const rendered = frontmatter(entry, converted.title, body)
      writeFileSync(join(CORPUS_DIR, `${entry.sourceId}.md`), rendered.text, 'utf8')

      record.status = 'ok'
      record.chars = body.length
      record.sha256 = rendered.sha256
      record.expected_keyword_found = body.toLowerCase().includes(entry.expected.toLowerCase())
      ok += 1
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
    }
    manifest.sources.push(record)
    console.log(
      [
        entry.sourceId.padEnd(30),
        record.status.padEnd(7),
        String(record.chars).padStart(8),
        record.sha256 ? record.sha256.slice(0, 12) : '-'.repeat(12),
        record.expected_keyword_found ? 'keyword:ok' : 'keyword:MISSING',
        record.error ?? '',
      ].join('  '),
    )
  }

  writeFileSync(join(CORPUS_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const total = manifest.sources.reduce((sum, source) => sum + source.chars, 0)
  console.log(`\ncorpus: ${ok}/${SOURCES.length} sources ok, ${total} chars -> ${CORPUS_DIR}`)
  if (ok === 0) process.exitCode = 1
}

await main()
