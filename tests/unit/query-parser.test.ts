import { describe, it } from 'node:test'
import {
  parseCSVToQueryResult,
  parseTSVToQueryResult,
  parseJSONToQueryResult,
  parseClickHouseJSONResult,
  parseSurrealDBResult,
  parseMongoDBResult,
  parseRedisResult,
  parseRESTAPIResult,
} from '../../core/query-parser'
import { assert, assertEqual, assertDeepEqual } from '../utils/assertions'

describe('Query Parser', () => {
  describe('parseCSVToQueryResult', () => {
    it('should parse simple CSV with headers', () => {
      const csv =
        'id,name,email\n1,Alice,alice@example.com\n2,Bob,bob@example.com'
      const result = parseCSVToQueryResult(csv)

      assertDeepEqual(
        result.columns,
        ['id', 'name', 'email'],
        'Columns should match',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 rows')
      assertEqual(result.rows[0].id, 1, 'First row id should be 1')
      assertEqual(
        result.rows[0].name,
        'Alice',
        'First row name should be Alice',
      )
      assertEqual(result.rows[1].id, 2, 'Second row id should be 2')
    })

    it('should handle quoted fields with commas', () => {
      const csv = 'id,description\n1,"Hello, World"\n2,"Test, with, commas"'
      const result = parseCSVToQueryResult(csv)

      assertEqual(
        result.rows[0].description,
        'Hello, World',
        'Should preserve commas in quoted fields',
      )
      assertEqual(
        result.rows[1].description,
        'Test, with, commas',
        'Should handle multiple commas',
      )
    })

    it('should handle escaped quotes', () => {
      const csv = 'id,value\n1,"He said ""hello"""\n2,"Test"'
      const result = parseCSVToQueryResult(csv)

      assertEqual(
        result.rows[0].value,
        'He said "hello"',
        'Should unescape double quotes',
      )
    })

    it('should convert numeric strings to numbers', () => {
      const csv = 'int_val,float_val,str_val\n42,3.14,hello'
      const result = parseCSVToQueryResult(csv)

      assertEqual(result.rows[0].int_val, 42, 'Integer should be converted')
      assertEqual(result.rows[0].float_val, 3.14, 'Float should be converted')
      assertEqual(
        result.rows[0].str_val,
        'hello',
        'String should remain string',
      )
    })

    it('should handle NULL values', () => {
      const csv = 'id,value\n1,NULL\n2,\\N\n3,'
      const result = parseCSVToQueryResult(csv)

      assertEqual(result.rows[0].value, null, 'NULL should become null')
      assertEqual(result.rows[1].value, null, '\\N should become null')
      assertEqual(result.rows[2].value, null, 'Empty should become null')
    })

    it('should handle boolean values', () => {
      const csv = 'id,active,verified\n1,true,t\n2,false,f'
      const result = parseCSVToQueryResult(csv)

      assertEqual(
        result.rows[0].active,
        true,
        'true should become boolean true',
      )
      assertEqual(result.rows[0].verified, true, 't should become boolean true')
      assertEqual(
        result.rows[1].active,
        false,
        'false should become boolean false',
      )
      assertEqual(
        result.rows[1].verified,
        false,
        'f should become boolean false',
      )
    })

    it('should return empty result for empty input', () => {
      const result = parseCSVToQueryResult('')

      assertDeepEqual(result.columns, [], 'Columns should be empty')
      assertDeepEqual(result.rows, [], 'Rows should be empty')
      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })

    it('should handle header-only CSV', () => {
      const csv = 'id,name,email'
      const result = parseCSVToQueryResult(csv)

      assertDeepEqual(
        result.columns,
        ['id', 'name', 'email'],
        'Columns should be parsed',
      )
      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })

    it('should handle Windows line endings', () => {
      const csv = 'id,name\r\n1,Alice\r\n2,Bob'
      const result = parseCSVToQueryResult(csv)

      assertEqual(result.rowCount, 2, 'Should handle CRLF line endings')
    })
  })

  describe('parseTSVToQueryResult', () => {
    it('should parse tab-separated values', () => {
      const tsv =
        'id\tname\temail\n1\tAlice\talice@example.com\n2\tBob\tbob@example.com'
      const result = parseTSVToQueryResult(tsv)

      assertDeepEqual(
        result.columns,
        ['id', 'name', 'email'],
        'Columns should match',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 rows')
      assertEqual(
        result.rows[0].name,
        'Alice',
        'First row name should be Alice',
      )
    })

    it('should convert types correctly', () => {
      const tsv = 'int_val\tfloat_val\tbool_val\n42\t3.14\ttrue'
      const result = parseTSVToQueryResult(tsv)

      assertEqual(result.rows[0].int_val, 42, 'Integer should be converted')
      assertEqual(result.rows[0].float_val, 3.14, 'Float should be converted')
      assertEqual(result.rows[0].bool_val, true, 'Boolean should be converted')
    })

    it('should return empty result for empty input', () => {
      const result = parseTSVToQueryResult('')

      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })
  })

  describe('parseJSONToQueryResult', () => {
    it('should parse array of objects', () => {
      const json = '[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]'
      const result = parseJSONToQueryResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'name'],
        'Columns should be extracted from first object',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 rows')
      assertEqual(result.rows[0].id, 1, 'First row id should be 1')
    })

    it('should handle empty array', () => {
      const json = '[]'
      const result = parseJSONToQueryResult(json)

      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })

    it('should handle single object', () => {
      const json = '{"count":42,"status":"ok"}'
      const result = parseJSONToQueryResult(json)

      assertDeepEqual(
        result.columns,
        ['count', 'status'],
        'Columns should match object keys',
      )
      assertEqual(result.rowCount, 1, 'Should have 1 row')
      assertEqual(result.rows[0].count, 42, 'Count should be 42')
    })

    it('should handle scalar value', () => {
      const json = '42'
      const result = parseJSONToQueryResult(json)

      assertDeepEqual(
        result.columns,
        ['result'],
        'Should use result as column name',
      )
      assertEqual(result.rows[0].result, 42, 'Value should be preserved')
    })

    it('should handle nested objects', () => {
      const json = '[{"id":1,"data":{"nested":"value"}}]'
      const result = parseJSONToQueryResult(json)

      assertEqual(result.rowCount, 1, 'Should have 1 row')
      assertDeepEqual(
        result.rows[0].data,
        { nested: 'value' },
        'Nested object should be preserved',
      )
    })
  })

  describe('parseClickHouseJSONResult', () => {
    it('should parse ClickHouse JSON format', () => {
      const json = JSON.stringify({
        meta: [
          { name: 'id', type: 'UInt64' },
          { name: 'name', type: 'String' },
        ],
        data: [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ],
        rows: 2,
        statistics: { elapsed: 0.001 },
      })
      const result = parseClickHouseJSONResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'name'],
        'Columns should be extracted from meta',
      )
      assertEqual(result.rowCount, 2, 'Row count should match')
      assertEqual(
        result.executionTimeMs,
        1,
        'Execution time should be converted to ms',
      )
    })

    it('should handle empty result', () => {
      const json = JSON.stringify({
        meta: [{ name: 'id', type: 'UInt64' }],
        data: [],
        rows: 0,
      })
      const result = parseClickHouseJSONResult(json)

      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })

    it('should handle missing statistics', () => {
      const json = JSON.stringify({
        meta: [{ name: 'count', type: 'UInt64' }],
        data: [{ count: 42 }],
        rows: 1,
      })
      const result = parseClickHouseJSONResult(json)

      assertEqual(
        result.executionTimeMs,
        undefined,
        'Execution time should be undefined',
      )
    })
  })

  describe('parseSurrealDBResult', () => {
    it('should parse SurrealDB result format', () => {
      const json = JSON.stringify([
        {
          result: [
            { id: 'user:1', name: 'Alice' },
            { id: 'user:2', name: 'Bob' },
          ],
          status: 'OK',
          time: '1.234ms',
        },
      ])
      const result = parseSurrealDBResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'name'],
        'Columns should be extracted',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 rows')
      assertEqual(
        result.executionTimeMs,
        1.234,
        'Execution time should be parsed',
      )
    })

    it('should handle microsecond timing', () => {
      const json = JSON.stringify([
        {
          result: [{ count: 1 }],
          status: 'OK',
          time: '500µs',
        },
      ])
      const result = parseSurrealDBResult(json)

      assertEqual(
        result.executionTimeMs,
        0.5,
        'Microseconds should be converted to ms',
      )
    })

    it('should handle second timing', () => {
      const json = JSON.stringify([
        {
          result: [{ count: 1 }],
          status: 'OK',
          time: '1.5s',
        },
      ])
      const result = parseSurrealDBResult(json)

      assertEqual(
        result.executionTimeMs,
        1500,
        'Seconds should be converted to ms',
      )
    })

    it('should handle empty result', () => {
      const json = JSON.stringify([
        {
          result: [],
          status: 'OK',
          time: '0.1ms',
        },
      ])
      const result = parseSurrealDBResult(json)

      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })

    it('should handle empty array response', () => {
      const json = '[]'
      const result = parseSurrealDBResult(json)

      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })

    it('should parse SurrealDB v2 double-nested array format', () => {
      // SurrealDB v2 with --json returns [[{...}, {...}]] format
      const json = JSON.stringify([
        [
          { id: 'user:1', name: 'Alice', email: 'alice@example.com' },
          { id: 'user:2', name: 'Bob', email: 'bob@example.com' },
        ],
      ])
      const result = parseSurrealDBResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'name', 'email'],
        'Columns should be extracted',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 rows')
      assertEqual(result.rows[0].name, 'Alice', 'First row should be Alice')
      assertEqual(result.rows[1].name, 'Bob', 'Second row should be Bob')
    })

    it('should handle SurrealDB v2 empty inner array', () => {
      const json = JSON.stringify([[]])
      const result = parseSurrealDBResult(json)

      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })
  })

  describe('parseMongoDBResult', () => {
    it('should parse array of documents', () => {
      const json = JSON.stringify([
        { _id: '1', name: 'Alice', age: 30 },
        { _id: '2', name: 'Bob', age: 25 },
      ])
      const result = parseMongoDBResult(json)

      assert(result.columns.includes('_id'), 'Columns should include _id')
      assert(result.columns.includes('name'), 'Columns should include name')
      assert(result.columns.includes('age'), 'Columns should include age')
      assertEqual(result.rowCount, 2, 'Should have 2 rows')
    })

    it('should collect all unique keys from documents with different fields', () => {
      const json = JSON.stringify([
        { _id: '1', name: 'Alice' },
        { _id: '2', email: 'bob@example.com' },
      ])
      const result = parseMongoDBResult(json)

      assert(result.columns.includes('_id'), 'Columns should include _id')
      assert(result.columns.includes('name'), 'Columns should include name')
      assert(result.columns.includes('email'), 'Columns should include email')
    })

    it('should handle empty array', () => {
      const json = '[]'
      const result = parseMongoDBResult(json)

      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })

    it('should handle single document', () => {
      const json = '{"_id":"1","name":"Alice"}'
      const result = parseMongoDBResult(json)

      assertEqual(result.rowCount, 1, 'Should have 1 row')
      assertEqual(result.rows[0].name, 'Alice', 'Name should be Alice')
    })
  })

  describe('parseRedisResult', () => {
    it('should parse KEYS command result', () => {
      const output = 'user:1\nuser:2\nuser:3'
      const result = parseRedisResult(output, 'KEYS user:*')

      assertDeepEqual(result.columns, ['value'], 'Should have value column')
      assertEqual(result.rowCount, 3, 'Should have 3 keys')
      assertEqual(result.rows[0].value, 'user:1', 'First key should match')
    })

    it('should parse SMEMBERS command result', () => {
      const output = 'member1\nmember2'
      const result = parseRedisResult(output, 'SMEMBERS myset')

      assertDeepEqual(result.columns, ['value'], 'Should have value column')
      assertEqual(result.rowCount, 2, 'Should have 2 members')
    })

    it('should parse HGETALL command result', () => {
      const output = 'field1\nvalue1\nfield2\nvalue2'
      const result = parseRedisResult(output, 'HGETALL myhash')

      assertDeepEqual(
        result.columns,
        ['key', 'value'],
        'Should have key and value columns',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 key-value pairs')
      assertEqual(result.rows[0].key, 'field1', 'First key should be field1')
      assertEqual(
        result.rows[0].value,
        'value1',
        'First value should be value1',
      )
    })

    it('should parse ZRANGE with WITHSCORES', () => {
      const output = 'member1\n1.5\nmember2\n2.5'
      const result = parseRedisResult(output, 'ZRANGE myset 0 -1 WITHSCORES')

      assertDeepEqual(
        result.columns,
        ['member', 'score'],
        'Should have member and score columns',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 members')
      assertEqual(result.rows[0].member, 'member1', 'First member should match')
      assertEqual(result.rows[0].score, 1.5, 'First score should be 1.5')
    })

    it('should parse INFO command result', () => {
      const output = '# Server\nredis_version:7.0.0\nredis_mode:standalone'
      const result = parseRedisResult(output, 'INFO')

      assertDeepEqual(
        result.columns,
        ['key', 'value'],
        'Should have key and value columns',
      )
      assertEqual(
        result.rows[0].key,
        'redis_version',
        'First key should be redis_version',
      )
      assertEqual(result.rows[0].value, '7.0.0', 'First value should be 7.0.0')
    })

    it('should parse TYPE command result', () => {
      const output = 'string'
      const result = parseRedisResult(output, 'TYPE mykey')

      assertDeepEqual(result.columns, ['type'], 'Should have type column')
      assertEqual(result.rows[0].type, 'string', 'Type should be string')
    })

    it('should parse SCAN command result', () => {
      const output = '0\nkey1\nkey2\nkey3'
      const result = parseRedisResult(output, 'SCAN 0')

      assertDeepEqual(result.columns, ['value'], 'Should have value column')
      assertEqual(result.rowCount, 3, 'Should have 3 keys (excluding cursor)')
    })

    it('should handle GET command as default', () => {
      const output = 'hello world'
      const result = parseRedisResult(output, 'GET mykey')

      assertDeepEqual(result.columns, ['result'], 'Should have result column')
      assertEqual(result.rows[0].result, 'hello world', 'Result should match')
    })

    it('should handle empty output', () => {
      const output = ''
      const result = parseRedisResult(output, 'KEYS nonexistent:*')

      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })
  })

  describe('parseRESTAPIResult', () => {
    it('should parse Qdrant result format', () => {
      const json = JSON.stringify({
        result: [
          { id: 1, payload: { name: 'Alice' } },
          { id: 2, payload: { name: 'Bob' } },
        ],
        status: 'ok',
        time: 0.001,
      })
      const result = parseRESTAPIResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'payload'],
        'Columns should be extracted',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 rows')
    })

    it('should parse Meilisearch hits format', () => {
      const json = JSON.stringify({
        hits: [
          { id: '1', title: 'Movie 1' },
          { id: '2', title: 'Movie 2' },
        ],
        query: 'action',
        processingTimeMs: 5,
      })
      const result = parseRESTAPIResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'title'],
        'Columns should be extracted from hits',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 hits')
      assertEqual(
        result.executionTimeMs,
        5,
        'Processing time should be captured',
      )
    })

    it('should parse CouchDB rows format', () => {
      const json = JSON.stringify({
        rows: [
          { id: 'doc1', key: 'doc1', value: { rev: '1-abc' } },
          { id: 'doc2', key: 'doc2', value: { rev: '1-def' } },
        ],
        total_rows: 2,
      })
      const result = parseRESTAPIResult(json)

      assertDeepEqual(
        result.columns,
        ['id', 'key', 'value'],
        'Columns should be extracted from rows',
      )
      assertEqual(result.rowCount, 2, 'Should have 2 rows')
    })

    it('should handle single object result', () => {
      const json = JSON.stringify({
        result: { name: 'test_collection', vectors_count: 100 },
        status: 'ok',
      })
      const result = parseRESTAPIResult(json)

      assertEqual(result.rowCount, 1, 'Should have 1 row')
      assertEqual(result.rows[0].name, 'test_collection', 'Name should match')
    })

    it('should handle scalar result', () => {
      const json = JSON.stringify({
        result: 42,
        status: 'ok',
      })
      const result = parseRESTAPIResult(json)

      assertEqual(
        result.rows[0].result,
        42,
        'Scalar result should be preserved',
      )
    })

    it('should handle empty array result', () => {
      const json = JSON.stringify({
        result: [],
        status: 'ok',
      })
      const result = parseRESTAPIResult(json)

      assertEqual(result.rowCount, 0, 'Row count should be 0')
    })

    it('should handle array of primitives', () => {
      const json = JSON.stringify({
        result: ['collection1', 'collection2', 'collection3'],
        status: 'ok',
      })
      const result = parseRESTAPIResult(json)

      assertDeepEqual(
        result.columns,
        ['value'],
        'Should use value column for primitives',
      )
      assertEqual(result.rowCount, 3, 'Should have 3 rows')
      assertEqual(
        result.rows[0].value,
        'collection1',
        'First value should match',
      )
    })

    it('should fall back to generic JSON parsing', () => {
      const json = '[{"a":1},{"a":2}]'
      const result = parseRESTAPIResult(json)

      assertEqual(result.rowCount, 2, 'Should parse as array')
    })
  })
})
