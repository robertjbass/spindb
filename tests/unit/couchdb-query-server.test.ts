/**
 * Unit tests for resolveCouchDBQueryServer.
 *
 * CouchDB runs validate_doc_update and map functions in an external JavaScript
 * query server. spindb used to point COUCHDB_QUERY_SERVER_JAVASCRIPT at the
 * BARE `<binDir>/bin/couchjs` binary, which the launcher never does (its own
 * default is the binary PLUS `share/server/main.js`) - the bare binary prints
 * usage and exits. With no query server, `_users` writes (its `_design/_auth`
 * carries a validate_doc_update) return HTTP 500 internal_server_error, which is
 * how `spindb users create` broke on Linux. CouchDB 3.5 bundles a
 * self-contained QuickJS server that has no mozjs dependency; these tests pin
 * that it is what gets used, and that the bare-binary value never comes back.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, sep } from 'path'
import { resolveCouchDBQueryServer } from '../../engines/couchdb/index'

const BIN_DIR = '/bins/couchdb-3.5.2-darwin-arm64'

/** A fake install tree: every listed path exists, nothing else does. */
const fakeFs = (files: string[]) => ({
  exists: (path: string) => files.includes(path),
  readDir: (dir: string) => {
    const prefix = `${dir}${sep}`
    const entries = new Set<string>()
    for (const file of files) {
      if (!file.startsWith(prefix)) continue
      entries.add(file.slice(prefix.length).split(sep)[0])
    }
    return [...entries]
  },
})

const quickjsTree = (version: string) => [
  join(BIN_DIR, 'lib', `couch_quickjs-${version}`, 'priv', 'couchjs_mainjs'),
  join(BIN_DIR, 'lib', `couch_quickjs-${version}`, 'priv', 'couchjs_coffee'),
  join(BIN_DIR, 'lib', 'couch-3.5.2', 'ebin', 'couch.app'),
]

describe('resolveCouchDBQueryServer', () => {
  it('uses the bundled QuickJS query server when it is present', () => {
    const resolved = resolveCouchDBQueryServer({
      binDir: BIN_DIR,
      ...fakeFs(quickjsTree('3.5.2')),
    })

    assert.equal(
      resolved.javascript,
      join(BIN_DIR, 'lib', 'couch_quickjs-3.5.2', 'priv', 'couchjs_mainjs'),
    )
    assert.equal(
      resolved.coffeescript,
      join(BIN_DIR, 'lib', 'couch_quickjs-3.5.2', 'priv', 'couchjs_coffee'),
    )
  })

  it('globs the lib directory rather than trusting the container version', () => {
    // The bundled couch_quickjs version does not have to match the CouchDB
    // version. Interpolating the container's version would silently miss it.
    const resolved = resolveCouchDBQueryServer({
      binDir: BIN_DIR,
      ...fakeFs(quickjsTree('3.4.9')),
    })

    assert.equal(
      resolved.javascript,
      join(BIN_DIR, 'lib', 'couch_quickjs-3.4.9', 'priv', 'couchjs_mainjs'),
    )
  })

  it('picks the highest version when several QuickJS builds are present', () => {
    const resolved = resolveCouchDBQueryServer({
      binDir: BIN_DIR,
      ...fakeFs([...quickjsTree('3.5.2'), ...quickjsTree('3.4.9')]),
    })

    assert.match(resolved.javascript ?? '', /couch_quickjs-3\.5\.2/)
  })

  it('compares versions numerically, so 3.10.0 outranks 3.9.0', () => {
    // A lexical sort puts "3.10.0" below "3.9.0" and would pick the older
    // build.
    const resolved = resolveCouchDBQueryServer({
      binDir: BIN_DIR,
      ...fakeFs([...quickjsTree('3.9.0'), ...quickjsTree('3.10.0')]),
    })

    assert.equal(
      resolved.javascript,
      join(BIN_DIR, 'lib', 'couch_quickjs-3.10.0', 'priv', 'couchjs_mainjs'),
    )
  })

  it('omits coffeescript when only the main QuickJS binary ships', () => {
    const resolved = resolveCouchDBQueryServer({
      binDir: BIN_DIR,
      ...fakeFs([
        join(BIN_DIR, 'lib', 'couch_quickjs-3.5.2', 'priv', 'couchjs_mainjs'),
      ]),
    })

    assert.ok(resolved.javascript)
    assert.equal(resolved.coffeescript, undefined)
  })

  it('finds the Windows .exe variants', () => {
    const resolved = resolveCouchDBQueryServer({
      binDir: BIN_DIR,
      ...fakeFs([
        join(
          BIN_DIR,
          'lib',
          'couch_quickjs-3.5.2',
          'priv',
          'couchjs_mainjs.exe',
        ),
        join(
          BIN_DIR,
          'lib',
          'couch_quickjs-3.5.2',
          'priv',
          'couchjs_coffee.exe',
        ),
      ]),
    })

    assert.match(resolved.javascript ?? '', /couchjs_mainjs\.exe$/)
    assert.match(resolved.coffeescript ?? '', /couchjs_coffee\.exe$/)
  })

  it('sets nothing when no QuickJS build exists, leaving the launcher default', () => {
    // The macOS 3.5.2 artifact has neither a QuickJS build nor bin/couchjs at
    // all; the launcher cds into the install root, so its own relative default
    // is the only correct answer we can give.
    const resolved = resolveCouchDBQueryServer({
      binDir: BIN_DIR,
      ...fakeFs([join(BIN_DIR, 'bin', 'couchdb')]),
    })

    assert.deepEqual(resolved, {})
  })

  it('never returns the bare bin/couchjs binary', () => {
    // The original bug. bin/couchjs alone prints usage and exits, and on Linux
    // it is linked against a libmozjs-78.so.0 the tarball does not ship.
    const trees = [
      fakeFs(quickjsTree('3.5.2')),
      fakeFs([join(BIN_DIR, 'bin', 'couchjs')]),
      fakeFs([join(BIN_DIR, 'bin', 'couchjs'), ...quickjsTree('3.5.2')]),
      fakeFs([]),
    ]

    for (const tree of trees) {
      const resolved = resolveCouchDBQueryServer({ binDir: BIN_DIR, ...tree })
      for (const value of [resolved.javascript, resolved.coffeescript]) {
        if (value === undefined) continue
        assert.doesNotMatch(
          value,
          /bin[\\/]couchjs$/,
          `must never hand CouchDB the bare binary (got ${value})`,
        )
      }
    }
  })

  it('treats an unreadable install tree as "no QuickJS" instead of throwing', () => {
    const resolved = resolveCouchDBQueryServer({
      binDir: BIN_DIR,
      exists: () => false,
      readDir: () => {
        throw new Error('ENOENT')
      },
    })
    assert.deepEqual(resolved, {})
  })
})
