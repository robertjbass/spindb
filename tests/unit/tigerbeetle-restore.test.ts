/**
 * TigerBeetle restore module unit tests
 */

import { describe, it, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/tigerbeetle/restore'

describe('TigerBeetle Restore Module', () => {
  const testDir = join(tmpdir(), 'tigerbeetle-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore errors
    }
  })

  describe('detectBackupFormat', () => {
    it('should detect .tigerbeetle file by extension', async () => {
      await mkdir(testDir, { recursive: true })
      const dataPath = join(testDir, '0_0.tigerbeetle')
      await writeFile(dataPath, Buffer.alloc(64))

      const format = await detectBackupFormat(dataPath)
      assertEqual(format.format, 'binary', 'Should detect as binary')
      assert(
        format.description.includes('TigerBeetle'),
        'Description should mention TigerBeetle',
      )

      await rm(dataPath, { force: true })
    })

    it('should detect any regular file as binary (assumed data file)', async () => {
      await mkdir(testDir, { recursive: true })
      const dataPath = join(testDir, 'backup-data')
      await writeFile(dataPath, Buffer.alloc(32))

      const format = await detectBackupFormat(dataPath)
      assertEqual(format.format, 'binary', 'Should detect as binary')

      await rm(dataPath, { force: true })
    })

    it('should throw for non-existent file', async () => {
      try {
        await detectBackupFormat('/nonexistent/path/file.tigerbeetle')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          (error as Error).message.includes('not found'),
          'Error should mention file not found',
        )
      }
    })
  })

  describe('parseConnectionString', () => {
    it('should parse host:port format', () => {
      const result = parseConnectionString('127.0.0.1:3000')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 3000, 'Port should be 3000')
    })

    it('should parse custom host and port', () => {
      const result = parseConnectionString('192.168.1.100:4000')
      assertEqual(result.host, '192.168.1.100', 'Host should be correct')
      assertEqual(result.port, 4000, 'Port should be 4000')
    })

    it('should parse localhost', () => {
      const result = parseConnectionString('localhost:3000')
      assertEqual(result.host, 'localhost', 'Host should be localhost')
      assertEqual(result.port, 3000, 'Port should be 3000')
    })

    it('should throw for missing port', () => {
      try {
        parseConnectionString('127.0.0.1')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          (error as Error).message.includes('host:port'),
          'Error should mention expected format',
        )
      }
    })

    it('should throw for invalid port', () => {
      try {
        parseConnectionString('127.0.0.1:abc')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          (error as Error).message.includes('port'),
          'Error should mention port',
        )
      }
    })

    it('should throw for empty string', () => {
      try {
        parseConnectionString('')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
      }
    })

    it('should throw for port out of range', () => {
      try {
        parseConnectionString('127.0.0.1:70000')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
      }
    })
  })
})
