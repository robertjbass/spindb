/**
 * Unit tests for patchCouchDBConfig's [admins] handling.
 *
 * CouchDB's local.ini is regenerated on every `spindb start`. The cloud
 * (Layerbase Cloud) rotates the admin password in [admins] out-of-band, so the
 * patch MUST preserve an existing admin entry rather than re-assert spindb's
 * own. The old regex captured only the `[admins]` header and appended a second
 * `admin =` line, leaving two conflicting admin passwords - CouchDB then locks
 * the account ("temporarily locked due to multiple authentication failures").
 * These tests pin the preserve-not-duplicate behavior.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { patchCouchDBConfig } from '../../engines/couchdb/index'

const adminLines = (config: string): string[] =>
  config.split('\n').filter((l) => /^admin\s*=/.test(l))

describe('patchCouchDBConfig [admins] handling', () => {
  it('preserves an existing admin entry and never duplicates it', () => {
    const existing = [
      '[chttpd]',
      'port = 5984',
      '',
      '[admins]',
      '; CouchDB 3.x requires admin account for privileged API operations',
      'admin = -pbkdf2:sha256-deadbeef,salt,10',
    ].join('\n')

    const patched = patchCouchDBConfig(existing, {
      port: 11500,
      adminUsername: 'admin',
      adminPassword: 'a-different-password',
    })

    const lines = adminLines(patched)
    assert.equal(lines.length, 1, 'must keep exactly one admin line')
    assert.match(
      lines[0],
      /-pbkdf2:sha256-deadbeef/,
      'existing value preserved',
    )
    assert.doesNotMatch(
      patched,
      /a-different-password/,
      'spindb must not re-assert its own password over the cloud-managed one',
    )
  })

  it('preserves an existing admin even when [admins] is the trailing section', () => {
    // Reproduces the original bug: a trailing [admins] section made the old
    // regex (with the `m` flag) match only the header and append a duplicate.
    const existing = [
      '[log]',
      'level = info',
      '',
      '[admins]',
      'admin = cloudpw',
    ].join('\n')
    const patched = patchCouchDBConfig(existing, {
      port: 11500,
      adminUsername: 'admin',
      adminPassword: 'spindbpw',
    })
    assert.equal(adminLines(patched).length, 1)
    assert.match(adminLines(patched)[0], /cloudpw/)
  })

  it('adds the admin under an existing [admins] header that has no entry', () => {
    const existing = ['[admins]', '; placeholder, no admin yet'].join('\n')
    const patched = patchCouchDBConfig(existing, {
      port: 11500,
      adminUsername: 'admin',
      adminPassword: 'freshpw',
    })
    const lines = adminLines(patched)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^admin = freshpw$/)
  })

  it('creates an [admins] section when none exists', () => {
    const existing = ['[chttpd]', 'port = 5984'].join('\n')
    const patched = patchCouchDBConfig(existing, {
      port: 11500,
      adminUsername: 'admin',
      adminPassword: 'freshpw',
    })
    assert.match(patched, /\[admins\]\nadmin = freshpw/)
    assert.equal(adminLines(patched).length, 1)
  })

  it('still patches the port', () => {
    const existing = ['[chttpd]', 'port = 5984', '[admins]', 'admin = x'].join(
      '\n',
    )
    const patched = patchCouchDBConfig(existing, { port: 11500 })
    assert.match(patched, /^port = 11500$/m)
  })
})

/**
 * Data-path re-pointing (Layerbase C-109, 2026-08-15).
 *
 * generateCouchDBConfig writes `database_dir` / `view_index_dir` as ABSOLUTE
 * paths, and a branch is a byte copy of the container directory - so before this,
 * a branched container's local.ini still named the PARENT's data dir and two
 * CouchDB nodes ran against one set of files. It looked healthy (the branch
 * starts, /_up returns 200) and only showed up as `read_beyond_eof` on the
 * parent's `_dbs.couch` when reading a document through the branch.
 */
describe('patchCouchDBConfig data-path re-pointing', () => {
  const parent = [
    '; SpinDB generated CouchDB configuration',
    '[couchdb]',
    'database_dir = /data/containers/couchdb/parent/data',
    'view_index_dir = /data/containers/couchdb/parent/data',
    '',
    '[chttpd]',
    'port = 5984',
    'bind_address = 127.0.0.1',
    '',
    '[log]',
    'file = /data/containers/couchdb/parent/logs/couchdb.log',
    'level = info',
    '',
    '[admins]',
    'admin = -pbkdf2:sha256-deadbeef,salt,10',
  ].join('\n')

  const BRANCH = '/data/containers/couchdb/branch/data'

  it('re-points both data keys at this container', () => {
    const patched = patchCouchDBConfig(parent, {
      port: 11500,
      dataDir: BRANCH,
    })
    assert.match(patched, new RegExp(`^database_dir = ${BRANCH}$`, 'm'))
    assert.match(patched, new RegExp(`^view_index_dir = ${BRANCH}$`, 'm'))
    assert.doesNotMatch(
      patched,
      /couchdb\/parent\/data/,
      'no key may still point at the parent',
    )
  })

  it('re-points the log file when a logDir is given', () => {
    const patched = patchCouchDBConfig(parent, {
      port: 11500,
      dataDir: BRANCH,
      logDir: '/data/containers/couchdb/branch/logs',
    })
    assert.match(
      patched,
      /^file = \/data\/containers\/couchdb\/branch\/logs\/couchdb\.log$/m,
    )
  })

  it('leaves paths alone when no dataDir is passed (unchanged callers)', () => {
    const patched = patchCouchDBConfig(parent, { port: 11500 })
    assert.match(
      patched,
      /^database_dir = \/data\/containers\/couchdb\/parent\/data$/m,
    )
    assert.match(patched, /^port = 11500$/m)
  })

  it('inserts the keys into a hand-written config that lacks them', () => {
    const handWritten = ['[chttpd]', 'port = 5984'].join('\n')
    const patched = patchCouchDBConfig(handWritten, {
      port: 11500,
      dataDir: BRANCH,
    })
    assert.match(patched, /^\[couchdb\]$/m)
    assert.match(patched, new RegExp(`^database_dir = ${BRANCH}$`, 'm'))
    assert.match(patched, new RegExp(`^view_index_dir = ${BRANCH}$`, 'm'))
    assert.match(patched, /^port = 11500$/m, 'the port patch still applies')
  })

  it('still preserves the existing admin entry while re-pointing paths', () => {
    // The two behaviours must not interfere: path re-pointing is new, admin
    // preservation is the reason this function exists at all.
    const patched = patchCouchDBConfig(parent, {
      port: 11500,
      dataDir: BRANCH,
      adminUsername: 'admin',
      adminPassword: 'a-different-password',
    })
    assert.equal(adminLines(patched).length, 1)
    assert.match(patched, /-pbkdf2:sha256-deadbeef/)
    assert.match(patched, new RegExp(`^database_dir = ${BRANCH}$`, 'm'))
  })

  it('is idempotent across repeated starts', () => {
    const once = patchCouchDBConfig(parent, { port: 11500, dataDir: BRANCH })
    const twice = patchCouchDBConfig(once, { port: 11500, dataDir: BRANCH })
    assert.equal(once, twice)
  })
})
