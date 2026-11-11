/**
 * Tokenization for a mixed English/Chinese corpus.
 *
 * FTS5's `unicode61` tokenizer splits on non-alphanumerics, so a run of Chinese
 * characters becomes one giant token and Chinese queries never match. We index a
 * *token string* instead of raw text: ASCII identifiers stay whole, and CJK runs
 * are exploded into unigrams + bigrams. Queries are tokenized the same way, which
 * keeps the index and the query symmetric.
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/
const WORD = /[a-z0-9_]+(?:[.\-/][a-z0-9_]+)*/g

/** Identifier-ish words that carry no retrieval signal on their own. */
const ASCII_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'by',
  'as', 'at', 'it', 'this', 'that', 'with', 'from', 'not', 'but', 'if', 'then', 'than',
])

const CJK_STOPWORDS = new Set(['的', '了', '是', '在', '和', '与', '或', '对', '把', '被', '了', '着', '过', '吗', '呢', '什', '么'])

export function tokenize(input: string): string[] {
  const text = input.toLowerCase()
  const tokens: string[] = []
  let index = 0

  while (index < text.length) {
    const char = text.charAt(index)

    if (CJK.test(char)) {
      let end = index
      while (end < text.length && CJK.test(text.charAt(end))) end += 1
      const run = text.slice(index, end)
      for (let offset = 0; offset < run.length; offset += 1) {
        const unigram = run.charAt(offset)
        if (!CJK_STOPWORDS.has(unigram)) tokens.push(unigram)
      }
      for (let offset = 0; offset + 1 < run.length; offset += 1) {
        const bigram = run.slice(offset, offset + 2)
        if (!CJK_STOPWORDS.has(bigram)) tokens.push(bigram)
      }
      index = end
      continue
    }

    WORD.lastIndex = index
    const match = WORD.exec(text)
    if (match && match.index === index) {
      const word = match[0]
      if (word.length > 1 && !ASCII_STOPWORDS.has(word)) tokens.push(word)
      index += word.length
      continue
    }

    index += 1
  }

  return tokens
}

/** Token stream rendered for an FTS5 column. */
export function tokenString(input: string): string {
  return tokenize(input).join(' ')
}

/** FTS5 MATCH expression: every distinct token OR-ed, each one quoted. */
export function toMatchQuery(input: string, maxTerms = 96): string {
  const seen = new Set<string>()
  for (const token of tokenize(input)) {
    if (seen.size >= maxTerms) break
    // A single quote would break out of the quoted term; FTS5 has no escape
    // character, so drop it rather than risk a syntax error.
    if (token.includes("'")) continue
    seen.add(token)
  }
  return [...seen].map((token) => `"${token}"`).join(' OR ')
}
