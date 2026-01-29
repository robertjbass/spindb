/**
 * CouchDB restore module unit tests
 */

import { describe, it, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/couchdb/restore'

describe('CouchDB Restore Module', () => {
  const testDir = join(tmpdir(), 'couchdb-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore errors (e.g., ENOENT if already cleaned up)
    }
  })

  describe('detectBackupFormat', () => {
    it('should detect .json file by extension', async () => {
      await mkdir(testDir, { recursive: true })
      const jsonPath = join(testDir, 'backup.json')
      await writeFile(jsonPath, JSON.stringify({ version: '1', databases: [] }))

      const format = await detectBackupFormat(jsonPath)
      assertEqual(format.format, 'json', 'Should detect as json')
      assert(
        format.description.includes('JSON'),
        'Description should mention JSON',
      )

      await rm(jsonPath, { force: true })
    })

    it('should detect .couchdb file by extension', async () => {
      await mkdir(testDir, { recursive: true })
      const couchdbPath = join(testDir, 'backup.couchdb')
      await writeFile(
        couchdbPath,
        JSON.stringify({ version: '1', databases: [] }),
      )

      const format = await detectBackupFormat(couchdbPath)
      assertEqual(format.format, 'json', 'Should detect as json')

      await rm(couchdbPath, { force: true })
    })

    it('should detect JSON content by structure', async () => {
      await mkdir(testDir, { recursive: true })
      const backupPath = join(testDir, 'backup.bak')
      await writeFile(
        backupPath,
        JSON.stringify({ version: '1', databases: [] }),
      )

      const format = await detectBackupFormat(backupPath)
      assertEqual(format.format, 'json', 'Should detect JSON by content')

      await rm(backupPath, { force: true })
    })

    it('should return unknown for non-JSON files', async () => {
      await mkdir(testDir, { recursive: true })
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a JSON backup')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', 'Should detect as unknown')

      await rm(textPath, { force: true })
    })

    it('should return unknown for directories', async () => {
      await mkdir(testDir, { recursive: true })
      const dirPath = join(testDir, 'backup-dir')
      await mkdir(dirPath, { recursive: true })

      const format = await detectBackupFormat(dirPath)
      assertEqual(
        format.format,
        'unknown',
        'Should detect directory as unknown',
      )
      assert(
        format.description.includes('Directory'),
        'Description should mention directory',
      )

      await rm(dirPath, { recursive: true, force: true })
    })

    it('should throw for non-existent file', async () => {
      try {
        await detectBackupFormat('/nonexistent/path/file.json')
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
      const result = parseConnectionString('http://127.0.0.1:5984')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 5984, 'Port should be 5984')
      assertEqual(result.protocol, 'http', 'Protocol should be http')
    })

    it('should parse https connection string', () => {
      const result = parseConnectionString('https://couchdb.example.com:6984')
      assertEqual(result.host, 'couchdb.example.com', 'Host should be correct')
      assertEqual(result.port, 6984, 'Port should be 6984')
      assertEqual(result.protocol, 'https', 'Protocol should preserve https')
    })

    it('should parse connection string with database', () => {
      const result = parseConnectionString('http://127.0.0.1:5984/mydb')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 5984, 'Port should be 5984')
      assertEqual(result.database, 'mydb', 'Database should be mydb')
    })

    it('should use CouchDB default port when not specified', () => {
      const result = parseConnectionString('http://127.0.0.1')
      assertEqual(
        result.port,
        5984,
        'Default port should be 5984 (CouchDB default)',
      )
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
        parseConnectionString('ftp://127.0.0.1:5984')
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
