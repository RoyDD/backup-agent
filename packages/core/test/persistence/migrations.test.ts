import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

const MIGRATIONS = new URL('../../src/persistence/sqlite/migrations/', import.meta.url)

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function migration(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS), 'utf8')
}

describe('migration 008_attempt_target', () => {
  it('backfills target_id for attempts written before the column existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-migrate-'))
    dirs.push(dir)
    const db = new DatabaseSync(join(dir, 'control.db'))
    try {
      db.exec(migration('001_init.sql'))
      db.exec(migration('002_artifacts.sql'))
      db.exec(migration('003_attempt_error.sql'))

      db.prepare(
        `INSERT INTO tickets (id, principal_id, target_id, goal, state, created_at, updated_at)
         VALUES ('tkt_1', 'os:roy', 'pg-prod', 'nightly', 'in_progress', 'now', 'now')`,
      ).run()
      db.prepare(
        `INSERT INTO mandates (id, ticket_id, principal_id, scope, policy_version, allowed_risk, issued_at, expires_at)
         VALUES ('mnd_1', 'tkt_1', 'os:roy', 'native-logical', 'cli', 'reversible', 'now', 'later')`,
      ).run()
      db.prepare(
        `INSERT INTO plans (id, ticket_id, mandate_id, state, payload_json, fingerprint_digest, created_at, updated_at)
         VALUES ('pln_1', 'tkt_1', 'mnd_1', 'dispatched', ?, 'digest', 'now', 'now')`,
      ).run(
        JSON.stringify({
          planId: 'pln_1',
          ticketId: 'tkt_1',
          mandateId: 'mnd_1',
          targetId: 'pg-prod',
        }),
      )
      db.prepare(
        `INSERT INTO attempts (id, plan_id, state, owner, lease_token, lease_expires_at, started_at, finished_at, exit_code)
         VALUES ('att_1', 'pln_1', 'running', 'worker-a', 4, 'later', 'now', NULL, NULL)`,
      ).run()
      // A plan whose payload predates the field cannot be resolved; the row
      // must stay NULL rather than inventing a target identity.
      db.prepare(
        `INSERT INTO plans (id, ticket_id, mandate_id, state, payload_json, fingerprint_digest, created_at, updated_at)
         VALUES ('pln_2', 'tkt_1', 'mnd_1', 'dispatched', '{}', 'digest', 'now', 'now')`,
      ).run()
      db.prepare(
        `INSERT INTO attempts (id, plan_id, state, owner, lease_token, lease_expires_at, started_at, finished_at, exit_code)
         VALUES ('att_2', 'pln_2', 'running', 'worker-b', 5, 'later', 'now', NULL, NULL)`,
      ).run()

      db.exec(migration('008_attempt_target.sql'))

      const rows = db
        .prepare('SELECT id, target_id FROM attempts ORDER BY id')
        .all() as Array<{ id: string; target_id: string | null }>
      expect(rows).toEqual([
        { id: 'att_1', target_id: 'pg-prod' },
        { id: 'att_2', target_id: null },
      ])
    } finally {
      db.close()
    }
  })
})

describe('migration 009_outbox_delivery', () => {
  it('adds a zeroed delivery token for existing outbox rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-migrate-'))
    dirs.push(dir)
    const db = new DatabaseSync(join(dir, 'control.db'))
    try {
      db.exec(migration('001_init.sql'))
      db.prepare(
        `INSERT INTO outbox (id, topic, payload_json, idempotency_key, status, attempts, available_at, lease_expires_at, created_at, dispatched_at, last_error)
         VALUES ('obx_1', 'audit', '{}', 'k-1', 'pending', 0, 'now', NULL, 'now', NULL, NULL)`,
      ).run()

      db.exec(migration('009_outbox_delivery.sql'))

      const row = db
        .prepare('SELECT delivery_token FROM outbox WHERE id = ?')
        .get('obx_1') as { delivery_token: number }
      expect(row.delivery_token).toBe(0)
    } finally {
      db.close()
    }
  })
})

describe('migration 010_artifact_lifecycle', () => {
  it('upgrades existing artifacts to live rows with no tombstone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-migrate-'))
    dirs.push(dir)
    const db = new DatabaseSync(join(dir, 'control.db'))
    try {
      db.exec(migration('001_init.sql'))
      db.exec(migration('002_artifacts.sql'))
      db.prepare(
        `INSERT INTO artifacts (id, plan_id, target_id, provider, kind, parent_id, path,
                                size_bytes, checksum, verified_level, verified_at, protected, created_at)
         VALUES ('art_1', NULL, 'pg-prod', 'native-logical', 'full', NULL, '/backups/a.dump',
                 1024, 'sha256:abc', 'V2', 'then', 0, 'then')`,
      ).run()

      db.exec(migration('010_artifact_lifecycle.sql'))

      const row = db
        .prepare('SELECT lifecycle_state, tombstoned_at, path FROM artifacts WHERE id = ?')
        .get('art_1') as { lifecycle_state: string; tombstoned_at: string | null; path: string }
      expect(row.lifecycle_state).toBe('live')
      expect(row.tombstoned_at).toBeNull()
      expect(row.path).toBe('/backups/a.dump')
    } finally {
      db.close()
    }
  })
})
