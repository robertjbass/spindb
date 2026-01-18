import { describe, it, after } from 'node:test'
import { writeFileSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assertEqual } from '../utils/assertions'
import { detectLocationType } from '../../cli/commands/create'
import { Engine } from '../../types'

describe('detectLocationType', () => {
  describe('connection string detection', () => {
    it('should detect postgresql:// connection strings', () => {
      const result = detectLocationType('postgresql://localhost:5432/mydb')
      assertEqual(result.type, 'connection', 'Should be connection type')
      assertEqual(
        result.inferredEngine,
        Engine.PostgreSQL,
        'Should infer PostgreSQL',
      )
    })

    it('should detect postgres:// connection strings', () => {
      const result = detectLocationType('postgres://user:pass@host:5432/db')
      assertEqual(result.type, 'connection', 'Should be connection type')
      assertEqual(
        result.inferredEngine,
        Engine.PostgreSQL,
        'Should infer PostgreSQL',
      )
    })

    it('should detect mysql:// connection strings', () => {
      const result = detectLocationType('mysql://localhost:3306/mydb')
      assertEqual(result.type, 'connection', 'Should be connection type')
      assertEqual(result.inferredEngine, Engine.MySQL, 'Should infer MySQL')
    })

    it('should detect sqlite:// connection strings', () => {
      const result = detectLocationType('sqlite:///path/to/db.sqlite')
      assertEqual(result.type, 'connection', 'Should be connection type')
      assertEqual(result.inferredEngine, Engine.SQLite, 'Should infer SQLite')
    })

    it('should detect duckdb:// connection strings', () => {
      const result = detectLocationType('duckdb:///path/to/db.duckdb')
      assertEqual(result.type, 'connection', 'Should be connection type')
      assertEqual(result.inferredEngine, Engine.DuckDB, 'Should infer DuckDB')
    })

    it('should detect redis:// connection strings', () => {
      const result = detectLocationType('redis://localhost:6379')
      assertEqual(result.type, 'connection', 'Should be connection type')
      assertEqual(result.inferredEngine, Engine.Redis, 'Should infer Redis')
    })

    it('should detect rediss:// connection strings (TLS)', () => {
      const result = detectLocationType('rediss://secure.redis.host:6379')
      assertEqual(result.type, 'connection', 'Should be connection type')
      assertEqual(result.inferredEngine, Engine.Redis, 'Should infer Redis')
    })

    it('should detect valkey:// connection strings', () => {
      const result = detectLocationType('valkey://localhost:6379')
      assertEqual(result.type, 'connection', 'Should be connection type')
      assertEqual(result.inferredEngine, Engine.Valkey, 'Should infer Valkey')
    })

    it('should detect valkeys:// connection strings (TLS)', () => {
      const result = detectLocationType('valkeys://secure.valkey.host:6379')
      assertEqual(result.type, 'connection', 'Should be connection type')
      assertEqual(result.inferredEngine, Engine.Valkey, 'Should infer Valkey')
    })
  })

  describe('file extension detection', () => {
    const testFiles: string[] = []

    function createTempFile(extension: string): string {
      const filename = `test-detect-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`
      const filepath = join(tmpdir(), filename)
      writeFileSync(filepath, '')
      testFiles.push(filepath)
      return filepath
    }

    after(() => {
      for (const file of testFiles) {
        if (existsSync(file)) {
          unlinkSync(file)
        }
      }
    })

    it('should detect .sqlite files as SQLite', () => {
      const filepath = createTempFile('sqlite')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', 'Should be file type')
      assertEqual(result.inferredEngine, Engine.SQLite, 'Should infer SQLite')
    })

    it('should detect .sqlite3 files as SQLite', () => {
      const filepath = createTempFile('sqlite3')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', 'Should be file type')
      assertEqual(result.inferredEngine, Engine.SQLite, 'Should infer SQLite')
    })

    it('should detect .SQLITE files as SQLite (case-insensitive)', () => {
      // Create file with lowercase, test with uppercase in name
      const filename = `TEST-DETECT-${Date.now()}.SQLITE`
      const filepath = join(tmpdir(), filename)
      writeFileSync(filepath, '')
      testFiles.push(filepath)

      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', 'Should be file type')
      assertEqual(result.inferredEngine, Engine.SQLite, 'Should infer SQLite')
    })

    it('should detect .duckdb files as DuckDB', () => {
      const filepath = createTempFile('duckdb')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', 'Should be file type')
      assertEqual(result.inferredEngine, Engine.DuckDB, 'Should infer DuckDB')
    })

    it('should detect .ddb files as DuckDB', () => {
      const filepath = createTempFile('ddb')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', 'Should be file type')
      assertEqual(result.inferredEngine, Engine.DuckDB, 'Should infer DuckDB')
    })

    it('should detect .DUCKDB files as DuckDB (case-insensitive)', () => {
      const filename = `TEST-DETECT-${Date.now()}.DUCKDB`
      const filepath = join(tmpdir(), filename)
      writeFileSync(filepath, '')
      testFiles.push(filepath)

      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', 'Should be file type')
      assertEqual(result.inferredEngine, Engine.DuckDB, 'Should infer DuckDB')
    })

    it('should NOT infer DuckDB from .db extension (commonly used by SQLite)', () => {
      const filepath = createTempFile('db')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', 'Should be file type')
      assertEqual(
        result.inferredEngine,
        undefined,
        'Should NOT infer engine from .db extension',
      )
    })

    it('should return file type without inference for unknown extensions', () => {
      const filepath = createTempFile('txt')
      const result = detectLocationType(filepath)
      assertEqual(result.type, 'file', 'Should be file type')
      assertEqual(
        result.inferredEngine,
        undefined,
        'Should not infer engine for unknown extension',
      )
    })
  })

  describe('non-existent paths', () => {
    it('should return not_found for non-existent file paths', () => {
      const result = detectLocationType('/path/that/does/not/exist.sqlite')
      assertEqual(result.type, 'not_found', 'Should be not_found type')
      assertEqual(
        result.inferredEngine,
        undefined,
        'Should not infer engine for non-existent path',
      )
    })

    it('should return not_found for paths without connection string prefix', () => {
      const result = detectLocationType('some-random-string')
      assertEqual(result.type, 'not_found', 'Should be not_found type')
    })

    it('should return not_found for empty-ish paths', () => {
      const result = detectLocationType('./nonexistent.db')
      assertEqual(result.type, 'not_found', 'Should be not_found type')
    })
  })
})
