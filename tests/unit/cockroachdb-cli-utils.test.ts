/**
 * Unit tests for CockroachDB CLI utilities
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'
import {
  escapeSqlValue,
  parseCsvLine,
  isInsecureConnection,
  escapeCockroachIdentifier,
} from '../../engines/cockroachdb/cli-utils'

describe('CockroachDB CLI Utils', () => {
  describe('escapeSqlValue', () => {
    it('should return NULL for null values', () => {
      assert.strictEqual(escapeSqlValue(null), 'NULL')
    })

    it('should return NULL for undefined values', () => {
      assert.strictEqual(escapeSqlValue(undefined), 'NULL')
    })

    it('should return NULL for unquoted empty strings', () => {
      assert.strictEqual(escapeSqlValue(''), 'NULL')
      assert.strictEqual(escapeSqlValue('', false), 'NULL')
    })

    it('should return empty string for quoted empty strings', () => {
      assert.strictEqual(escapeSqlValue('', true), "''")
    })

    it('should treat literal NULL string as a string value', () => {
      // Literal "NULL" is a string, not SQL NULL - prevents data corruption
      // CockroachDB CSV uses empty unquoted fields for NULL, not string sentinels
      assert.strictEqual(escapeSqlValue('NULL'), "'NULL'")
    })

    it('should treat \\N as a string value', () => {
      // Literal "\\N" is a string, not SQL NULL - prevents data corruption
      assert.strictEqual(escapeSqlValue('\\N'), "'\\N'")
    })

    it('should return TRUE for boolean true values', () => {
      assert.strictEqual(escapeSqlValue('true'), 'TRUE')
      assert.strictEqual(escapeSqlValue('TRUE'), 'TRUE')
      assert.strictEqual(escapeSqlValue('t'), 'TRUE')
    })

    it('should return FALSE for boolean false values', () => {
      assert.strictEqual(escapeSqlValue('false'), 'FALSE')
      assert.strictEqual(escapeSqlValue('FALSE'), 'FALSE')
      assert.strictEqual(escapeSqlValue('f'), 'FALSE')
    })

    it('should return numbers unquoted', () => {
      assert.strictEqual(escapeSqlValue('42'), '42')
      assert.strictEqual(escapeSqlValue('-123'), '-123')
      assert.strictEqual(escapeSqlValue('3.14'), '3.14')
      assert.strictEqual(escapeSqlValue('-0.5'), '-0.5')
    })

    it('should quote strings', () => {
      assert.strictEqual(escapeSqlValue('hello'), "'hello'")
      assert.strictEqual(escapeSqlValue('world'), "'world'")
    })

    it('should escape single quotes in strings', () => {
      assert.strictEqual(escapeSqlValue("it's"), "'it''s'")
      assert.strictEqual(escapeSqlValue("Bob's data"), "'Bob''s data'")
      assert.strictEqual(escapeSqlValue("'quoted'"), "'''quoted'''")
    })

    it('should handle strings that look like numbers but are not', () => {
      assert.strictEqual(escapeSqlValue('42abc'), "'42abc'")
      assert.strictEqual(escapeSqlValue('3.14.15'), "'3.14.15'")
    })
  })

  describe('parseCsvLine', () => {
    it('should parse simple CSV with no quotes', () => {
      const result = parseCsvLine('a,b,c')
      assert.deepStrictEqual(result, [
        { value: 'a', wasQuoted: false },
        { value: 'b', wasQuoted: false },
        { value: 'c', wasQuoted: false },
      ])
    })

    it('should parse CSV with quoted fields', () => {
      const result = parseCsvLine('"hello","world"')
      assert.deepStrictEqual(result, [
        { value: 'hello', wasQuoted: true },
        { value: 'world', wasQuoted: true },
      ])
    })

    it('should handle commas inside quoted fields', () => {
      const result = parseCsvLine('"hello, world",test')
      assert.deepStrictEqual(result, [
        { value: 'hello, world', wasQuoted: true },
        { value: 'test', wasQuoted: false },
      ])
    })

    it('should handle escaped quotes (double quotes)', () => {
      const result = parseCsvLine('"say ""hello""",test')
      assert.deepStrictEqual(result, [
        { value: 'say "hello"', wasQuoted: true },
        { value: 'test', wasQuoted: false },
      ])
    })

    it('should handle mixed quoted and unquoted fields', () => {
      const result = parseCsvLine('1,"hello",3')
      assert.deepStrictEqual(result, [
        { value: '1', wasQuoted: false },
        { value: 'hello', wasQuoted: true },
        { value: '3', wasQuoted: false },
      ])
    })

    it('should handle empty fields (unquoted - should become NULL)', () => {
      const result = parseCsvLine('a,,c')
      assert.deepStrictEqual(result, [
        { value: 'a', wasQuoted: false },
        { value: '', wasQuoted: false },
        { value: 'c', wasQuoted: false },
      ])
      // Verify unquoted empty becomes NULL
      assert.strictEqual(escapeSqlValue(result[1].value, result[1].wasQuoted), 'NULL')
    })

    it('should handle empty quoted fields (should preserve as empty string)', () => {
      const result = parseCsvLine('"",b,""')
      assert.deepStrictEqual(result, [
        { value: '', wasQuoted: true },
        { value: 'b', wasQuoted: false },
        { value: '', wasQuoted: true },
      ])
      // Verify quoted empty becomes empty string, not NULL
      assert.strictEqual(escapeSqlValue(result[0].value, result[0].wasQuoted), "''")
      assert.strictEqual(escapeSqlValue(result[2].value, result[2].wasQuoted), "''")
    })
  })

  describe('isInsecureConnection', () => {
    it('should return true for sslmode=disable', () => {
      assert.strictEqual(
        isInsecureConnection('postgresql://root@host:26257/db?sslmode=disable'),
        true,
      )
    })

    it('should return true for localhost without sslmode', () => {
      assert.strictEqual(
        isInsecureConnection('postgresql://root@localhost:26257/db'),
        true,
      )
      assert.strictEqual(
        isInsecureConnection('postgresql://root@127.0.0.1:26257/db'),
        true,
      )
      assert.strictEqual(
        isInsecureConnection('postgresql://root@[::1]:26257/db'),
        true,
      )
    })

    it('should return false for localhost with sslmode=require', () => {
      assert.strictEqual(
        isInsecureConnection('postgresql://root@localhost:26257/db?sslmode=require'),
        false,
      )
    })

    it('should return false for remote hosts without sslmode', () => {
      assert.strictEqual(
        isInsecureConnection('postgresql://root@remote.example.com:26257/db'),
        false,
      )
    })

    it('should return false for remote hosts with sslmode=require', () => {
      assert.strictEqual(
        isInsecureConnection('postgresql://root@remote.example.com:26257/db?sslmode=require'),
        false,
      )
    })

    it('should return false for invalid connection strings', () => {
      assert.strictEqual(isInsecureConnection('not-a-url'), false)
    })
  })

  describe('escapeCockroachIdentifier', () => {
    it('should wrap identifiers in double quotes', () => {
      assert.strictEqual(escapeCockroachIdentifier('users'), '"users"')
    })

    it('should escape existing double quotes', () => {
      assert.strictEqual(escapeCockroachIdentifier('my"table'), '"my""table"')
    })

    it('should handle reserved words', () => {
      assert.strictEqual(escapeCockroachIdentifier('select'), '"select"')
    })
  })
})
