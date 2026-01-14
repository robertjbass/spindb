import { describe, it, before, after } from 'node:test'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/valkey/restore'
import { assert, assertEqual } from '../utils/assertions'

// Test fixtures - Valkey uses same RDB format as Redis
const RDB_MAGIC = Buffer.from([0x52, 0x45, 0x44, 0x49, 0x53]) // "REDIS"

let testDir: string

describe('Valkey Restore', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-valkey-test-${Date.now()}`)
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
    it('should detect valid RDB file by magic bytes', async () => {
      const filePath = join(testDir, 'valid.rdb')
      const content = Buffer.concat([RDB_MAGIC, Buffer.from('0009test-data')])
      await writeFile(filePath, content)

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'rdb', 'Format should be rdb')
      assert(
        format.description.includes('RDB snapshot'),
        'Description should mention RDB snapshot',
      )
    })

    it('should detect RDB file by extension as fallback', async () => {
      const filePath = join(testDir, 'extension.rdb')
      await writeFile(filePath, 'not-real-rdb-content')

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'rdb', 'Format should be rdb')
      assert(
        format.description.includes('extension'),
        'Description should mention detected by extension',
      )
    })

    it('should return unknown for non-RDB files', async () => {
      const filePath = join(testDir, 'invalid.txt')
      await writeFile(filePath, 'just some text content')

      const format = await detectBackupFormat(filePath)
      assertEqual(format.format, 'unknown', 'Format should be unknown')
    })

    it('should throw for non-existent file', async () => {
      let threw = false
      try {
        await detectBackupFormat('/nonexistent/path/file.rdb')
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
    it('should parse simple Valkey URL (redis:// scheme)', () => {
      const result = parseConnectionString('redis://127.0.0.1:6379/0')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 6379, 'Port should be 6379')
      assertEqual(result.database, '0', 'Database should be 0')
      assertEqual(result.password, undefined, 'Password should be undefined')
    })

    it('should parse URL with password', () => {
      const result = parseConnectionString(
        'redis://:mypassword@127.0.0.1:6379/0',
      )
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 6379, 'Port should be 6379')
      assertEqual(result.database, '0', 'Database should be 0')
      assertEqual(
        result.password,
        'mypassword',
        'Password should be mypassword',
      )
    })

    it('should parse URL with username and password', () => {
      const result = parseConnectionString(
        'redis://user:mypassword@127.0.0.1:6379/0',
      )
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(
        result.password,
        'mypassword',
        'Password should be mypassword',
      )
    })

    it('should parse URL with different database', () => {
      const result = parseConnectionString('redis://127.0.0.1:6379/5')
      assertEqual(result.database, '5', 'Database should be 5')
    })

    it('should use default port when not specified', () => {
      const result = parseConnectionString('redis://127.0.0.1/0')
      assertEqual(result.port, 6379, 'Port should default to 6379')
    })

    it('should use default database when not specified', () => {
      const result = parseConnectionString('redis://127.0.0.1:6379')
      assertEqual(result.database, '0', 'Database should default to 0')
    })

    it('should use default host when not specified', () => {
      const result = parseConnectionString('redis:///0')
      assertEqual(result.host, '127.0.0.1', 'Host should default to 127.0.0.1')
    })

    it('should handle rediss:// protocol (TLS)', () => {
      const result = parseConnectionString('rediss://127.0.0.1:6379/0')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 6379, 'Port should be 6379')
    })

    it('should throw for invalid database number', () => {
      let threw = false
      try {
        parseConnectionString('redis://127.0.0.1:6379/16')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('0-15'),
          'Error should mention valid range 0-15',
        )
      }
      assert(threw, 'Should throw for database > 15')
    })

    it('should throw for negative database number', () => {
      let threw = false
      try {
        parseConnectionString('redis://127.0.0.1:6379/-1')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('0-15'),
          'Error should mention valid range 0-15',
        )
      }
      assert(threw, 'Should throw for negative database')
    })

    it('should throw for non-redis protocol', () => {
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
      assert(threw, 'Should throw for non-redis protocol')
    })

    it('should throw for invalid URL', () => {
      let threw = false
      try {
        parseConnectionString('not-a-url')
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('Invalid'),
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
        parseConnectionString('redis://user:secretpass@:invalid')
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
