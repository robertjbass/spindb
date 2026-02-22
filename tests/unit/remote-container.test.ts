import { describe, it } from 'node:test'
import {
  parseConnectionString,
  detectEngineFromConnectionString,
  detectProvider,
  isLocalhost,
  generateRemoteContainerName,
  redactConnectionString,
  buildRemoteConfig,
  getDefaultPortForEngine,
} from '../../core/remote-container'
import { Engine, isRemoteContainer } from '../../types'
import type { ContainerConfig } from '../../types'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

describe('remote-container', () => {
  describe('parseConnectionString', () => {
    it('should parse a PostgreSQL connection string', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@host.example.com:5432/mydb',
      )
      assertEqual(result.scheme, 'postgresql', 'scheme should be postgresql')
      assertEqual(result.host, 'host.example.com', 'host should match')
      assertEqual(result.port, 5432, 'port should be 5432')
      assertEqual(result.database, 'mydb', 'database should be mydb')
      assertEqual(result.username, 'user', 'username should be user')
      assertEqual(result.password, 'pass', 'password should be pass')
    })

    it('should parse a postgres:// scheme', () => {
      const result = parseConnectionString(
        'postgres://admin:secret@db.neon.tech/app',
      )
      assertEqual(result.scheme, 'postgres', 'scheme should be postgres')
      assertEqual(result.host, 'db.neon.tech', 'host should match')
      assertNullish(result.port, 'port should be null when omitted')
      assertEqual(result.database, 'app', 'database should be app')
    })

    it('should parse a MySQL connection string', () => {
      const result = parseConnectionString(
        'mysql://root:password@mysql.example.com:3306/testdb',
      )
      assertEqual(result.scheme, 'mysql', 'scheme should be mysql')
      assertEqual(result.host, 'mysql.example.com', 'host should match')
      assertEqual(result.port, 3306, 'port should be 3306')
      assertEqual(result.database, 'testdb', 'database should be testdb')
    })

    it('should parse a MongoDB connection string', () => {
      const result = parseConnectionString(
        'mongodb://user:pass@mongo.example.com:27017/myapp',
      )
      assertEqual(result.scheme, 'mongodb', 'scheme should be mongodb')
      assertEqual(result.host, 'mongo.example.com', 'host should match')
      assertEqual(result.port, 27017, 'port should be 27017')
    })

    it('should parse a mongodb+srv connection string', () => {
      const result = parseConnectionString(
        'mongodb+srv://user:pass@cluster.mongodb.net/mydb',
      )
      assertEqual(result.scheme, 'mongodb+srv', 'scheme should be mongodb+srv')
      assertEqual(result.host, 'cluster.mongodb.net', 'host should match')
    })

    it('should parse a Redis connection string', () => {
      const result = parseConnectionString(
        'redis://default:mypass@redis.upstash.io:6379',
      )
      assertEqual(result.scheme, 'redis', 'scheme should be redis')
      assertEqual(result.host, 'redis.upstash.io', 'host should match')
      assertEqual(result.port, 6379, 'port should be 6379')
    })

    it('should parse a rediss (TLS Redis) connection string', () => {
      const result = parseConnectionString(
        'rediss://default:pass@redis.upstash.io:6380',
      )
      assertEqual(result.scheme, 'rediss', 'scheme should be rediss')
    })

    it('should handle URL-encoded special characters in password', () => {
      const result = parseConnectionString(
        'postgresql://user:p%40ss%23w0rd@host.com/db',
      )
      assertEqual(result.password, 'p@ss#w0rd', 'password should be decoded')
    })

    it('should handle connection strings without a port', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@host.example.com/mydb',
      )
      assertNullish(result.port, 'port should be null when omitted')
    })

    it('should handle connection strings with query parameters', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@host.com/db?sslmode=require&connect_timeout=10',
      )
      assertEqual(
        result.params.sslmode,
        'require',
        'sslmode param should exist',
      )
      assertEqual(
        result.params.connect_timeout,
        '10',
        'connect_timeout param should exist',
      )
    })

    it('should throw for invalid connection strings', () => {
      let threw = false
      try {
        parseConnectionString('not-a-url')
      } catch {
        threw = true
      }
      assert(threw, 'should throw for invalid connection string')
    })

    it('should preserve the raw connection string', () => {
      const raw = 'postgresql://user:pass@host.com:5432/db'
      const result = parseConnectionString(raw)
      assertEqual(result.raw, raw, 'raw should match original input')
    })
  })

  describe('detectEngineFromConnectionString', () => {
    it('should detect PostgreSQL from postgresql://', () => {
      const result = detectEngineFromConnectionString(
        'postgresql://user:pass@host/db',
      )
      assertEqual(result, Engine.PostgreSQL, 'should detect postgresql')
    })

    it('should detect PostgreSQL from postgres://', () => {
      const result = detectEngineFromConnectionString(
        'postgres://user:pass@host/db',
      )
      assertEqual(result, Engine.PostgreSQL, 'should detect postgres')
    })

    it('should detect MySQL from mysql://', () => {
      const result = detectEngineFromConnectionString(
        'mysql://user:pass@host/db',
      )
      assertEqual(result, Engine.MySQL, 'should detect mysql')
    })

    it('should detect MongoDB from mongodb://', () => {
      const result = detectEngineFromConnectionString(
        'mongodb://user:pass@host/db',
      )
      assertEqual(result, Engine.MongoDB, 'should detect mongodb')
    })

    it('should detect MongoDB from mongodb+srv://', () => {
      const result = detectEngineFromConnectionString(
        'mongodb+srv://user:pass@cluster.mongodb.net/db',
      )
      assertEqual(result, Engine.MongoDB, 'should detect mongodb+srv')
    })

    it('should detect Redis from redis://', () => {
      const result = detectEngineFromConnectionString(
        'redis://user:pass@host:6379',
      )
      assertEqual(result, Engine.Redis, 'should detect redis')
    })

    it('should detect Redis from rediss://', () => {
      const result = detectEngineFromConnectionString(
        'rediss://user:pass@host:6380',
      )
      assertEqual(result, Engine.Redis, 'should detect rediss')
    })

    it('should return null for http:// (ambiguous)', () => {
      const result = detectEngineFromConnectionString(
        'http://localhost:8080/api',
      )
      assertNullish(result, 'should return null for http')
    })

    it('should return null for unknown schemes', () => {
      const result = detectEngineFromConnectionString(
        'ftp://user:pass@host/path',
      )
      assertNullish(result, 'should return null for ftp')
    })
  })

  describe('detectProvider', () => {
    it('should detect Neon from hostname', () => {
      assertEqual(
        detectProvider('ep-cool-123.us-east-2.aws.neon.tech'),
        'neon',
        'should detect neon',
      )
    })

    it('should detect Supabase from hostname', () => {
      assertEqual(
        detectProvider('db.abcdefgh.supabase.co'),
        'supabase',
        'should detect supabase .co',
      )
      assertEqual(
        detectProvider('db.abcdefgh.supabase.com'),
        'supabase',
        'should detect supabase .com',
      )
    })

    it('should detect PlanetScale from hostname', () => {
      assertEqual(
        detectProvider('aws.connect.psdb.cloud.planetscale.com'),
        'planetscale',
        'should detect planetscale',
      )
    })

    it('should detect Upstash from hostname', () => {
      assertEqual(
        detectProvider('us1-merry-cat-12345.upstash.io'),
        'upstash',
        'should detect upstash',
      )
    })

    it('should detect Railway from hostname', () => {
      assertEqual(
        detectProvider('monorail.proxy.rlwy.net.railway.app'),
        'railway',
        'should detect railway',
      )
    })

    it('should detect Aiven from hostname', () => {
      assertEqual(
        detectProvider('pg-xxxx.aivencloud.com.aiven.io'),
        'aiven',
        'should detect aiven',
      )
    })

    it('should detect CockroachDB Cloud from hostname', () => {
      assertEqual(
        detectProvider('free-xxxx.cockroachlabs.cloud'),
        'cockroachdb-cloud',
        'should detect cockroachdb-cloud',
      )
    })

    it('should return null for unknown hosts', () => {
      assertNullish(
        detectProvider('my-custom-server.example.com'),
        'should return null for unknown host',
      )
    })

    it('should return null for localhost', () => {
      assertNullish(
        detectProvider('localhost'),
        'should return null for localhost',
      )
    })
  })

  describe('isLocalhost', () => {
    it('should detect 127.0.0.1', () => {
      assert(isLocalhost('127.0.0.1'), '127.0.0.1 should be localhost')
    })

    it('should detect localhost', () => {
      assert(isLocalhost('localhost'), 'localhost should be localhost')
    })

    it('should detect ::1', () => {
      assert(isLocalhost('::1'), '::1 should be localhost')
    })

    it('should detect [::1]', () => {
      assert(isLocalhost('[::1]'), '[::1] should be localhost')
    })

    it('should not detect remote hosts', () => {
      assert(
        !isLocalhost('db.neon.tech'),
        'db.neon.tech should not be localhost',
      )
      assert(!isLocalhost('192.168.1.1'), '192.168.1.1 should not be localhost')
    })
  })

  describe('generateRemoteContainerName', () => {
    it('should use provider + database when both available', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'ep-cool-123.neon.tech',
        database: 'myapp',
        provider: 'neon',
      })
      assertEqual(name, 'neon-myapp', 'should be provider-database')
    })

    it('should use provider + engine when no database', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'ep-cool-123.neon.tech',
        database: '',
        provider: 'neon',
      })
      assertEqual(name, 'neon-postgresql', 'should be provider-engine')
    })

    it('should use remote + database when no provider', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'custom-server.example.com',
        database: 'myapp',
      })
      assertEqual(name, 'remote-myapp', 'should be remote-database')
    })

    it('should fallback to remote + host prefix', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'custom-server.example.com',
        database: '',
      })
      assertEqual(
        name,
        'remote-custom-server',
        'should use host prefix fallback',
      )
    })

    it('should sanitize special characters', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'host.example.com',
        database: 'my.special@db',
        provider: null,
      })
      assert(
        /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name),
        `name "${name}" should be sanitized`,
      )
    })
  })

  describe('redactConnectionString', () => {
    it('should replace password with ***', () => {
      const result = redactConnectionString(
        'postgresql://user:mysecretpass@host.com/db',
      )
      assert(
        result.includes(':***@'),
        'should contain redacted password marker',
      )
      assert(
        !result.includes('mysecretpass'),
        'should not contain original password',
      )
    })

    it('should handle URL-encoded passwords', () => {
      const result = redactConnectionString(
        'postgresql://user:p%40ss%23word@host.com/db',
      )
      assert(
        !result.includes('p%40ss%23word'),
        'should not contain encoded password',
      )
      assert(result.includes(':***@'), 'should contain redacted marker')
    })

    it('should not modify strings without passwords', () => {
      const url = 'postgresql://user@host.com/db'
      const result = redactConnectionString(url)
      assertEqual(result, url, 'should return unmodified URL')
    })

    it('should handle empty passwords', () => {
      const url = 'postgresql://user:@host.com/db'
      const result = redactConnectionString(url)
      assertEqual(
        result,
        url,
        'should return unmodified URL for empty password',
      )
    })
  })

  describe('buildRemoteConfig', () => {
    it('should build config with SSL enabled for remote hosts', () => {
      const config = buildRemoteConfig({
        host: 'db.neon.tech',
        connectionString: 'postgresql://user:pass@db.neon.tech/mydb',
        provider: 'neon',
      })
      assertEqual(config.host, 'db.neon.tech', 'host should match')
      assertEqual(config.ssl, true, 'SSL should be true for remote host')
      assertEqual(config.provider, 'neon', 'provider should be neon')
      assert(
        !config.connectionString.includes('pass'),
        'connection string should be redacted',
      )
    })

    it('should disable SSL for localhost', () => {
      const config = buildRemoteConfig({
        host: 'localhost',
        connectionString: 'postgresql://user:pass@localhost/mydb',
      })
      assertEqual(config.ssl, false, 'SSL should be false for localhost')
    })

    it('should disable SSL for 127.0.0.1', () => {
      const config = buildRemoteConfig({
        host: '127.0.0.1',
        connectionString: 'postgresql://user:pass@127.0.0.1/mydb',
      })
      assertEqual(config.ssl, false, 'SSL should be false for 127.0.0.1')
    })

    it('should allow explicit SSL override', () => {
      const config = buildRemoteConfig({
        host: 'localhost',
        connectionString: 'postgresql://user:pass@localhost/mydb',
        ssl: true,
      })
      assertEqual(config.ssl, true, 'SSL should be overridden to true')
    })

    it('should omit provider when null', () => {
      const config = buildRemoteConfig({
        host: 'custom.example.com',
        connectionString: 'postgresql://user:pass@custom.example.com/mydb',
        provider: null,
      })
      assertEqual(
        config.provider,
        undefined,
        'provider should be undefined when null',
      )
    })
  })

  describe('getDefaultPortForEngine', () => {
    it('should return 5432 for PostgreSQL', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.PostgreSQL),
        5432,
        'PostgreSQL default port',
      )
    })

    it('should return 3306 for MySQL', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.MySQL),
        3306,
        'MySQL default port',
      )
    })

    it('should return 27017 for MongoDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.MongoDB),
        27017,
        'MongoDB default port',
      )
    })

    it('should return 6379 for Redis', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Redis),
        6379,
        'Redis default port',
      )
    })

    it('should return 6379 for Valkey', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Valkey),
        6379,
        'Valkey default port',
      )
    })
  })

  describe('parseConnectionString - edge cases', () => {
    it('should handle connection strings with no username', () => {
      const result = parseConnectionString('redis://:mypass@host.io:6379')
      assertEqual(result.username, '', 'username should be empty')
      assertEqual(result.password, 'mypass', 'password should be mypass')
    })

    it('should handle connection strings with empty database path', () => {
      const result = parseConnectionString('redis://default:pass@host.io:6379')
      assertEqual(result.database, '', 'database should be empty')
    })

    it('should handle connection strings with only host', () => {
      const result = parseConnectionString('postgresql://host.com')
      assertEqual(result.host, 'host.com', 'host should match')
      assertEqual(result.username, '', 'username should be empty')
      assertEqual(result.password, '', 'password should be empty')
      assertEqual(result.database, '', 'database should be empty')
    })

    it('should handle passwords with special regex characters', () => {
      const result = parseConnectionString(
        'postgresql://user:a%2Bb%24c%5Ed@host.com/db',
      )
      assertEqual(
        result.password,
        'a+b$c^d',
        'password with regex chars should be decoded',
      )
    })

    it('should handle very long hostnames', () => {
      const longHost = 'a'.repeat(200) + '.example.com'
      const result = parseConnectionString(
        `postgresql://user:pass@${longHost}/db`,
      )
      assertEqual(result.host, longHost, 'long hostname should be preserved')
    })

    it('should parse connection string with localhost IPv4', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@127.0.0.1:5432/mydb',
      )
      assertEqual(result.host, '127.0.0.1', 'host should be 127.0.0.1')
      assertEqual(result.port, 5432, 'port should be 5432')
    })

    it('should handle database names with slashes', () => {
      const result = parseConnectionString(
        'postgresql://user:pass@host.com/my%2Fdb',
      )
      assertEqual(
        result.database,
        'my/db',
        'database with slash should be decoded',
      )
    })

    it('should handle mongodb+srv with no port', () => {
      const result = parseConnectionString(
        'mongodb+srv://user:pass@cluster.mongodb.net/mydb?retryWrites=true',
      )
      assertNullish(result.port, 'mongodb+srv should have no port')
      assertEqual(result.params.retryWrites, 'true', 'params should be parsed')
    })
  })

  describe('redactConnectionString - edge cases', () => {
    it('should redact passwords with regex special characters', () => {
      const url = 'postgresql://user:a+b$c^d@host.com/db'
      const result = redactConnectionString(url)
      assert(!result.includes('a+b$c^d'), 'should not contain raw password')
      assert(result.includes(':***@'), 'should contain redacted marker')
    })

    it('should redact URL-encoded passwords with regex special chars', () => {
      const url = 'postgresql://user:a%2Bb%24c%5Ed@host.com/db'
      const result = redactConnectionString(url)
      assert(
        !result.includes('a%2Bb%24c%5Ed'),
        'should not contain encoded password',
      )
      assert(result.includes(':***@'), 'should contain redacted marker')
    })

    it('should handle passwords containing @ symbol', () => {
      const url = 'postgresql://user:p%40ssword@host.com/db'
      const result = redactConnectionString(url)
      assert(
        !result.includes('p%40ssword'),
        'should not contain encoded password',
      )
      assert(result.includes(':***@'), 'should contain redacted marker')
    })

    it('should preserve scheme and host after redaction', () => {
      const result = redactConnectionString(
        'postgresql://user:secret@db.neon.tech:5432/mydb',
      )
      assert(result.startsWith('postgresql://'), 'should preserve scheme')
      assert(result.includes('db.neon.tech'), 'should preserve host')
      assert(result.includes('/mydb'), 'should preserve database')
    })
  })

  describe('generateRemoteContainerName - edge cases', () => {
    it('should truncate very long names', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'host.com',
        database: 'a'.repeat(100),
        provider: 'neon',
      })
      assert(name.length <= 50, `name "${name}" should be <= 50 chars`)
    })

    it('should handle all-numeric database names', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: 'host.com',
        database: '12345',
        provider: null,
      })
      assert(
        /^[a-zA-Z]/.test(name),
        `name "${name}" should start with a letter`,
      )
    })

    it('should handle empty host and database', () => {
      const name = generateRemoteContainerName({
        engine: Engine.PostgreSQL,
        host: '',
        database: '',
        provider: null,
      })
      assert(name.length > 0, 'should return a non-empty name')
      assert(
        /^[a-zA-Z]/.test(name),
        `name "${name}" should start with a letter`,
      )
    })
  })

  describe('getDefaultPortForEngine - complete coverage', () => {
    it('should return 1729 for TypeDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.TypeDB),
        1729,
        'TypeDB default port',
      )
    })

    it('should return 3000 for TigerBeetle', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.TigerBeetle),
        3000,
        'TigerBeetle default port',
      )
    })

    it('should return 0 for SQLite', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.SQLite),
        0,
        'SQLite should have port 0',
      )
    })

    it('should return 0 for DuckDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.DuckDB),
        0,
        'DuckDB should have port 0',
      )
    })

    it('should return 26257 for CockroachDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.CockroachDB),
        26257,
        'CockroachDB default port',
      )
    })

    it('should return 8000 for SurrealDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.SurrealDB),
        8000,
        'SurrealDB default port',
      )
    })

    it('should return 6333 for Qdrant', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Qdrant),
        6333,
        'Qdrant default port',
      )
    })

    it('should return 7700 for Meilisearch', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Meilisearch),
        7700,
        'Meilisearch default port',
      )
    })

    it('should return 5984 for CouchDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.CouchDB),
        5984,
        'CouchDB default port',
      )
    })

    it('should return 8812 for QuestDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.QuestDB),
        8812,
        'QuestDB default port',
      )
    })

    it('should return 8086 for InfluxDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.InfluxDB),
        8086,
        'InfluxDB default port',
      )
    })

    it('should return 8080 for Weaviate', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.Weaviate),
        8080,
        'Weaviate default port',
      )
    })

    it('should return 8123 for ClickHouse', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.ClickHouse),
        8123,
        'ClickHouse default port',
      )
    })

    it('should return 27017 for FerretDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.FerretDB),
        27017,
        'FerretDB default port',
      )
    })

    it('should return 3306 for MariaDB', () => {
      assertEqual(
        getDefaultPortForEngine(Engine.MariaDB),
        3306,
        'MariaDB default port',
      )
    })
  })

  describe('buildRemoteConfig - edge cases', () => {
    it('should handle connection strings with no password', () => {
      const config = buildRemoteConfig({
        host: 'db.example.com',
        connectionString: 'postgresql://user@db.example.com/mydb',
      })
      assertEqual(config.ssl, true, 'SSL should be true for remote host')
      assertEqual(
        config.connectionString,
        'postgresql://user@db.example.com/mydb',
        'URL without password should not be modified',
      )
    })

    it('should handle IPv6 localhost', () => {
      const config = buildRemoteConfig({
        host: '::1',
        connectionString: 'postgresql://user:pass@[::1]/mydb',
      })
      assertEqual(config.ssl, false, 'SSL should be false for IPv6 localhost')
    })
  })

  describe('isRemoteContainer', () => {
    it('should return true for containers with remote config', () => {
      const config = {
        name: 'test',
        engine: Engine.PostgreSQL,
        version: '16',
        port: 5432,
        database: 'mydb',
        created: '2024-01-01',
        status: 'linked' as const,
        remote: {
          host: 'db.neon.tech',
          connectionString: 'postgresql://user:***@db.neon.tech/mydb',
          ssl: true,
          provider: 'neon',
        },
      } as ContainerConfig
      assert(isRemoteContainer(config), 'should be remote container')
    })

    it('should return false for local containers', () => {
      const config = {
        name: 'test',
        engine: Engine.PostgreSQL,
        version: '16',
        port: 5432,
        database: 'mydb',
        created: '2024-01-01',
        status: 'running' as const,
      } as ContainerConfig
      assert(!isRemoteContainer(config), 'should not be remote container')
    })

    it('should return false for containers without remote field', () => {
      const config = {
        name: 'test',
        engine: Engine.PostgreSQL,
        version: '16',
        port: 5432,
        database: 'mydb',
        created: '2024-01-01',
        status: 'stopped' as const,
      } as ContainerConfig
      assert(!isRemoteContainer(config), 'should not be remote without field')
    })
  })
})
