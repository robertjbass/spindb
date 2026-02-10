/**
 * InfluxDB restore module unit tests
 */

import { describe, it, before, after } from 'node:test'
import { join } from 'path'
import { writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  detectBackupFormat,
  encodeFieldValue,
  parseConnectionString,
} from '../../engines/influxdb/restore'

describe('InfluxDB Restore Module', () => {
  const testDir = join(tmpdir(), 'influxdb-test-' + Date.now())

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

    it('should detect .sql file by extension', async () => {
      const sqlPath = join(testDir, 'test.sql')
      await writeFile(
        sqlPath,
        '-- InfluxDB SQL Backup\nINSERT INTO "cpu" VALUES (1);',
      )

      const format = await detectBackupFormat(sqlPath)
      assertEqual(format.format, 'sql', 'Should detect as sql')
      assert(
        format.description.includes('SQL'),
        'Description should mention SQL',
      )

      await rm(sqlPath, { force: true })
    })

    it('should detect SQL content by magic content', async () => {
      const contentPath = join(testDir, 'backup.dat')
      await writeFile(
        contentPath,
        '-- InfluxDB SQL Backup\nINSERT INTO "cpu" VALUES (1);',
      )

      const format = await detectBackupFormat(contentPath)
      assertEqual(format.format, 'sql', 'Should detect SQL by content')

      await rm(contentPath, { force: true })
    })

    it('should detect generic SQL content with warning description', async () => {
      const genericPath = join(testDir, 'generic.dat')
      await writeFile(
        genericPath,
        'INSERT INTO "cpu" ("time", "value") VALUES (\'2024-01-01\', 42);',
      )

      const format = await detectBackupFormat(genericPath)
      assertEqual(format.format, 'sql', 'Should detect as sql')
      assert(
        format.description.includes('generic markers'),
        'Description should mention generic markers',
      )

      await rm(genericPath, { force: true })
    })

    it('should return unknown for non-SQL files', async () => {
      const textPath = join(testDir, 'backup.txt')
      await writeFile(textPath, 'This is not a SQL dump')

      const format = await detectBackupFormat(textPath)
      assertEqual(format.format, 'unknown', 'Should detect as unknown')

      await rm(textPath, { force: true })
    })

    it('should throw for non-existent file', async () => {
      try {
        await detectBackupFormat('/nonexistent/path/file.sql')
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

  describe('encodeFieldValue', () => {
    it('should encode plain integers with trailing "i"', () => {
      assertEqual(encodeFieldValue('123'), '123i', '"123" should be integer')
      assertEqual(encodeFieldValue('0'), '0i', '"0" should be integer')
      assertEqual(encodeFieldValue('-42'), '-42i', '"-42" should be integer')
    })

    it('should encode values with decimal point as floats (no "i")', () => {
      assertEqual(encodeFieldValue('123.0'), '123', '"123.0" should be float')
      assertEqual(encodeFieldValue('3.14'), '3.14', '"3.14" should be float')
      assertEqual(encodeFieldValue('-0.5'), '-0.5', '"-0.5" should be float')
    })

    it('should encode values with exponent notation as floats (no "i")', () => {
      assertEqual(encodeFieldValue('1e3'), '1000', '"1e3" should be float')
      assertEqual(encodeFieldValue('1E3'), '1000', '"1E3" should be float')
      assertEqual(encodeFieldValue('2.5e2'), '250', '"2.5e2" should be float')
    })

    it('should encode booleans unquoted', () => {
      assertEqual(encodeFieldValue('true'), 'true', 'true should be unquoted')
      assertEqual(
        encodeFieldValue('false'),
        'false',
        'false should be unquoted',
      )
    })

    it('should encode strings with double quotes and escaping', () => {
      assertEqual(
        encodeFieldValue('hello'),
        '"hello"',
        'Strings should be quoted',
      )
      assertEqual(
        encodeFieldValue('say "hi"'),
        '"say \\"hi\\""',
        'Embedded quotes should be escaped',
      )
      assertEqual(
        encodeFieldValue('back\\slash'),
        '"back\\\\slash"',
        'Backslashes should be escaped',
      )
    })

    it('should encode empty string as quoted string', () => {
      assertEqual(
        encodeFieldValue(''),
        '""',
        'Empty string should be quoted empty',
      )
    })
  })

  describe('parseConnectionString', () => {
    it('should parse http connection string', () => {
      const result = parseConnectionString('http://127.0.0.1:8086')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 8086, 'Port should be 8086')
      assertEqual(result.protocol, 'http', 'Protocol should be http')
    })

    it('should parse https connection string', () => {
      const result = parseConnectionString('https://influxdb.example.com:8086')
      assertEqual(result.host, 'influxdb.example.com', 'Host should be correct')
      assertEqual(result.port, 8086, 'Port should be 8086')
      assertEqual(result.protocol, 'https', 'Protocol should preserve https')
    })

    it('should parse influxdb:// scheme as http', () => {
      const result = parseConnectionString('influxdb://127.0.0.1:8086')
      assertEqual(result.host, '127.0.0.1', 'Host should be 127.0.0.1')
      assertEqual(result.port, 8086, 'Port should be 8086')
      assertEqual(result.protocol, 'http', 'influxdb:// should map to http')
    })

    it('should use InfluxDB default port for http without explicit port', () => {
      const result = parseConnectionString('http://127.0.0.1')
      assertEqual(
        result.port,
        8086,
        'Default port should be 8086 (InfluxDB default, not standard HTTP 80)',
      )
    })

    it('should parse database from query parameter', () => {
      const result = parseConnectionString('http://127.0.0.1:8086?db=mydb')
      assertEqual(result.database, 'mydb', 'Should extract database from query')
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
        parseConnectionString('ftp://127.0.0.1:8086')
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
