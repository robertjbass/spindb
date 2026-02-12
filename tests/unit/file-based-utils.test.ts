import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../../types/index'
import {
  detectEngineFromPath,
  getExtensionsForEngine,
  getAllFileBasedExtensions,
  isValidExtensionForEngine,
  formatExtensionsForEngine,
  formatAllExtensions,
  deriveContainerName,
  getRegistryForEngine,
  FILE_BASED_EXTENSION_REGEX,
} from '../../engines/file-based-utils'

describe('file-based-utils', () => {
  describe('detectEngineFromPath', () => {
    it('should detect SQLite from .sqlite extension', () => {
      assert.equal(detectEngineFromPath('/path/to/db.sqlite'), Engine.SQLite)
    })

    it('should detect SQLite from .sqlite3 extension', () => {
      assert.equal(detectEngineFromPath('/path/to/db.sqlite3'), Engine.SQLite)
    })

    it('should detect SQLite from .db extension', () => {
      assert.equal(detectEngineFromPath('/path/to/db.db'), Engine.SQLite)
    })

    it('should detect DuckDB from .duckdb extension', () => {
      assert.equal(detectEngineFromPath('/path/to/db.duckdb'), Engine.DuckDB)
    })

    it('should detect DuckDB from .ddb extension', () => {
      assert.equal(detectEngineFromPath('/path/to/db.ddb'), Engine.DuckDB)
    })

    it('should return null for unrecognized extension', () => {
      assert.equal(detectEngineFromPath('/path/to/db.txt'), null)
    })

    it('should return null for no extension', () => {
      assert.equal(detectEngineFromPath('/path/to/mydb'), null)
    })

    it('should be case-insensitive', () => {
      assert.equal(detectEngineFromPath('/path/to/db.SQLITE'), Engine.SQLite)
      assert.equal(detectEngineFromPath('/path/to/db.DuckDB'), Engine.DuckDB)
    })
  })

  describe('getExtensionsForEngine', () => {
    it('should return SQLite extensions', () => {
      const exts = getExtensionsForEngine(Engine.SQLite)
      assert.deepEqual(exts, ['.sqlite', '.sqlite3', '.db'])
    })

    it('should return DuckDB extensions', () => {
      const exts = getExtensionsForEngine(Engine.DuckDB)
      assert.deepEqual(exts, ['.duckdb', '.ddb'])
    })
  })

  describe('getAllFileBasedExtensions', () => {
    it('should return all extensions', () => {
      const exts = getAllFileBasedExtensions()
      assert.ok(exts.includes('.sqlite'))
      assert.ok(exts.includes('.sqlite3'))
      assert.ok(exts.includes('.db'))
      assert.ok(exts.includes('.duckdb'))
      assert.ok(exts.includes('.ddb'))
      assert.equal(exts.length, 5)
    })
  })

  describe('isValidExtensionForEngine', () => {
    it('should accept .sqlite for SQLite', () => {
      assert.ok(isValidExtensionForEngine('/path/db.sqlite', Engine.SQLite))
    })

    it('should reject .duckdb for SQLite', () => {
      assert.ok(!isValidExtensionForEngine('/path/db.duckdb', Engine.SQLite))
    })

    it('should accept .duckdb for DuckDB', () => {
      assert.ok(isValidExtensionForEngine('/path/db.duckdb', Engine.DuckDB))
    })

    it('should reject .sqlite for DuckDB', () => {
      assert.ok(!isValidExtensionForEngine('/path/db.sqlite', Engine.DuckDB))
    })

    it('should be case-insensitive', () => {
      assert.ok(isValidExtensionForEngine('/path/db.SQLITE', Engine.SQLite))
      assert.ok(isValidExtensionForEngine('/path/db.DUCKDB', Engine.DuckDB))
    })
  })

  describe('formatExtensionsForEngine', () => {
    it('should format SQLite extensions', () => {
      const result = formatExtensionsForEngine(Engine.SQLite)
      assert.ok(result.includes('.sqlite'))
      assert.ok(result.includes('.sqlite3'))
      assert.ok(result.includes('.db'))
    })

    it('should format DuckDB extensions', () => {
      const result = formatExtensionsForEngine(Engine.DuckDB)
      assert.ok(result.includes('.duckdb'))
      assert.ok(result.includes('.ddb'))
    })
  })

  describe('formatAllExtensions', () => {
    it('should include all extensions', () => {
      const result = formatAllExtensions()
      assert.ok(result.includes('.sqlite'))
      assert.ok(result.includes('.duckdb'))
    })
  })

  describe('FILE_BASED_EXTENSION_REGEX', () => {
    it('should match SQLite extensions', () => {
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.sqlite'))
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.sqlite3'))
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.db'))
    })

    it('should match DuckDB extensions', () => {
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.duckdb'))
      assert.ok(FILE_BASED_EXTENSION_REGEX.test('test.ddb'))
    })

    it('should not match other extensions', () => {
      assert.ok(!FILE_BASED_EXTENSION_REGEX.test('test.sql'))
      assert.ok(!FILE_BASED_EXTENSION_REGEX.test('test.txt'))
    })
  })

  describe('getRegistryForEngine', () => {
    it('should return a registry for SQLite', () => {
      const registry = getRegistryForEngine(Engine.SQLite)
      assert.ok(registry)
      assert.ok(typeof registry.add === 'function')
      assert.ok(typeof registry.get === 'function')
      assert.ok(typeof registry.remove === 'function')
      assert.ok(typeof registry.exists === 'function')
      assert.ok(typeof registry.isPathRegistered === 'function')
    })

    it('should return a registry for DuckDB', () => {
      const registry = getRegistryForEngine(Engine.DuckDB)
      assert.ok(registry)
      assert.ok(typeof registry.add === 'function')
    })

    it('should throw for non-file-based engines', () => {
      assert.throws(
        () => getRegistryForEngine(Engine.PostgreSQL),
        /not a file-based engine/,
      )
    })
  })

  describe('deriveContainerName', () => {
    it('should strip .sqlite extension', () => {
      assert.equal(deriveContainerName('mydb.sqlite', Engine.SQLite), 'mydb')
    })

    it('should strip .sqlite3 extension', () => {
      assert.equal(deriveContainerName('mydb.sqlite3', Engine.SQLite), 'mydb')
    })

    it('should strip .db extension', () => {
      assert.equal(deriveContainerName('mydb.db', Engine.SQLite), 'mydb')
    })

    it('should strip .duckdb extension', () => {
      assert.equal(deriveContainerName('mydb.duckdb', Engine.DuckDB), 'mydb')
    })

    it('should strip .ddb extension', () => {
      assert.equal(deriveContainerName('mydb.ddb', Engine.DuckDB), 'mydb')
    })

    it('should not strip wrong engine extension', () => {
      // .duckdb should not be stripped when engine is SQLite
      assert.equal(
        deriveContainerName('mydb.duckdb', Engine.SQLite),
        'mydb-duckdb',
      )
    })

    it('should replace spaces with hyphens', () => {
      assert.equal(
        deriveContainerName('my database.sqlite', Engine.SQLite),
        'my-database',
      )
    })

    it('should prefix with db- if starts with number', () => {
      assert.equal(
        deriveContainerName('123test.sqlite', Engine.SQLite),
        'db-123test',
      )
    })

    it('should return fallback for empty result (SQLite)', () => {
      assert.equal(deriveContainerName('.sqlite', Engine.SQLite), 'sqlite-db')
    })

    it('should return fallback for empty result (DuckDB)', () => {
      assert.equal(deriveContainerName('.duckdb', Engine.DuckDB), 'duckdb-db')
    })

    it('should handle consecutive hyphens', () => {
      assert.equal(deriveContainerName('my--db.sqlite', Engine.SQLite), 'my-db')
    })
  })
})
