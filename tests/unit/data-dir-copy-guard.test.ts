/**
 * Unit tests for the data-directory copy guard (issue #275).
 *
 * CouchDB 3.x is a cluster even as a single node, and its identity lives inside
 * the DATA: `_nodes.couch` is the node list and `_dbs.couch` is the shard map,
 * which records the owning Erlang node name per shard range. Duplicating the data
 * directory therefore duplicates the cluster: the two instances find each other
 * over epmd, form one cluster, and the copy - owning no shards - proxies every
 * read and write to the source. A document written to the copy reads back on the
 * original.
 *
 * It fails silently (the copy starts, `/_up` returns 200, reads look right
 * because they ARE the parent's data), and unlike the port or `database_dir` it
 * cannot be repaired by rewriting a config file, because CouchDB has no supported
 * in-place node rename. So branch, branch-reset and clone all refuse.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assertDataDirCopyable } from '../../core/container-manager'
import { Engine } from '../../types'

describe('assertDataDirCopyable', () => {
  it('refuses CouchDB and says why, and how to get an isolated copy', () => {
    assert.throws(
      () => assertDataDirCopyable(Engine.CouchDB, 'Branching'),
      (error: Error) => {
        assert.equal(error.name, 'UnsupportedOperationError')
        // The operation the user actually attempted, so the message reads right
        // from `branch`, `branch reset` and `clone` alike.
        assert.match(error.message, /^Branching is not supported for couchdb/)
        // The mechanism, not just a refusal.
        assert.match(error.message, /_nodes and the _dbs shard map/)
        assert.match(
          error.message,
          /forwards its reads and writes to the source/,
        )
        // The way out.
        assert.match(error.message, /replicate into it instead/i)
        assert.match(error.message, /issues\/275/)
        return true
      },
    )
  })

  it('carries the attempted operation through', () => {
    for (const op of [
      'Branching',
      'Resetting a branch',
      'Copying a data directory',
    ]) {
      // Assert on error.message, not the regexp form of assert.throws: that
      // matches error.toString(), which starts with the error NAME, so a `^`
      // anchor on the message can never match.
      assert.throws(
        () => assertDataDirCopyable(Engine.CouchDB, op),
        (error: Error) => {
          assert.match(
            error.message,
            new RegExp(`^${op} is not supported for couchdb`),
          )
          return true
        },
      )
    }
  })

  it('allows every other engine', () => {
    // A deny-list, so a new engine is copyable until proven otherwise - the same
    // posture the rest of the branching code takes.
    for (const engine of Object.values(Engine)) {
      if (engine === Engine.CouchDB) continue
      assert.doesNotThrow(
        () => assertDataDirCopyable(engine, 'Branching'),
        `${engine} must remain copyable`,
      )
    }
  })

  it('allows the engines the cloud actually branches today', () => {
    // Pinned explicitly: a careless edit to the deny-list that caught one of
    // these would break branching for real users of that engine.
    for (const engine of [
      Engine.PostgreSQL,
      Engine.MySQL,
      Engine.MariaDB,
      Engine.Redis,
      Engine.Valkey,
      Engine.FerretDB,
      Engine.LibSQL,
      Engine.SQLite,
      Engine.DuckDB,
      Engine.TypeDB,
      Engine.ClickHouse,
      Engine.Meilisearch,
      Engine.Qdrant,
      Engine.QuestDB,
      Engine.InfluxDB,
      Engine.Weaviate,
    ]) {
      assert.doesNotThrow(() => assertDataDirCopyable(engine, 'Branching'))
    }
  })
})
