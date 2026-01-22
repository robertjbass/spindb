/**
 * Qdrant restore module unit tests
 */

import { describe, it, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import { detectBackupFormat, parseConnectionString } from '../../engines/qdrant/restore'

describe('Qdrant Restore Module', () => {
  const testDir = join(tmpdir(), 'qdrant-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore errors (e.g., ENOENT if already cleaned up)
    }
  })

  describe('detectBackupFormat', () => {

    it('should detect .snapshot file by extension', async () => {
      await mkdir(testDir, { recursive: true })
      const snapshotPath = join(testDir, 'test.snapshot')
      // Write some gzip-like content (just for testing)
      await writeFile(snapshotPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]))

      const format = await detectBackupFormat(snapshotPath)
      assertEqual(format.format, 'snapshot', 'Should detect as snapshot')
      assert(
        format.description.includes('snapshot'),
        'Description should mention snapshot',
      )

      await rm(snapshotPath, { force: true })
    })

    it('should detect gzip content by magic bytes', async () => {
      await mkdir(testDir, { recursive: true })
      const gzipPath = join(testDir, 'backup.gz')
      // Write gzip magic bytes
      await writeFile(gzipPath, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]))

      const format = await detectBackupFormat(gzipPath)
      assertEqual(format.format, 'snapshot', 'Should detect gzip as snapshot')

      await rm(gzipPath, { force: true })
    })

    it('should return unknown for non-snapshot files', async () => {
      await mkdir(testDir, { recursive: true })
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a snapshot')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', 'Should detect as unknown')

      await rm(textPath, { force: true })
    })

    it('should throw for non-existent file', async () => {
      try {
        await detectBackupFormat('/nonexistent/path/file.snapshot')
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
    it('should parse http connection string', () => {
      const result = parseConnectionString('http://127.0.0.1:6333')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 6333, 'Port should be 6333')
      assertEqual(result.protocol, 'http', 'Protocol should be http')
    })

    it('should parse https connection string', () => {
      const result = parseConnectionString('https://qdrant.example.com:6333')
      assertEqual(result.host, 'qdrant.example.com', 'Host should be correct')
      assertEqual(result.port, 6333, 'Port should be 6333')
      assertEqual(result.protocol, 'https', 'Protocol should preserve https')
    })

    it('should parse grpc connection string', () => {
      const result = parseConnectionString('grpc://127.0.0.1:6334')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 6334, 'Port should be 6334')
      assertEqual(result.protocol, 'grpc', 'Protocol should be grpc')
    })

    it('should use default port for http', () => {
      const result = parseConnectionString('http://127.0.0.1')
      assertEqual(result.port, 6333, 'Default HTTP port should be 6333')
    })

    it('should use default port for grpc', () => {
      const result = parseConnectionString('grpc://127.0.0.1')
      assertEqual(result.port, 6334, 'Default gRPC port should be 6334')
    })

    it('should throw for invalid connection string', () => {
      try {
        parseConnectionString('invalid')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
      }
    })

    it('should throw for unsupported protocol', () => {
      try {
        parseConnectionString('ftp://127.0.0.1:6333')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          (error as Error).message.includes('unsupported protocol'),
          'Error should mention unsupported protocol',
        )
      }
    })

    it('should throw for empty connection string', () => {
      try {
        parseConnectionString('')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
      }
    })
  })
})
