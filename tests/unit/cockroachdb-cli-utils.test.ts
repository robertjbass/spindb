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

    it('should return NULL for empty strings', () => {
      assert.strictEqual(escapeSqlValue(''), 'NULL')
    })

    it('should return NULL for literal NULL string', () => {
      assert.strictEqual(escapeSqlValue('NULL'), 'NULL')
    })

    it('should return NULL for \\N (common CSV null marker)', () => {
      assert.strictEqual(escapeSqlValue('\\N'), 'NULL')
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
      assert.deepStrictEqual(result, ['a', 'b', 'c'])
    })

    it('should parse CSV with quoted fields', () => {
      const result = parseCsvLine('"hello","world"')
      assert.deepStrictEqual(result, ['hello', 'world'])
    })

    it('should handle commas inside quoted fields', () => {
      const result = parseCsvLine('"hello, world",test')
      assert.deepStrictEqual(result, ['hello, world', 'test'])
    })

    it('should handle escaped quotes (double quotes)', () => {
      const result = parseCsvLine('"say ""hello""",test')
      assert.deepStrictEqual(result, ['say "hello"', 'test'])
    })

    it('should handle mixed quoted and unquoted fields', () => {
      const result = parseCsvLine('1,"hello",3')
      assert.deepStrictEqual(result, ['1', 'hello', '3'])
    })

    it('should handle empty fields', () => {
      const result = parseCsvLine('a,,c')
      assert.deepStrictEqual(result, ['a', '', 'c'])
    })

    it('should handle empty quoted fields', () => {
      const result = parseCsvLine('"",b,""')
      assert.deepStrictEqual(result, ['', 'b', ''])
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
