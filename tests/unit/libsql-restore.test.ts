/**
 * libSQL restore module unit tests
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { detectBackupFormat } from '../../engines/libsql/restore'

describe('libSQL Restore Module', () => {
  describe('detectBackupFormat', () => {
    it('should detect .sql file as sql format', () => {
      const format = detectBackupFormat('/path/to/backup.sql')
      assertEqual(format.format, 'sql', 'Should detect as sql')
      assert(
        format.description.includes('SQL'),
        'Description should mention SQL',
      )
    })

    it('should detect .db file as binary format', () => {
      const format = detectBackupFormat('/path/to/backup.db')
      assertEqual(format.format, 'binary', 'Should detect as binary')
      assert(
        format.description.includes('Binary'),
        'Description should mention Binary',
      )
    })

    it('should default to binary for unknown extensions', () => {
      const format = detectBackupFormat('/path/to/backup.bak')
      assertEqual(format.format, 'binary', 'Should default to binary')
      assert(
        format.description.includes('assumed'),
        'Description should mention assumed',
      )
    })

    it('should default to binary for files with no extension', () => {
      const format = detectBackupFormat('/path/to/backup')
      assertEqual(format.format, 'binary', 'Should default to binary')
    })

    it('should include restore command in result', () => {
      const format = detectBackupFormat('/path/to/backup.sql')
      assert(
        format.restoreCommand !== undefined,
        'Should include restore command',
      )
      assert(
        format.restoreCommand!.includes('spindb restore'),
        'Restore command should include spindb restore',
      )
    })

    it('should include file path in restore command', () => {
      const filePath = '/path/to/backup.db'
      const format = detectBackupFormat(filePath)
      assert(
        format.restoreCommand!.includes(filePath),
        'Restore command should include file path',
      )
    })
  })
})
