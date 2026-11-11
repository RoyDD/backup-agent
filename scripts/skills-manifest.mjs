#!/usr/bin/env node
/**
 * Writes or verifies the skill manifest. Each SKILL.md is hashed so a review
 * can prove the runbook an agent loaded is the one that was approved.
 *
 * Usage:
 *   node scripts/skills-manifest.mjs           # write MANIFEST.json
 *   node scripts/skills-manifest.mjs --check   # verify, exit 1 on drift
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILLS = join(HERE, '..', 'presets', 'pg-dba', 'skills')
const MANIFEST = join(SKILLS, 'MANIFEST.json')

function entries() {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const body = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8')
      return {
        name,
        path: `${name}/SKILL.md`,
        sha256: createHash('sha256').update(body).digest('hex'),
      }
    })
}

function main() {
  const current = entries()
  if (process.argv.includes('--check')) {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    const expected = new Map(manifest.entries.map((entry) => [entry.name, entry.sha256]))
    if (expected.size !== current.length) {
      throw new Error(`skill count drift: manifest ${expected.size}, disk ${current.length}`)
    }
    for (const entry of current) {
      if (expected.get(entry.name) !== entry.sha256) {
        throw new Error(`skill hash drift: ${entry.name}`)
      }
    }
    console.log(`skills verified: ${current.length}`)
    return
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    entries: current,
  }
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`skills manifest written: ${current.length} entries`)
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
