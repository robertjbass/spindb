import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  DROP_FORCE_MIN_MAJOR,
  buildDropDatabaseSql,
  buildTerminateConnectionsSql,
  isDatabaseInUseError,
  isDatabaseMissingError,
  isDropForceUnsupportedError,
  maintenanceDatabaseFor,
  parsePostgresMajor,
  supportsDropForce,
} from '../../engines/postgresql/drop-database-sql.ts'

describe('PostgreSQL drop-database version gate', () => {
  it('reads the major out of every version shape container.json holds', () => {
    assert.strictEqual(parsePostgresMajor('18.4.0'), 18)
    assert.strictEqual(parsePostgresMajor('18'), 18)
    assert.strictEqual(parsePostgresMajor('13.0.0'), 13)
    assert.strictEqual(parsePostgresMajor('9.6.24'), 9)
    assert.strictEqual(parsePostgresMajor(' 17.2.0 '), 17)
  })

  it('treats an unknown version as too old to force', () => {
    assert.strictEqual(parsePostgresMajor('unknown'), null)
    assert.strictEqual(parsePostgresMajor(''), null)
    assert.strictEqual(parsePostgresMajor(undefined), null)
    assert.strictEqual(parsePostgresMajor(null), null)
    assert.strictEqual(supportsDropForce(null), false)
  })

  it('gates WITH (FORCE) on PostgreSQL 13', () => {
    assert.strictEqual(DROP_FORCE_MIN_MAJOR, 13)
    assert.strictEqual(supportsDropForce(12), false)
    assert.strictEqual(supportsDropForce(13), true)
    assert.strictEqual(supportsDropForce(18), true)
  })

  it('builds the forced drop for 13+', () => {
    const major = parsePostgresMajor('18.4.0')
    assert.strictEqual(
      buildDropDatabaseSql('mydb', { force: supportsDropForce(major) }),
      'DROP DATABASE IF EXISTS "mydb" WITH (FORCE)',
    )
  })

  it('builds the plain drop for older servers', () => {
    const major = parsePostgresMajor('12.19.0')
    assert.strictEqual(
      buildDropDatabaseSql('mydb', { force: supportsDropForce(major) }),
      'DROP DATABASE IF EXISTS "mydb"',
    )
  })

  it('terminates every backend but its own, for the two-step path', () => {
    assert.strictEqual(
      buildTerminateConnectionsSql('mydb'),
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'mydb' AND pid <> pg_backend_pid()",
    )
  })

  it('issues the drop from a maintenance database, never the target', () => {
    assert.strictEqual(maintenanceDatabaseFor('mydb'), 'postgres')
    assert.strictEqual(maintenanceDatabaseFor('postgres'), 'template1')
  })

  it('recognizes the retryable "being accessed" failure', () => {
    assert.strictEqual(
      isDatabaseInUseError(
        'ERROR:  database "mydb" is being accessed by other users\nDETAIL:  There is 1 other session using the database.',
      ),
      true,
    )
    assert.strictEqual(
      isDatabaseInUseError('ERROR:  permission denied to drop database'),
      false,
    )
  })

  it('recognizes a database that is already gone', () => {
    assert.strictEqual(
      isDatabaseMissingError('ERROR:  database "mydb" does not exist'),
      true,
    )
    assert.strictEqual(
      isDatabaseMissingError('ERROR:  cannot drop a template database'),
      false,
    )
  })

  it('recognizes a server that does not understand FORCE after all', () => {
    assert.strictEqual(
      isDropForceUnsupportedError('ERROR:  syntax error at or near "FORCE"'),
      true,
    )
    assert.strictEqual(
      isDropForceUnsupportedError(
        'ERROR:  unrecognized DROP DATABASE option "force"',
      ),
      true,
    )
    assert.strictEqual(
      isDropForceUnsupportedError(
        'ERROR:  database "mydb" is being accessed by other users',
      ),
      false,
    )
  })
})
