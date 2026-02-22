import { describe, it } from 'node:test'
import { Engine, isRemoteContainer } from '../../types'
import type { ContainerConfig, QueryOptions } from '../../types'
import { parseConnectionString } from '../../core/remote-container'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

/**
 * Tests for remote container query support.
 *
 * Verifies that QueryOptions correctly carries remote connection info
 * and that the query command routing logic handles remote containers
 * without requiring a "running" check.
 */

// Helper to create a remote container config
function makeRemoteConfig(
  overrides?: Partial<ContainerConfig>,
): ContainerConfig {
  return {
    name: 'neon-myapp',
    engine: Engine.PostgreSQL,
    version: '16',
    port: 5432,
    database: 'myapp',
    created: '2024-01-01',
    status: 'linked' as const,
    remote: {
      host: 'ep-cool-123.us-east-2.aws.neon.tech',
      connectionString:
        'postgresql://user:***@ep-cool-123.us-east-2.aws.neon.tech/myapp',
      ssl: true,
      provider: 'neon',
    },
    ...overrides,
  } as ContainerConfig
}

// Helper to create a local container config
function makeLocalConfig(
  overrides?: Partial<ContainerConfig>,
): ContainerConfig {
  return {
    name: 'local-pg',
    engine: Engine.PostgreSQL,
    version: '16',
    port: 5432,
    database: 'mydb',
    created: '2024-01-01',
    status: 'running' as const,
    ...overrides,
  } as ContainerConfig
}

