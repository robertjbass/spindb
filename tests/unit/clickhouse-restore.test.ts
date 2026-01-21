import { describe, it, before, after } from 'node:test'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/clickhouse/restore'
import { assert, assertEqual } from '../utils/assertions'

let testDir: string

describe('ClickHouse Restore', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-clickhouse-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore errors (e.g., ENOENT if already cleaned up)
    }
  })

  describe('detectBackupFormat', () => {
    it('should detect SQL file by extension', async () => {
      const filePath = join(testDir, 'backup.sql')
      await writeFile(filePath, 'CREATE TABLE test (id Int32);')

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'sql', 'Format should be sql')
      assert(
        format.description.includes('SQL'),
        'Description should mention SQL',
      )
    })

    it('should detect SQL content even without .sql extension', async () => {
      const filePath = join(testDir, 'backup.txt')
      await writeFile(
        filePath,
        'CREATE TABLE test (id Int32) ENGINE = MergeTree();',
      )

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'sql', 'Format should be sql')
    })

    it('should return unknown for non-SQL files', async () => {
      const filePath = join(testDir, 'invalid.bin')
      await writeFile(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03]))

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'unknown', 'Format should be unknown')
    })

    it('should throw for non-existent file', async () => {
      let threw = false
      try {
        await detectBackupFormat('/nonexistent/path/file.sql')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('not found'),
          'Error should mention file not found',
        )
      }
      assert(threw, 'Should throw for non-existent file')
    })
  })

  describe('parseConnectionString', () => {
    it('should parse simple ClickHouse URL', () => {
      const result = parseConnectionString('clickhouse://127.0.0.1:9000/default')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 9000, 'Port should be 9000')
      assertEqual(result.database, 'default', 'Database should be default')
      assertEqual(result.user, undefined, 'User should be undefined')
      assertEqual(result.password, undefined, 'Password should be undefined')
    })

    it('should parse ClickHouse URL with credentials', () => {
      const result = parseConnectionString(
        'clickhouse://admin:secretpass@127.0.0.1:9000/analytics',
      )
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 9000, 'Port should be 9000')
      assertEqual(result.database, 'analytics', 'Database should be analytics')
      assertEqual(result.user, 'admin', 'User should be admin')
      assertEqual(result.password, 'secretpass', 'Password should be secretpass')
    })

    it('should use default port (9000) when not specified for clickhouse://', () => {
      const result = parseConnectionString('clickhouse://127.0.0.1/default')
      assertEqual(result.port, 9000, 'Port should default to 9000')
    })

    it('should use default port (8123) when not specified for http://', () => {
      const result = parseConnectionString('http://127.0.0.1/default')
      assertEqual(result.port, 8123, 'Port should default to 8123 for HTTP')
    })

    it('should use default port (8123) when not specified for https://', () => {
      const result = parseConnectionString('https://clickhouse.example.com/default')
      assertEqual(result.port, 8123, 'Port should default to 8123 for HTTPS')
    })

    it('should use default database when not specified', () => {
      const result = parseConnectionString('clickhouse://127.0.0.1:9000')
      assertEqual(result.database, 'default', 'Database should default to "default"')
    })

    it('should use default host when not specified', () => {
      const result = parseConnectionString('clickhouse:///mydb')
      assertEqual(result.host, '127.0.0.1', 'Host should default to 127.0.0.1')
    })

    it('should handle http:// protocol', () => {
      const result = parseConnectionString('http://127.0.0.1:8123/mydb')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 8123, 'Port should be 8123')
      assertEqual(result.database, 'mydb', 'Database should be mydb')
    })

    it('should handle https:// protocol', () => {
      const result = parseConnectionString('https://clickhouse.example.com:8443/mydb')
      assertEqual(result.host, 'clickhouse.example.com', 'Host should be clickhouse.example.com')
      assertEqual(result.port, 8443, 'Port should be 8443')
    })

    it('should throw for unsupported protocol', () => {
      let threw = false
      try {
        parseConnectionString('postgresql://127.0.0.1:5432/mydb')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('unsupported protocol'),
          'Error should mention unsupported protocol',
        )
      }
      assert(threw, 'Should throw for unsupported protocol')
    })

    it('should throw for invalid URL', () => {
      let threw = false
      try {
        parseConnectionString('not-a-url')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('Invalid ClickHouse connection string'),
          'Error should mention invalid connection string',
        )
      }
      assert(threw, 'Should throw for invalid URL')
    })

    it('should throw for empty string', () => {
      let threw = false
      try {
        parseConnectionString('')
      } catch {
        threw = true
      }
      assert(threw, 'Should throw for empty string')
    })

    it('should mask credentials in error messages', () => {
      let errorMessage = ''
      try {
        // Use invalid format that will fail parsing
        parseConnectionString('clickhouse://admin:secretpass@:invalid')
      } catch (error) {
        errorMessage = (error as Error).message
      }
      assert(
        !errorMessage.includes('secretpass'),
        'Error should not contain plain password',
      )
    })
  })
})
