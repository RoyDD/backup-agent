/**
 * Minimal YAML frontmatter reader for corpus files. Only flat `key: value`
 * scalars are supported, which is all the corpus snapshot uses; anything more
 * elaborate belongs in the manifest, not in the passage body.
 */

export interface Frontmatter {
  fields: Record<string, string>
  body: string
}

export function parseFrontmatter(raw: string): Frontmatter {
  if (!raw.startsWith('---')) return { fields: {}, body: raw }

  const lines = raw.split('\n')
  const fields: Record<string, string> = {}
  let end = -1

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line.trim() === '---') {
      end = index
      break
    }
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (key.length > 0) fields[key] = value
  }

  if (end === -1) return { fields: {}, body: raw }
  return { fields, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '') }
}
