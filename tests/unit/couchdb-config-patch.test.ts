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
