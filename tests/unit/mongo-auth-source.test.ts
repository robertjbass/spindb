import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveMongoAuthSources,
  isMongoAuthError,
} from '../../engines/mongo-uri'

// Mongo's auth user does not always live in the target database: spindb's own
// createUser puts it in <database>, but an external provisioner (e.g. a cloud
// that runs MONGO_INITDB_ROOT) creates the root user in `admin`. backup/restore
// resolve the candidate authSources from these helpers and retry on auth failure.

describe('resolveMongoAuthSources', () => {
  it('returns ONLY the explicit authSource when set (no guessing)', () => {
    assert.deepEqual(
      resolveMongoAuthSources({ authSource: 'admin', database: 'mydb' }),
      ['admin'],
    )
    // explicit wins even if it equals the database
    assert.deepEqual(
      resolveMongoAuthSources({ authSource: 'mydb', database: 'mydb' }),
      ['mydb'],
    )
  })

  it('falls back to <database> then admin when no explicit authSource', () => {
    // spindb-created (local): user is in <database>, so it is tried first; admin
    // is the fallback for an externally-provisioned root user.
    assert.deepEqual(resolveMongoAuthSources({ database: 'mydb' }), [
      'mydb',
      'admin',
    ])
  })

  it('dedupes when the database IS admin', () => {
    assert.deepEqual(resolveMongoAuthSources({ database: 'admin' }), ['admin'])
  })

  it('defaults to admin when neither is provided', () => {
    assert.deepEqual(resolveMongoAuthSources({}), ['admin'])
  })
})

describe('isMongoAuthError', () => {
  it('matches the real mongodump/mongorestore auth-failure stderr', () => {
    // The exact failure the cloud hit: spindb authed with authSource=<db> but the
    // cloud root user is in admin.
    assert.equal(
      isMongoAuthError(
        "Failed: can't create session: ... auth error: ... (AuthenticationFailed) Authentication failed.",
      ),
      true,
    )
    assert.equal(isMongoAuthError('command requires authentication'), true)
    assert.equal(isMongoAuthError('not authorized on mydb to execute'), true)
  })

  it('does NOT match unrelated failures (so we do not retry pointlessly)', () => {
    assert.equal(isMongoAuthError('connection refused'), false)
    assert.equal(isMongoAuthError('gzip: invalid header'), false)
    assert.equal(isMongoAuthError(''), false)
  })
})
