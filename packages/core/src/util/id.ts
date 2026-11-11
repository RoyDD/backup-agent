import { randomUUID } from 'node:crypto'

/** Prefixed, collision-resistant identifier. Prefixes follow the domain ids. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}