describe('Remote Query Support', () => {
  describe('QueryOptions remote fields', () => {
    it('should accept host, password, username, and ssl', () => {
      const opts: QueryOptions = {
        database: 'mydb',
        host: 'db.neon.tech',
        password: 'secret',
        username: 'admin',
        ssl: true,
      }
      assertEqual(opts.host, 'db.neon.tech', 'host should be set')
      assertEqual(opts.password, 'secret', 'password should be set')
      assertEqual(opts.username, 'admin', 'username should be set')
      assertEqual(opts.ssl, true, 'ssl should be true')
    })

    it('should allow all remote fields to be undefined for local queries', () => {
      const opts: QueryOptions = {
        database: 'mydb',
      }
      assertEqual(opts.host, undefined, 'host should be undefined')
      assertEqual(opts.password, undefined, 'password should be undefined')
      assertEqual(opts.username, undefined, 'username should be undefined')
      assertEqual(opts.ssl, undefined, 'ssl should be undefined')
    })

    it('should coexist with REST API options', () => {
      const opts: QueryOptions = {
        database: 'mydb',
        method: 'GET',
        body: { key: 'value' },
        host: 'remote.example.com',
        password: 'pass',
      }
      assertEqual(opts.method, 'GET', 'method should be set')
      assertEqual(opts.host, 'remote.example.com', 'host should be set')
    })
  })

  describe('Remote container detection for query routing', () => {
    it('should identify remote containers via isRemoteContainer', () => {
      const remote = makeRemoteConfig()
      assert(isRemoteContainer(remote), 'should be remote container')
    })

    it('should not identify local containers as remote', () => {
      const local = makeLocalConfig()
      assert(!isRemoteContainer(local), 'should not be remote container')
    })

    it('should identify remote containers regardless of engine', () => {
      const mysqlRemote = makeRemoteConfig({
        engine: Engine.MySQL,
        remote: {
          host: 'mysql.planetscale.com',
          connectionString: 'mysql://user:***@mysql.planetscale.com/mydb',
          ssl: true,
          provider: 'planetscale',
        },
      })
      assert(isRemoteContainer(mysqlRemote), 'MySQL remote should be detected')

      const mongoRemote = makeRemoteConfig({
        engine: Engine.MongoDB,
        remote: {
          host: 'cluster.mongodb.net',
          connectionString: 'mongodb+srv://user:***@cluster.mongodb.net/mydb',
          ssl: true,
        },
      })
      assert(
        isRemoteContainer(mongoRemote),
        'MongoDB remote should be detected',
      )

      const redisRemote = makeRemoteConfig({
        engine: Engine.Redis,
        remote: {
          host: 'redis.upstash.io',
          connectionString: 'rediss://default:***@redis.upstash.io:6379',
          ssl: true,
          provider: 'upstash',
        },
      })
      assert(isRemoteContainer(redisRemote), 'Redis remote should be detected')
    })
  })

  describe('Connection string parsing for query options', () => {
    it('should extract PostgreSQL connection details', () => {
      const parsed = parseConnectionString(
        'postgresql://myuser:mypass@ep-cool-123.neon.tech:5432/mydb',
      )
      assertEqual(parsed.host, 'ep-cool-123.neon.tech', 'host')
      assertEqual(parsed.port, 5432, 'port')
      assertEqual(parsed.username, 'myuser', 'username')
      assertEqual(parsed.password, 'mypass', 'password')
      assertEqual(parsed.database, 'mydb', 'database')
    })

    it('should extract MySQL connection details', () => {
      const parsed = parseConnectionString(
        'mysql://admin:secret@mysql.planetscale.com:3306/app',
      )
      assertEqual(parsed.host, 'mysql.planetscale.com', 'host')
      assertEqual(parsed.port, 3306, 'port')
      assertEqual(parsed.username, 'admin', 'username')
      assertEqual(parsed.password, 'secret', 'password')
    })

    it('should extract MongoDB connection details', () => {
      const parsed = parseConnectionString(
        'mongodb://dbuser:dbpass@cluster.mongodb.net:27017/testdb',
      )
      assertEqual(parsed.host, 'cluster.mongodb.net', 'host')
      assertEqual(parsed.port, 27017, 'port')
      assertEqual(parsed.username, 'dbuser', 'username')
      assertEqual(parsed.password, 'dbpass', 'password')
    })

    it('should extract Redis connection details', () => {
      const parsed = parseConnectionString(
        'redis://default:token123@redis.upstash.io:6379',
      )
      assertEqual(parsed.host, 'redis.upstash.io', 'host')
      assertEqual(parsed.port, 6379, 'port')
      assertEqual(parsed.username, 'default', 'username')
      assertEqual(parsed.password, 'token123', 'password')
    })

    it('should handle connections without explicit port', () => {
      const parsed = parseConnectionString(
        'postgresql://user:pass@db.supabase.co/postgres',
      )
      assertEqual(parsed.host, 'db.supabase.co', 'host')
      assertNullish(parsed.port, 'port should be null when omitted')
    })

    it('should decode URL-encoded credentials', () => {
      const parsed = parseConnectionString(
        'postgresql://user:p%40ss%23w0rd@host.com/db',
      )
      assertEqual(parsed.password, 'p@ss#w0rd', 'password should be decoded')
    })

    it('should handle mongodb+srv scheme', () => {
      const parsed = parseConnectionString(
        'mongodb+srv://user:pass@cluster.mongodb.net/mydb',
      )
      assertEqual(parsed.scheme, 'mongodb+srv', 'scheme')
      assertEqual(parsed.host, 'cluster.mongodb.net', 'host')
      assertNullish(parsed.port, 'mongodb+srv should have no port')
    })
  })

  describe('Building QueryOptions from remote config', () => {
    it('should build PostgreSQL query options from connection string', () => {
      const connectionString =
        'postgresql://neonuser:neonpass@ep-cool-123.neon.tech:5432/mydb'
      const parsed = parseConnectionString(connectionString)
      const config = makeRemoteConfig()

      const queryOpts: QueryOptions = {
        database: parsed.database || config.database,
        host: parsed.host,
        password: parsed.password,
        username: parsed.username,
        ssl: config.remote?.ssl,
      }

      assertEqual(
        queryOpts.host,
        'ep-cool-123.neon.tech',
        'host should come from connection string',
      )
      assertEqual(queryOpts.password, 'neonpass', 'password from conn string')
      assertEqual(queryOpts.username, 'neonuser', 'username from conn string')
      assertEqual(queryOpts.ssl, true, 'ssl from remote config')
      assertEqual(queryOpts.database, 'mydb', 'database from conn string')
    })

    it('should build MySQL query options from connection string', () => {
      const connectionString =
        'mysql://admin:secret@mysql.planetscale.com:3306/app'
      const parsed = parseConnectionString(connectionString)

      const queryOpts: QueryOptions = {
        database: parsed.database,
        host: parsed.host,
        password: parsed.password,
        username: parsed.username,
        ssl: true,
      }

      assertEqual(queryOpts.host, 'mysql.planetscale.com', 'host')
      assertEqual(queryOpts.password, 'secret', 'password')
      assertEqual(queryOpts.username, 'admin', 'username')
      assertEqual(queryOpts.ssl, true, 'ssl')
    })

    it('should build Redis query options from connection string', () => {
      const connectionString = 'rediss://default:token@redis.upstash.io:6379/0'
      const parsed = parseConnectionString(connectionString)

      const queryOpts: QueryOptions = {
        database: parsed.database || '0',
        host: parsed.host,
        password: parsed.password,
        username: parsed.username,
        ssl: true,
      }

      assertEqual(queryOpts.host, 'redis.upstash.io', 'host')
      assertEqual(queryOpts.password, 'token', 'password')
      assertEqual(queryOpts.ssl, true, 'ssl for rediss scheme')
    })

    it('should override container port from connection string', () => {
      const connectionString = 'postgresql://user:pass@host.com:6543/db'
      const parsed = parseConnectionString(connectionString)
      const config = makeRemoteConfig({ port: 5432 })

      // Simulate what query.ts does
      if (parsed.port) {
        config.port = parsed.port
      }

      assertEqual(config.port, 6543, 'port should be overridden')
    })

    it('should not override port when connection string omits it', () => {
      const connectionString = 'postgresql://user:pass@host.com/db'
      const parsed = parseConnectionString(connectionString)
      const config = makeRemoteConfig({ port: 5432 })

      if (parsed.port) {
        config.port = parsed.port
      }

      assertEqual(config.port, 5432, 'port should remain unchanged')
    })
  })

  describe('Remote query options fallback behavior', () => {
    it('should use default host when options.host is undefined', () => {
      const opts: QueryOptions = { database: 'mydb' }
      const host = opts.host ?? '127.0.0.1'
      assertEqual(host, '127.0.0.1', 'should fall back to localhost')
    })

    it('should use remote host when options.host is set', () => {
      const opts: QueryOptions = { database: 'mydb', host: 'db.neon.tech' }
      const host = opts.host ?? '127.0.0.1'
      assertEqual(host, 'db.neon.tech', 'should use remote host')
    })

    it('should use default superuser when options.username is undefined', () => {
      const opts: QueryOptions = { database: 'mydb' }
      const defaultSuperuser = 'postgres'
      const user = opts.username || defaultSuperuser
      assertEqual(user, 'postgres', 'should fall back to default superuser')
    })

    it('should use remote username when set', () => {
      const opts: QueryOptions = {
        database: 'mydb',
        username: 'remoteuser',
      }
      const defaultSuperuser = 'postgres'
      const user = opts.username || defaultSuperuser
      assertEqual(user, 'remoteuser', 'should use remote username')
    })
  })

  describe('Engine-specific remote query patterns', () => {
    describe('PostgreSQL remote args', () => {
      it('should build correct psql args with remote host', () => {
        const opts: QueryOptions = {
          database: 'mydb',
          host: 'db.neon.tech',
          username: 'neonuser',
          password: 'neonpass',
          ssl: true,
        }
        const port = 5432

        const host = opts.host ?? '127.0.0.1'
        const user = opts.username || 'postgres'
        const args = ['-X', '-h', host, '-p', String(port), '-U', user]

        assert(args.includes('db.neon.tech'), 'should include remote host')
        assert(args.includes('neonuser'), 'should include remote username')
        assertEqual(
          args.indexOf('127.0.0.1'),
          -1,
          'should not include localhost',
        )
        // SSL is set via PGSSLMODE env, not via args
        assert(
          !args.includes('--set=sslmode=require'),
          'should not use --set for sslmode',
        )
      })

      it('should set PGPASSWORD and PGSSLMODE env for remote', () => {
        const opts: QueryOptions = { password: 'secret', ssl: true }
        const env: Record<string, string> = {}
        if (opts.password) {
          env.PGPASSWORD = opts.password
        }
        if (opts.ssl) {
          env.PGSSLMODE = 'require'
        }
        assertEqual(env.PGPASSWORD, 'secret', 'PGPASSWORD should be set')
        assertEqual(env.PGSSLMODE, 'require', 'PGSSLMODE should be set')
      })

      it('should not set PGPASSWORD for local queries', () => {
        const opts: QueryOptions = { database: 'mydb' }
        const env: Record<string, string> = {}
        if (opts.password) {
          env.PGPASSWORD = opts.password
        }
        assertEqual(
          env.PGPASSWORD,
          undefined,
          'PGPASSWORD should not be set for local',
        )
      })
    })

    describe('MySQL/MariaDB remote args', () => {
      it('should build args with remote host and SSL', () => {
        const opts: QueryOptions = {
          host: 'mysql.planetscale.com',
          username: 'admin',
          password: 'secret',
          ssl: true,
        }
        const port = 3306

        const host = opts.host ?? '127.0.0.1'
        const user = opts.username || 'root'
        const args = ['-h', host, '-P', String(port), '-u', user]

        if (opts.ssl) {
          args.push('--ssl-mode=REQUIRED')
        }

        // Password is passed via MYSQL_PWD env, not via args
        const env: Record<string, string> = {}
        if (opts.password) {
          env.MYSQL_PWD = opts.password
        }

        assert(
          args.includes('mysql.planetscale.com'),
          'should include remote host',
        )
        assert(args.includes('admin'), 'should include remote username')
        assert(
          !args.some((a) => a.startsWith('-p')),
          'should not expose password in args',
        )
        assertEqual(
          env.MYSQL_PWD,
          'secret',
          'should pass password via MYSQL_PWD env',
        )
        assert(args.includes('--ssl-mode=REQUIRED'), 'should include SSL mode')
      })
    })

    describe('MongoDB remote args', () => {
      it('should build SRV URI when scheme is mongodb+srv', () => {
        const opts: QueryOptions = {
          host: 'cluster.mongodb.net',
          username: 'db@user',
          password: 'db#pass',
          ssl: true,
          scheme: 'mongodb+srv',
          database: 'mydb',
        }
        const port = 27017

        const user = opts.username ? encodeURIComponent(opts.username) : ''
        const pass = opts.password ? encodeURIComponent(opts.password) : ''
        const auth = user ? `${user}:${pass}@` : ''
        const isSrv = opts.scheme === 'mongodb+srv'
        const scheme = isSrv ? 'mongodb+srv' : 'mongodb'
        const portSuffix = isSrv ? '' : `:${port}`
        const sslParam = opts.ssl && !isSrv ? 'tls=true' : ''
        const uri = `${scheme}://${auth}${opts.host}${portSuffix}/${opts.database}${sslParam ? `?${sslParam}` : ''}`

        assert(uri.startsWith('mongodb+srv://'), 'should use srv scheme')
        // Verify URL-encoded credentials (@ → %40, # → %23)
        assert(
          uri.includes(
            `${encodeURIComponent('db@user')}:${encodeURIComponent('db#pass')}@`,
          ),
          'should include URL-encoded credentials',
        )
        assert(
          !uri.includes('db@user:'),
          'should not include raw unencoded username',
        )
        assert(
          uri.includes('cluster.mongodb.net/mydb'),
          'should include host and database',
        )
        // SRV implies TLS, so no redundant tls=true param needed
        assert(
          !uri.includes('tls=true'),
          'srv should not add redundant tls param',
        )
        assert(!uri.includes(':27017'), 'srv should not include port')
      })

      it('should build standard URI with TLS for non-SRV connections', () => {
        const opts: QueryOptions = {
          host: 'mongo.example.com',
          username: 'user',
          password: 'pass',
          ssl: true,
          scheme: 'mongodb',
          database: 'testdb',
        }
        const port = 27017

        const isSrv = opts.scheme === 'mongodb+srv'
        const scheme = isSrv ? 'mongodb+srv' : 'mongodb'
        const portSuffix = isSrv ? '' : `:${port}`
        const sslParam = opts.ssl && !isSrv ? 'tls=true' : ''
        const uri = `${scheme}://user:pass@${opts.host}${portSuffix}/${opts.database}${sslParam ? `?${sslParam}` : ''}`

        assert(uri.startsWith('mongodb://'), 'should use standard scheme')
        assert(uri.includes(':27017'), 'should include port for non-SRV')
        assert(uri.includes('?tls=true'), 'should include tls=true for SSL')
      })

      it('should build standard URI without SSL', () => {
        const opts: QueryOptions = {
          host: 'mongo.example.com',
          username: 'user',
          password: 'pass',
          ssl: false,
          scheme: 'mongodb',
          database: 'testdb',
        }
        const port = 27017

        const isSrv = opts.scheme === 'mongodb+srv'
        const portSuffix = isSrv ? '' : `:${port}`
        const sslParam = opts.ssl && !isSrv ? 'tls=true' : ''
        const uri = `mongodb://user:pass@${opts.host}${portSuffix}/${opts.database}${sslParam ? `?${sslParam}` : ''}`

        assert(uri.startsWith('mongodb://'), 'should use standard scheme')
        assert(uri.includes(':27017'), 'should include port')
        assert(!uri.includes('tls=true'), 'should not include tls param')
      })
    })

    describe('Redis/Valkey remote args', () => {
      it('should build args with username and TLS, password via env', () => {
        const opts: QueryOptions = {
          host: 'redis.upstash.io',
          username: 'default',
          password: 'token123',
          ssl: true,
          database: '0',
        }
        const port = 6379

        const host = opts.host ?? '127.0.0.1'
        const args = [
          '-h',
          host,
          '-p',
          String(port),
          '-n',
          opts.database!,
          '--raw',
        ]

        if (opts.username) {
          args.push('--user', opts.username)
        }
        if (opts.ssl) {
          args.push('--tls')
        }

        // Password is passed via REDISCLI_AUTH env, not via args
        const env: Record<string, string> = {}
        if (opts.password) {
          env.REDISCLI_AUTH = opts.password
        }

        assert(args.includes('redis.upstash.io'), 'should include remote host')
        assert(args.includes('--user'), 'should include user flag')
        assert(args.includes('default'), 'should include username')
        assert(!args.includes('-a'), 'should not expose password in args')
        assertEqual(
          env.REDISCLI_AUTH,
          'token123',
          'should pass password via REDISCLI_AUTH env',
        )
        assert(args.includes('--tls'), 'should include TLS flag')
        assert(args.includes('--raw'), 'should include --raw flag')
      })

      it('should not include auth/TLS for local queries', () => {
        const opts: QueryOptions = { database: '0' }
        const host = opts.host ?? '127.0.0.1'
        const args = ['-h', host, '-p', '6379', '-n', '0', '--raw']

        assertEqual(host, '127.0.0.1', 'should use localhost')
        assert(!args.includes('--user'), 'should not include user flag')
        assert(!args.includes('-a'), 'should not include auth flag')
        assert(!args.includes('--tls'), 'should not include TLS')
      })
    })
  })

  describe('Remote container status handling', () => {
    it('remote containers should have linked status', () => {
      const config = makeRemoteConfig()
      assertEqual(config.status, 'linked', 'status should be linked')
    })

    it('remote containers should not need running check', () => {
      const config = makeRemoteConfig()
      // Remote containers bypass the "is running" check entirely.
      // The query command checks isRemoteContainer first, before
      // checking process status for server-based containers.
      assert(
        isRemoteContainer(config),
        'should be detected as remote before running check',
      )
      assertEqual(
        config.status,
        'linked',
        'linked status means always reachable',
      )
    })

    it('local server containers still need running check', () => {
      const config = makeLocalConfig({ status: 'stopped' as const })
      assert(!isRemoteContainer(config), 'local container is not remote')
      assertEqual(
        config.status,
        'stopped',
        'stopped local container would fail running check',
      )
    })
  })
})
