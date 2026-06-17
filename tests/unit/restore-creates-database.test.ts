/**
 * Unit tests for the `restoreCreatesDatabase` capability.
 *
 * Most engines need the restore CLI to create the target database before
 * the per-engine restore runs. TypeDB is the exception: its restore command
 * (`typedb console ... database import <db> <schema> <data>`) creates the
 * database AS PART of the import, so pre-creating it makes the import fail
 * with `[DBC6] Database '...' already exists`. The restore CLI consults this
 * capability to skip its own createDatabase step for such engines. These
 * tests lock in exactly which engines opt out so the set cannot silently
 * grow or regress.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  Engine,
  RESTORE_CREATES_DATABASE_ENGINES,
  restoreCreatesDatabase,
} from '../../types'

describe('restoreCreatesDatabase capability', () => {
  it('is true for TypeDB (its `database import` creates the database)', () => {
    assert.equal(restoreCreatesDatabase(Engine.TypeDB), true)
  })

  it('is false for the wire engines that need a pre-created database', () => {
    for (const engine of [
      Engine.PostgreSQL,
      Engine.MySQL,
      Engine.MariaDB,
      Engine.MongoDB,
      Engine.CockroachDB,
      Engine.ClickHouse,
    ]) {
      assert.equal(
        restoreCreatesDatabase(engine),
        false,
        `${engine} should not create its database during restore`,
      )
    }
  })

  it('the opt-out set is exactly { TypeDB } (guards against silent growth)', () => {
    assert.deepEqual([...RESTORE_CREATES_DATABASE_ENGINES], [Engine.TypeDB])
  })
})
