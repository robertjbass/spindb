/**
 * Unit tests for FerretDB backup format detection
 */

import { describe, it, before, after } from 'node:test'
import { assertEqual, assert } from '../utils/assertions'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectBackupFormat } from '../../engines/ferretdb/restore'

describe('FerretDB Backup Format Detection', () => {
  const testDir = join(tmpdir(), 'ferretdb-test-' + Date.now())

  before(async () => {
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  describe('detectBackupFormat', () => {
    it('should detect SQL format by extension', async () => {
      const sqlFile = join(testDir, 'backup.sql')
      await writeFile(sqlFile, '-- PostgreSQL dump\nCREATE TABLE...')

      const format = await detectBackupFormat(sqlFile)
      assert(
        format.format === 'sql',
        `Expected sql format, got ${format.format}`,
      )
    })

    it('should detect custom format by extension', async () => {
      const dumpFile = join(testDir, 'backup.dump')
      // Write PGDMP header (PostgreSQL custom format magic)
      const header = Buffer.from('PGDMP')
      await writeFile(dumpFile, header)

      const format = await detectBackupFormat(dumpFile)
      assertEqual(format.format, 'custom', 'Should detect custom format')
    })

    it('should detect SQL format by content', async () => {
      const sqlFile = join(testDir, 'test-backup')
      await writeFile(sqlFile, '-- PostgreSQL database dump\n...')

      const format = await detectBackupFormat(sqlFile)
      assertEqual(format.format, 'sql', 'Should detect SQL format')
    })

    it('should throw error for non-existent file', async () => {
      try {
        await detectBackupFormat(join(testDir, 'nonexistent.sql'))
        assert(false, 'Should have thrown an error')
      } catch (error) {
        const err = error as Error & { code?: string }
        assert(
          err.code === 'ENOENT' ||
            err.message.includes('no such file') ||
            err.message.includes('ENOENT') ||
            err.message.includes('not found'),
          `Expected file not found error, got: ${err.message}`,
        )
      }
    })

    it('should include restore command hint', async () => {
      const sqlFile = join(testDir, 'hint-backup.sql')
      await writeFile(sqlFile, '-- SQL backup')

      const format = await detectBackupFormat(sqlFile)
      assert(
        format.restoreCommand !== undefined,
        'Should include restore command',
      )
      assert(
        format.restoreCommand.includes('psql') ||
          format.restoreCommand.includes('pg_restore'),
        'Restore command should mention psql or pg_restore',
      )
    })

    it('should detect directory format', async () => {
      const dirPath = join(testDir, 'backup-dir')
      await mkdir(dirPath, { recursive: true })

      const format = await detectBackupFormat(dirPath)
      assertEqual(format.format, 'directory', 'Should detect directory format')
    })

    it('should return unknown format for unrecognized file', async () => {
      const unknownFile = join(testDir, 'backup.xyz')
      // Write random binary content that doesn't match any known format
      const randomContent = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd])
      await writeFile(unknownFile, randomContent)

      const format = await detectBackupFormat(unknownFile)
      assertEqual(format.format, 'unknown', 'Should return unknown for unrecognized format')
      assert(
        format.description.toLowerCase().includes('unknown'),
        `Description should mention unknown: ${format.description}`,
      )
      assert(
        format.restoreCommand.includes('pg_restore'),
        'Should fallback to pg_restore for unknown formats',
      )
    })
  })
})
