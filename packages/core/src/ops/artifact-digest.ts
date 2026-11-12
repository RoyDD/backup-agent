import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path))
}

/**
 * sha256 of a file, or a deterministic hash of a directory tree; null when unreadable.
 *
 * Directories are digested from sorted relative paths, sizes and per-file
 * sha256s, never from mtimes or inode metadata, so an unchanged tree yields the
 * same digest on every run. Symlinks and special files are skipped rather than
 * followed, and any fs error (ENOENT, EACCES, a file vanishing mid-walk)
 * degrades to null instead of throwing.
 */
export function digestArtifact(path: string): string | null {
  try {
    const stat = statSync(path)
    if (stat.isFile()) return sha256File(path)
    if (!stat.isDirectory()) return null

    const entries: Array<{ relPath: string; line: string }> = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!entry.isFile()) continue
        const relPath = relative(path, full).split(sep).join('/')
        const size = statSync(full).size
        entries.push({ relPath, line: `${relPath}\0${size}\0${sha256File(full)}\n` })
      }
    }
    walk(path)

    entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    return sha256Bytes(Buffer.from(entries.map((entry) => entry.line).join(''), 'utf8'))
  } catch {
    return null
  }
}
