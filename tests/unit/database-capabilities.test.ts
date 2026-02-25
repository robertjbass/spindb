import { describe, it } from 'node:test'
import {
  getDatabaseCapabilities,
  canCreateDatabase,
  canRenameDatabase,
  canDropDatabase,
  getUnsupportedCreateMessage,
  getUnsupportedRenameMessage,
  getUnsupportedDropMessage,
} from '../../core/database-capabilities'
import { getEngine } from '../../engines'
import { Engine, ALL_ENGINES } from '../../types'
import { assert, assertEqual } from '../utils/assertions'

describe('Database Capabilities', () => {
  describe('getDatabaseCapabilities', () => {
    it('should return capabilities for all 20 engines', () => {
      for (const engine of ALL_ENGINES) {
        const caps = getDatabaseCapabilities(engine)
        assert(
          typeof caps.supportsCreate === 'boolean',
          `${engine} should have boolean supportsCreate`,
        )
        assert(
          typeof caps.supportsDrop === 'boolean',
          `${engine} should have boolean supportsDrop`,
        )
        assert(
          caps.supportsRename === 'native' ||
            caps.supportsRename === 'backup-restore' ||
            caps.supportsRename === false,
          `${engine} should have valid supportsRename`,
        )
      }
    })

    it('should have unsupportedReason for unsupported engines', () => {
      const unsupported = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of unsupported) {
        const caps = getDatabaseCapabilities(engine)
        assert(
          caps.unsupportedReason !== undefined &&
            caps.unsupportedReason.length > 0,
          `${engine} should have a non-empty unsupportedReason`,
        )
      }
    })

    it('should not have unsupportedReason for supported engines', () => {
      const supported = [
        Engine.PostgreSQL,
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Meilisearch,
        Engine.Weaviate,
      ]
      for (const engine of supported) {
        const caps = getDatabaseCapabilities(engine)
        assertEqual(
          caps.unsupportedReason,
          undefined,
          `${engine} should not have unsupportedReason`,
        )
      }
    })

    it('should return native rename for PostgreSQL, ClickHouse, CockroachDB, and Meilisearch', () => {
      const nativeRename = ALL_ENGINES.filter(
        (e) => getDatabaseCapabilities(e).supportsRename === 'native',
      )
      assertEqual(
        nativeRename.length,
        4,
        'Should have exactly 4 native-rename engines',
      )
      assert(
        nativeRename.includes(Engine.PostgreSQL),
        'PostgreSQL should support native rename',
      )
      assert(
        nativeRename.includes(Engine.ClickHouse),
        'ClickHouse should support native rename',
      )
      assert(
        nativeRename.includes(Engine.CockroachDB),
        'CockroachDB should support native rename',
      )
      assert(
        nativeRename.includes(Engine.Meilisearch),
        'Meilisearch should support native rename',
      )
    })

    it('should return backup-restore rename for most supported engines', () => {
      const backupRestore = [
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Weaviate,
      ]
      for (const engine of backupRestore) {
        const caps = getDatabaseCapabilities(engine)
        assertEqual(
          caps.supportsRename,
          'backup-restore',
          `${engine} should use backup-restore rename`,
        )
      }
    })

    it('should return false for rename on unsupported engines', () => {
      const noRename = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of noRename) {
        const caps = getDatabaseCapabilities(engine)
        assertEqual(
          caps.supportsRename,
          false,
          `${engine} should not support rename`,
        )
      }
    })
  })

  describe('canCreateDatabase', () => {
    it('should return true for supported engines', () => {
      const supported = [
        Engine.PostgreSQL,
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Meilisearch,
        Engine.Weaviate,
      ]
      for (const engine of supported) {
        assertEqual(
          canCreateDatabase(engine),
          true,
          `${engine} should support create`,
        )
      }
    })

    it('should return false for unsupported engines', () => {
      const unsupported = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of unsupported) {
        assertEqual(
          canCreateDatabase(engine),
          false,
          `${engine} should not support create`,
        )
      }
    })
  })

  describe('canRenameDatabase', () => {
    it('should return true for supported engines', () => {
      const supported = [
        Engine.PostgreSQL,
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Meilisearch,
        Engine.Weaviate,
      ]
      for (const engine of supported) {
        assertEqual(
          canRenameDatabase(engine),
          true,
          `${engine} should support rename`,
        )
      }
    })

    it('should return false for unsupported engines', () => {
      const unsupported = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of unsupported) {
        assertEqual(
          canRenameDatabase(engine),
          false,
          `${engine} should not support rename`,
        )
      }
    })
  })

  describe('canDropDatabase', () => {
    it('should return true for supported engines', () => {
      const supported = [
        Engine.PostgreSQL,
        Engine.MySQL,
        Engine.MariaDB,
        Engine.MongoDB,
        Engine.FerretDB,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.SurrealDB,
        Engine.TypeDB,
        Engine.InfluxDB,
        Engine.CouchDB,
        Engine.Qdrant,
        Engine.Meilisearch,
        Engine.Weaviate,
      ]
      for (const engine of supported) {
        assertEqual(
          canDropDatabase(engine),
          true,
          `${engine} should support drop`,
        )
      }
    })

    it('should return false for unsupported engines', () => {
      const unsupported = [
        Engine.SQLite,
        Engine.DuckDB,
        Engine.Redis,
        Engine.Valkey,
        Engine.QuestDB,
        Engine.TigerBeetle,
      ]
      for (const engine of unsupported) {
        assertEqual(
          canDropDatabase(engine),
          false,
          `${engine} should not support drop`,
        )
      }
    })
  })

  describe('getUnsupportedCreateMessage', () => {
    it('should return empty string for supported engines', () => {
      assertEqual(
        getUnsupportedCreateMessage(Engine.PostgreSQL),
        '',
        'PostgreSQL create should return empty',
      )
    })

    it('should return descriptive message for SQLite', () => {
      const msg = getUnsupportedCreateMessage(Engine.SQLite)
      assert(msg.includes('SQLite'), 'Should mention SQLite')
      assert(msg.includes('file IS the database'), 'Should explain why')
      assert(msg.includes('spindb create'), 'Should suggest alternative')
    })

    it('should return descriptive message for DuckDB', () => {
      const msg = getUnsupportedCreateMessage(Engine.DuckDB)
      assert(msg.includes('DuckDB'), 'Should mention DuckDB')
      assert(msg.includes('file IS the database'), 'Should explain why')
    })

    it('should return descriptive message for Redis', () => {
      const msg = getUnsupportedCreateMessage(Engine.Redis)
      assert(msg.includes('Redis'), 'Should mention Redis')
      assert(msg.includes('0-15'), 'Should mention numbered databases')
    })

    it('should return descriptive message for Valkey', () => {
      const msg = getUnsupportedCreateMessage(Engine.Valkey)
      assert(msg.includes('Valkey'), 'Should mention Valkey')
      assert(msg.includes('0-15'), 'Should mention numbered databases')
    })

    it('should return descriptive message for QuestDB', () => {
      const msg = getUnsupportedCreateMessage(Engine.QuestDB)
      assert(msg.includes('QuestDB'), 'Should mention QuestDB')
      assert(msg.includes('single-database'), 'Should explain model')
    })

    it('should return descriptive message for TigerBeetle', () => {
      const msg = getUnsupportedCreateMessage(Engine.TigerBeetle)
      assert(msg.includes('TigerBeetle'), 'Should mention TigerBeetle')
      assert(msg.includes('single ledger'), 'Should explain model')
    })
  })

  describe('getUnsupportedRenameMessage', () => {
    it('should return empty string for supported engines', () => {
      assertEqual(
        getUnsupportedRenameMessage(Engine.PostgreSQL),
        '',
        'PostgreSQL rename should return empty',
      )
      assertEqual(
        getUnsupportedRenameMessage(Engine.ClickHouse),
        '',
        'ClickHouse rename should return empty',
      )
    })

    it('should return descriptive message for SQLite', () => {
      const msg = getUnsupportedRenameMessage(Engine.SQLite)
      assert(msg.includes('SQLite'), 'Should mention SQLite')
    })

    it('should return descriptive message for Redis', () => {
      const msg = getUnsupportedRenameMessage(Engine.Redis)
      assert(msg.includes('Redis'), 'Should mention Redis')
      assert(msg.includes('number'), 'Should mention numbered databases')
    })
  })

  describe('getUnsupportedDropMessage', () => {
    it('should return empty string for supported engines', () => {
      assertEqual(
        getUnsupportedDropMessage(Engine.PostgreSQL),
        '',
        'PostgreSQL drop should return empty',
      )
    })

    it('should return descriptive message for SQLite', () => {
      const msg = getUnsupportedDropMessage(Engine.SQLite)
      assert(msg.includes('SQLite'), 'Should mention SQLite')
      assert(msg.includes('spindb delete'), 'Should suggest alternative')
    })

    it('should return descriptive message for Redis', () => {
      const msg = getUnsupportedDropMessage(Engine.Redis)
      assert(msg.includes('Redis'), 'Should mention Redis')
      assert(msg.includes('FLUSHDB'), 'Should suggest FLUSHDB')
    })

    it('should return descriptive message for TigerBeetle', () => {
      const msg = getUnsupportedDropMessage(Engine.TigerBeetle)
      assert(msg.includes('TigerBeetle'), 'Should mention TigerBeetle')
      assert(msg.includes('spindb delete'), 'Should suggest alternative')
    })
  })

  describe('exhaustive coverage', () => {
    it('should cover all 20 engines', () => {
      assertEqual(ALL_ENGINES.length, 20, 'Should have exactly 20 engines')
      // This test ensures getDatabaseCapabilities handles all engines
      // without throwing (the assertExhaustive in the switch would throw
      // at runtime if any engine was missing)
      for (const engine of ALL_ENGINES) {
        const caps = getDatabaseCapabilities(engine)
        assert(caps !== undefined, `${engine} should return capabilities`)
      }
    })

    it('should have 14 supported and 6 unsupported engines', () => {
      const supported = ALL_ENGINES.filter((e) => canCreateDatabase(e))
      const unsupported = ALL_ENGINES.filter((e) => !canCreateDatabase(e))
      assertEqual(supported.length, 14, 'Should have 14 supported engines')
      assertEqual(unsupported.length, 6, 'Should have 6 unsupported engines')
    })
  })

  describe('native rename engine implementations', () => {
    const nativeRenameEngines = ALL_ENGINES.filter(
      (e) => getDatabaseCapabilities(e).supportsRename === 'native',
    )

    it('every native-rename engine should override renameDatabase', () => {
      for (const engineName of nativeRenameEngines) {
        const engine = getEngine(engineName)
        // The base engine's renameDatabase throws UnsupportedOperationError.
        // Native-rename engines must override it with their own implementation.
        // We verify by checking the method is not the base class default.
        const proto = Object.getPrototypeOf(engine)
        assert(
          Object.prototype.hasOwnProperty.call(proto, 'renameDatabase'),
          `${engineName} has native rename capability but does not override renameDatabase()`,
        )
      }
    })

    it('backup-restore engines should NOT override renameDatabase', () => {
      const backupRestoreEngines = ALL_ENGINES.filter(
        (e) => getDatabaseCapabilities(e).supportsRename === 'backup-restore',
      )
      for (const engineName of backupRestoreEngines) {
        const engine = getEngine(engineName)
        const proto = Object.getPrototypeOf(engine)
        assertEqual(
          Object.prototype.hasOwnProperty.call(proto, 'renameDatabase'),
          false,
          `${engineName} uses backup-restore but overrides renameDatabase() — should it be native?`,
        )
      }
    })

    it('should include PostgreSQL, ClickHouse, CockroachDB, and Meilisearch', () => {
      const expected = [
        Engine.PostgreSQL,
        Engine.ClickHouse,
        Engine.CockroachDB,
        Engine.Meilisearch,
      ]
      for (const engine of expected) {
        assert(
          nativeRenameEngines.includes(engine),
          `${engine} should be in the native-rename list`,
        )
      }
      assertEqual(
        nativeRenameEngines.length,
        expected.length,
        `Should have exactly ${expected.length} native-rename engines`,
      )
    })
  })
})
