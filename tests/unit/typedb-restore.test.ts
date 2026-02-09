/**
 * TypeDB restore module unit tests
 */

import { describe, it, before, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  parseConnectionString,
} from '../../engines/typedb/restore'

describe('TypeDB Restore Module', () => {
  const testDir = join(tmpdir(), 'typedb-test-' + Date.now())

  after(async () => {
    try {
      await rm(testDir, { recursive: true, force: true })
    } catch {
      // Ignore errors (e.g., ENOENT if already cleaned up)
    }
  })

  describe('detectBackupFormat', () => {
    before(async () => {
      await mkdir(testDir, { recursive: true })
    })

    it('should detect .typeql file by extension', async () => {
      const typeqlPath = join(testDir, 'backup.typeql')
      await writeFile(
        typeqlPath,
        'define\n\nperson sub entity, owns name;\nname sub attribute, value string;',
      )

      const format = await detectBackupFormat(typeqlPath)
      assertEqual(format.format, 'typeql', 'Should detect as typeql')
      assert(
        format.description.includes('TypeQL') ||
          format.description.includes('TypeDB'),
        'Description should mention TypeQL or TypeDB',
      )

      await rm(typeqlPath, { force: true })
    })

    it('should detect .tql file by extension', async () => {
      const tqlPath = join(testDir, 'backup.tql')
      await writeFile(
        tqlPath,
        'define\n\nperson sub entity, owns name;\nname sub attribute, value string;',
      )

      const format = await detectBackupFormat(tqlPath)
      assertEqual(format.format, 'typeql', 'Should detect .tql as typeql')

      await rm(tqlPath, { force: true })
    })

    it('should detect TypeQL content by keywords', async () => {
      const backupPath = join(testDir, 'backup.bak')
      await writeFile(
        backupPath,
        'DEFINE\nperson SUB entity, OWNS name;\nname SUB attribute, value string;',
      )

      const format = await detectBackupFormat(backupPath)
      assertEqual(format.format, 'typeql', 'Should detect TypeQL by content')

      await rm(backupPath, { force: true })
    })

    it('should return unknown for non-TypeQL files', async () => {
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a TypeQL backup')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', 'Should detect as unknown')

      await rm(textPath, { force: true })
    })

    it('should throw for non-existent file', async () => {
      try {
        await detectBackupFormat(join(testDir, 'nonexistent.typeql'))
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
      }
    })
  })

  describe('parseConnectionString', () => {
    it('should parse typedb connection string', () => {
      const result = parseConnectionString('typedb://127.0.0.1:1729/mydb')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 1729, 'Port should be 1729')
      assertEqual(result.database, 'mydb', 'Database should be mydb')
    })

    it('should use default port when not specified', () => {
      const result = parseConnectionString('typedb://127.0.0.1/mydb')
      assertEqual(result.port, 1729, 'Default port should be 1729')
    })

    it('should use default database when not specified', () => {
      const result = parseConnectionString('typedb://127.0.0.1:1729')
      assertEqual(
        result.database,
        'default',
        'Default database should be default',
      )
    })

    it('should use default host when not specified', () => {
      const result = parseConnectionString('typedb:///mydb')
      assertEqual(result.host, '127.0.0.1', 'Default host should be 127.0.0.1')
    })

    it('should throw for invalid connection string', () => {
      try {
        parseConnectionString('invalid')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
      }
    })

    it('should throw for non-typedb protocol', () => {
      try {
        parseConnectionString('postgresql://127.0.0.1:1729/mydb')
        assert(false, 'Should have thrown')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          (error as Error).message.includes('unsupported protocol'),
          'Should mention unsupported protocol',
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
