/**
 * Markdown → passages.
 *
 * Shapes borrowed from SAG2: a target of ~2200 UTF-16 units, sentence-ish
 * boundaries, and the heading path carried into the passage text so lexical
 * retrieval can match section titles ("Point-in-Time Recovery") as well as body
 * words. One domain addition: a long table is emitted row-by-row, because in the
 * failure catalog one row *is* the event (trigger → observable signature →
 * precheck rule), and merging 11 rows into one passage hides eight of them.
 */

import type { Chunk, CorpusSource } from '../types'

export const TARGET_CHARS = 2200
const FLUSH_MIN_CHARS = 400
const MIN_TABLE_ROWS = 8
const MIN_PASSAGE_CHARS = 40

interface TableBlock {
  kind: 'table'
  rows: string[][]
}

interface TextBlock {
  kind: 'para' | 'code'
  text: string
}

type Block = TableBlock | TextBlock

interface Section {
  headingPath: string
  level: number
  blocks: Block[]
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE = /^\s*(```|~~~)/
const TABLE_ROW = /^\s*\|/

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed.charAt(index)
    if (char === '\\' && trimmed.charAt(index + 1) === '|') {
      current += '|'
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

const TABLE_SEPARATOR = /^\s*\|?[\s:|-]+\|[\s:|-]*$/

function parseSections(markdown: string): Section[] {
  const lines = markdown.split('\n')
  const sections: Section[] = [{ headingPath: '', level: 0, blocks: [] }]
  const stack: Array<{ level: number; title: string }> = []
  let index = 0

  const currentSection = (): Section => sections[sections.length - 1] as Section
  // A blank line closes the current paragraph: without this a whole section would
  // merge into one block and the 2200-char flush would never fire.
  let paragraphBreak = true
  const pushParagraph = (text: string): void => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    const section = currentSection()
    const last = section.blocks[section.blocks.length - 1]
    if (last && last.kind === 'para' && !paragraphBreak) last.text = `${last.text}\n${trimmed}`
    else section.blocks.push({ kind: 'para', text: trimmed })
    paragraphBreak = false
  }

  while (index < lines.length) {
    const line = lines[index] as string

    if (FENCE.test(line)) {
      const fence = line.trim().slice(0, 3)
      const buffer: string[] = [line]
      index += 1
      while (index < lines.length) {
        const inner = lines[index] as string
        buffer.push(inner)
        index += 1
        if (inner.trim().startsWith(fence)) break
      }
      currentSection().blocks.push({ kind: 'code', text: buffer.join('\n') })
      paragraphBreak = true
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      const level = (heading[1] as string).length
      const title = (heading[2] as string).trim()
      while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level) stack.pop()
      stack.push({ level, title })
      const headingPath = stack
        .filter((entry) => entry.level > 1)
        .map((entry) => entry.title)
        .join(' > ')
      sections.push({ headingPath: headingPath.length > 0 ? headingPath : title, level, blocks: [] })
      paragraphBreak = true
      index += 1
      continue
    }

    if (TABLE_ROW.test(line)) {
      const rows: string[][] = []
      while (index < lines.length && TABLE_ROW.test(lines[index] as string)) {
        const raw = lines[index] as string
        index += 1
        if (TABLE_SEPARATOR.test(raw) && !/[a-z0-9\u4e00-\u9fff]/i.test(raw)) continue
        rows.push(splitTableRow(raw))
      }
      currentSection().blocks.push({ kind: 'table', rows })
      paragraphBreak = true
      continue
    }

    if (line.trim().length === 0) {
      paragraphBreak = true
      index += 1
      continue
    }

    pushParagraph(line)
    index += 1
  }

  return sections.filter((section) => section.blocks.length > 0)
}

function noUnchecked<T>(value: T | undefined): T | undefined {
  return value
}

function tableRowPassage(section: Section, rows: string[], header: string[]): string {
  const fields: string[] = []
  for (let index = 0; index < rows.length; index += 1) {
    const cell = noUnchecked(rows[index])
    if (!cell || cell.length === 0) continue
    const label = noUnchecked(header[index])
    fields.push(label && label.length > 0 ? `${label}: ${cell}` : cell)
  }
  const body = fields.join('; ')
  return section.headingPath.length > 0 ? `${section.headingPath}\n${body}` : body
}

export function chunkSource(source: CorpusSource): Chunk[] {
  const chunks: Chunk[] = []
  let ordinal = 0

  const emit = (headingPath: string, text: string): void => {
    const body = text.trim()
    if (body.length < MIN_PASSAGE_CHARS) return
    chunks.push({
      tier: source.tier ?? 'primary',
      sourceId: source.sourceId,
      version: source.version,
      headingPath,
      ordinal,
      text: body,
      chars: body.length,
    })
    ordinal += 1
  }

  for (const section of parseSections(source.body)) {
    let buffer: string[] = []
    let bufferChars = 0
    const flush = (): void => {
      if (buffer.length === 0) return
      emit(section.headingPath, buffer.join('\n\n'))
      buffer = []
      bufferChars = 0
    }

    for (const block of section.blocks) {
      if (block.kind === 'table') {
        flush()
        const [header, ...rows] = block.rows
        if (!header || rows.length < MIN_TABLE_ROWS) {
          // Short tables stay inline: splitting a 3-row table loses more context than it gains.
          const rendered = block.rows.map((row) => `| ${row.join(' | ')} |`).join('\n')
          emit(section.headingPath, rendered)
          continue
        }
        for (const row of rows) {
          emit(section.headingPath, tableRowPassage(section, row, header))
        }
        continue
      }

      if (bufferChars + block.text.length > TARGET_CHARS && bufferChars >= FLUSH_MIN_CHARS) flush()
      buffer.push(block.text)
      bufferChars += block.text.length
    }

    flush()
  }

  return chunks
}
