import { describe, it } from 'node:test'
import {
  canDetectMissingDatabase,
  getDatabaseCapabilities,
} from '../../core/database-capabilities'
import {
  DATABASE_PRESENCE_TIMEOUT_MS,
  classifyDatabasePresence,
  probeDatabasePresence,
} from '../../core/database-presence'
import {
  ensurePrimaryDatabase,
  resolvePrimaryDatabaseState,
} from '../../core/primary-database'
import { buildSyncedDatabaseList } from '../../core/container-manager'
import { checkBackupTarget } from '../../cli/commands/backup'
import { startCommand } from '../../cli/commands/start'
import { getEngine } from '../../engines'
import { Engine, ALL_ENGINES, type ContainerConfig } from '../../types'
import type { DatabasePresence } from '../../core/database-presence'
import { assert, assertEqual } from '../utils/assertions'

const DURABLE_ENGINES = [
  Engine.PostgreSQL,
  Engine.MySQL,
  Engine.MariaDB,
  Engine.CockroachDB,
  Engine.ClickHouse,
]

function makeConfig(overrides: Partial<ContainerConfig> = {}): ContainerConfig {
  return {
    name: 'primary-test',
    engine: Engine.MariaDB,
    version: '11.8.3',
    port: 3399,
    database: 'app',
    created: new Date().toISOString(),
    status: 'running',
    ...overrides,
  }
}

type FakeEngineOptions = {
  presence: DatabasePresence
  createError?: string
}

function makeFakeEngine(options: FakeEngineOptions) {
  const calls = { databaseExists: 0, createDatabase: 0 }
  return {
    calls,
    engine: {
      async databaseExists(): Promise<DatabasePresence> {
        calls.databaseExists++
        return options.presence
      },
      async createDatabase(): Promise<void> {
        calls.createDatabase++
        if (options.createError) throw new Error(options.createError)
      },
    },
  }
}

describe('durableDatabaseExistence capability', () => {
  it('is true exactly for engines where an empty database is still listed', () => {
    for (const engine of ALL_ENGINES) {
      const expected = DURABLE_ENGINES.includes(engine)
      assertEqual(
        getDatabaseCapabilities(engine).durableDatabaseExistence,
        expected,
        `${engine} durableDatabaseExistence`,
      )
      assertEqual(
        canDetectMissingDatabase(engine),
        expected,
        `${engine} canDetectMissingDatabase`,
      )
    }
  })

  it('keeps MongoDB and FerretDB non-durable (a database without data is not listed)', () => {
    assertEqual(canDetectMissingDatabase(Engine.MongoDB), false, 'mongodb')
    assertEqual(canDetectMissingDatabase(Engine.FerretDB), false, 'ferretdb')
  })
})

describe('classifyDatabasePresence', () => {
  it('reports an exact match as present', () => {
    assertEqual(
      classifyDatabasePresence({
        engine: Engine.PostgreSQL,
        name: 'app',
        listed: ['app', 'other'],
      }),
      true,
      'exact match',
    )
  })

  it('treats an empty MariaDB primary named test as present', () => {
    assertEqual(
      classifyDatabasePresence({
        engine: Engine.MariaDB,
        name: 'test',
        listed: ['test'],
      }),
      true,
      'test is a user database, not a filtered system database',
    )
  })

  it('reports absence from a successful listing as false', () => {
    for (const engine of DURABLE_ENGINES) {
      assertEqual(
        classifyDatabasePresence({ engine, name: 'app', listed: ['other'] }),
        false,
        `${engine} absence`,
      )
      assertEqual(
        classifyDatabasePresence({ engine, name: 'app', listed: [] }),
        false,
        `${engine} empty listing`,
      )
    }
  })

  it('returns unknown for a name the listing filters out', () => {
    assertEqual(
      classifyDatabasePresence({
        engine: Engine.PostgreSQL,
        name: 'postgres',
        listed: [],
      }),
      'unknown',
      'postgres is excluded from the PostgreSQL listing',
    )
    assertEqual(
      classifyDatabasePresence({
        engine: Engine.CockroachDB,
        name: 'defaultdb',
        listed: [],
      }),
      'unknown',
      'defaultdb is excluded from the CockroachDB listing',
    )
    assertEqual(
      classifyDatabasePresence({
        engine: Engine.MySQL,
        name: 'mysql',
        listed: [],
      }),
      'unknown',
      'mysql is excluded from the MySQL listing',
    )
  })

  it('returns unknown for a case-insensitive-only match', () => {
    assertEqual(
      classifyDatabasePresence({
        engine: Engine.MySQL,
        name: 'MyApp',
        listed: ['myapp'],
      }),
      'unknown',
      'case-only match',
    )
  })

  it('returns unknown for non-durable engines and an empty name', () => {
    assertEqual(
      classifyDatabasePresence({
        engine: Engine.MongoDB,
        name: 'app',
        listed: [],
      }),
      'unknown',
      'mongodb',
    )
    assertEqual(
      classifyDatabasePresence({
        engine: Engine.MariaDB,
        name: '',
        listed: [],
      }),
      'unknown',
      'empty name',
    )
  })
})

describe('probeDatabasePresence / databaseExists', () => {
  it('returns unknown (never throws) when listDatabases throws', async () => {
    const probe = await probeDatabasePresence({
      engine: {
        async listDatabases() {
          throw new Error('connection refused')
        },
      },
      container: makeConfig(),
      name: 'app',
    })
    assertEqual(probe.presence, 'unknown', 'presence')
    assertEqual(probe.listed, null, 'listed')
  })

  it('bounds the listing at 10 seconds by default', () => {
    assertEqual(DATABASE_PRESENCE_TIMEOUT_MS, 10_000, 'default timeout')
  })

  it('returns unknown within the bound when the listing never resolves', async () => {
    const started = Date.now()
    const probe = await probeDatabasePresence({
      engine: {
        listDatabases: () => new Promise<string[]>(() => {}),
      },
      container: makeConfig(),
      name: 'app',
      timeoutMs: 50,
    })
    const elapsed = Date.now() - started
    assertEqual(probe.presence, 'unknown', 'presence')
    assertEqual(probe.listed, null, 'listed')
    assert(elapsed < 2000, `should give up near the bound, took ${elapsed}ms`)
  })

  it('ignores a listing that settles after the deadline', async () => {
    let settle: (value: string[]) => void = () => {}
    let rejectLate: (error: Error) => void = () => {}
    const probe = await probeDatabasePresence({
      engine: {
        listDatabases: () =>
          new Promise<string[]>((resolve) => {
            settle = resolve
          }),
      },
      container: makeConfig(),
      name: 'app',
      timeoutMs: 20,
    })
    assertEqual(probe.presence, 'unknown', 'presence at the deadline')
    // A late empty listing must not turn into a false after the fact
    settle([])
    assertEqual(probe.presence, 'unknown', 'presence after a late listing')

    const rejecting = await probeDatabasePresence({
      engine: {
        listDatabases: () =>
          new Promise<string[]>((_resolve, reject) => {
            rejectLate = reject
          }),
      },
      container: makeConfig(),
      name: 'app',
      timeoutMs: 20,
    })
    // Must not surface as an unhandled rejection
    rejectLate(new Error('late failure'))
    await new Promise((resolve) => setImmediate(resolve))
    assertEqual(rejecting.presence, 'unknown', 'late rejection ignored')
  })

  it('leaves a fast listing unaffected by the bound', async () => {
    const probe = await probeDatabasePresence({
      engine: {
        async listDatabases() {
          return ['other']
        },
      },
      container: makeConfig(),
      name: 'app',
      timeoutMs: 1000,
    })
    assertEqual(probe.presence, false, 'presence')
    assertEqual(probe.listed?.join(','), 'other', 'listed')
  })

  it('returns unknown when listDatabases throws synchronously', async () => {
    const probe = await probeDatabasePresence({
      engine: {
        listDatabases: () => {
          throw new Error('sync failure')
        },
      },
      container: makeConfig(),
      name: 'app',
    })
    assertEqual(probe.presence, 'unknown', 'presence')
  })

  it('returns unknown for a malformed listing', async () => {
    const probe = await probeDatabasePresence({
      engine: {
        async listDatabases() {
          return 'app' as unknown as string[]
        },
      },
      container: makeConfig(),
      name: 'app',
    })
    assertEqual(probe.presence, 'unknown', 'presence')
  })

  it('never lists for a non-durable engine, so a synthetic fallback cannot prove absence', async () => {
    let listed = 0
    const probe = await probeDatabasePresence({
      engine: {
        // Mimics the engines whose listDatabases falls back to
        // [container.database] or [] on error
        async listDatabases() {
          listed++
          return []
        },
      },
      container: makeConfig({ engine: Engine.InfluxDB }),
      name: 'app',
    })
    assertEqual(probe.presence, 'unknown', 'presence')
    assertEqual(listed, 0, 'listDatabases should not be called')
  })

  it('returns the listing alongside a false verdict', async () => {
    const probe = await probeDatabasePresence({
      engine: {
        async listDatabases() {
          return ['other', 'test']
        },
      },
      container: makeConfig(),
      name: 'app',
    })
    assertEqual(probe.presence, false, 'presence')
    assertEqual(probe.listed?.join(','), 'other,test', 'listed')
  })

  it('databaseExists on a real engine instance follows its listing', async () => {
    for (const engine of DURABLE_ENGINES) {
      const instance = Object.create(getEngine(engine)) as ReturnType<
        typeof getEngine
      >
      instance.listDatabases = async () => ['test']
      const config = makeConfig({ engine })
      assertEqual(
        await instance.databaseExists(config, 'test'),
        true,
        `${engine} empty primary present`,
      )
      assertEqual(
        await instance.databaseExists(config, 'gone'),
        false,
        `${engine} missing`,
      )
      instance.listDatabases = async () => {
        throw new Error('boom')
      }
      assertEqual(
        await instance.databaseExists(config, 'test'),
        'unknown',
        `${engine} listing failure`,
      )
    }
  })

  it('databaseExists is unknown for every non-durable engine', async () => {
    for (const engine of ALL_ENGINES.filter(
      (e) => !DURABLE_ENGINES.includes(e),
    )) {
      const instance = Object.create(getEngine(engine)) as ReturnType<
        typeof getEngine
      >
      instance.listDatabases = async () => []
      assertEqual(
        await instance.databaseExists(makeConfig({ engine }), 'app'),
        'unknown',
        `${engine}`,
      )
    }
  })
})

describe('ensurePrimaryDatabase', () => {
  const superuser = 'root'

  it('reports present and still runs the idempotent create', async () => {
    const { engine, calls } = makeFakeEngine({ presence: true })
    const result = await ensurePrimaryDatabase({
      engine,
      config: makeConfig(),
      superuser,
      recreate: true,
      firstStart: false,
    })
    assertEqual(result.primaryDatabase.state, 'present', 'state')
    assertEqual(result.primaryDatabase.name, 'app', 'name')
    assertEqual(calls.createDatabase, 1, 'create called')
  })

  it('recreates a missing database by default and reports recreated', async () => {
    const { engine, calls } = makeFakeEngine({ presence: false })
    const result = await ensurePrimaryDatabase({
      engine,
      config: makeConfig(),
      superuser,
      recreate: true,
      firstStart: false,
    })
    assertEqual(result.primaryDatabase.state, 'recreated', 'state')
    assertEqual(result.ensure.kind, 'ready', 'ensure')
    assertEqual(calls.createDatabase, 1, 'create called')
  })

  it('leaves a missing database missing without recreate', async () => {
    const { engine, calls } = makeFakeEngine({ presence: false })
    let ensureStarted = false
    const result = await ensurePrimaryDatabase({
      engine,
      config: makeConfig(),
      superuser,
      recreate: false,
      firstStart: false,
      onEnsureStart: () => {
        ensureStarted = true
      },
    })
    assertEqual(result.primaryDatabase.state, 'missing', 'state')
    assertEqual(result.ensure.kind, 'skipped-missing', 'ensure')
    assertEqual(calls.createDatabase, 0, 'create not called')
    assertEqual(ensureStarted, false, 'ensure spinner not started')
  })

  it('skips the create without recreate when a durable probe is inconclusive', async () => {
    const { engine, calls } = makeFakeEngine({ presence: 'unknown' })
    const result = await ensurePrimaryDatabase({
      engine,
      config: makeConfig(),
      superuser,
      recreate: false,
      firstStart: false,
    })
    assertEqual(result.primaryDatabase.state, 'unknown', 'state')
    assertEqual(result.ensure.kind, 'skipped-unknown', 'ensure')
    assertEqual(calls.createDatabase, 0, 'create not called')
  })

  it('keeps the old create for a durable engine with an inconclusive probe by default', async () => {
    const { engine, calls } = makeFakeEngine({ presence: 'unknown' })
    const result = await ensurePrimaryDatabase({
      engine,
      config: makeConfig(),
      superuser,
      recreate: true,
      firstStart: false,
    })
    assertEqual(result.primaryDatabase.state, 'unknown', 'state')
    assertEqual(calls.createDatabase, 1, 'create called')
  })

  it('does not probe a non-durable engine and ignores recreate there', async () => {
    for (const recreate of [true, false]) {
      const { engine, calls } = makeFakeEngine({ presence: false })
      const result = await ensurePrimaryDatabase({
        engine,
        config: makeConfig({ engine: Engine.MongoDB }),
        superuser,
        recreate,
        firstStart: false,
      })
      assertEqual(result.primaryDatabase.state, 'unknown', 'state')
      assertEqual(calls.databaseExists, 0, 'no probe')
      assertEqual(
        calls.createDatabase,
        1,
        `create called (recreate=${recreate})`,
      )
    }
  })

  it('skips engines without database creation exactly as before', async () => {
    const { engine, calls } = makeFakeEngine({ presence: 'unknown' })
    const result = await ensurePrimaryDatabase({
      engine,
      config: makeConfig({ engine: Engine.Redis, database: '0' }),
      superuser: '',
      recreate: true,
      firstStart: false,
    })
    assertEqual(result.ensure.kind, 'not-applicable', 'ensure')
    assertEqual(result.primaryDatabase.state, 'unknown', 'state')
    assertEqual(calls.createDatabase, 0, 'create not called')
  })

  it('skips the create when the database is the superuser name', async () => {
    const { engine, calls } = makeFakeEngine({ presence: false })
    const result = await ensurePrimaryDatabase({
      engine,
      config: makeConfig({ database: 'root' }),
      superuser,
      recreate: true,
      firstStart: false,
    })
    assertEqual(result.ensure.kind, 'not-applicable', 'ensure')
    assertEqual(result.primaryDatabase.state, 'missing', 'state')
    assertEqual(calls.createDatabase, 0, 'create not called')
  })

  it('reports missing when the recreate itself fails', async () => {
    const { engine } = makeFakeEngine({
      presence: false,
      createError: 'Access denied',
    })
    const result = await ensurePrimaryDatabase({
      engine,
      config: makeConfig(),
      superuser,
      recreate: true,
      firstStart: false,
    })
    assertEqual(result.ensure.kind, 'failed', 'ensure')
    assertEqual(result.primaryDatabase.state, 'missing', 'state')
  })

  it('treats an "already exists" create error as ready', async () => {
    const { engine } = makeFakeEngine({
      presence: 'unknown',
      createError: 'database "app" already exists',
    })
    const result = await ensurePrimaryDatabase({
      engine,
      config: makeConfig({ engine: Engine.PostgreSQL }),
      superuser: 'postgres',
      recreate: true,
      firstStart: false,
    })
    assertEqual(result.ensure.kind, 'ready', 'ensure')
  })

  it('reports created (not recreated) on the first start of a --no-start container', async () => {
    for (const recreate of [true, false]) {
      const { engine, calls } = makeFakeEngine({ presence: false })
      const result = await ensurePrimaryDatabase({
        engine,
        config: makeConfig({ status: 'created' }),
        superuser,
        recreate,
        firstStart: true,
      })
      assertEqual(
        result.primaryDatabase.state,
        'created',
        `state (recreate=${recreate})`,
      )
      assertEqual(
        calls.createDatabase,
        1,
        `create called (recreate=${recreate})`,
      )
    }
  })

  it('resolvePrimaryDatabaseState: created in between counts as present', () => {
    assertEqual(
      resolvePrimaryDatabaseState({
        presence: false,
        ensure: { kind: 'ready', alreadyExisted: true },
        firstStart: false,
      }),
      'present',
      'state',
    )
  })
})

describe('start --no-recreate-database', () => {
  it('registers the flag, defaulting to recreate', () => {
    const option = startCommand.options.find(
      (o) => o.long === '--no-recreate-database',
    )
    assert(option !== undefined, 'start should have --no-recreate-database')
    assertEqual(option.negate, true, 'flag should be a negation')
    assertEqual(option.attributeName(), 'recreateDatabase', 'attribute name')
  })
})

describe('buildSyncedDatabaseList', () => {
  it('keeps the primary first and flags a durable primary absent from the listing', () => {
    const result = buildSyncedDatabaseList({
      engine: Engine.MariaDB,
      primary: 'app',
      listed: ['zeta', 'alpha'],
    })
    assertEqual(result.databases.join(','), 'app,alpha,zeta', 'order')
    assertEqual(result.primaryMissing, true, 'primaryMissing')
  })

  it('does not flag a listed primary (including an empty one named test)', () => {
    const result = buildSyncedDatabaseList({
      engine: Engine.MariaDB,
      primary: 'test',
      listed: ['test', 'b', 'a'],
    })
    assertEqual(result.databases.join(','), 'test,a,b', 'order')
    assertEqual(result.primaryMissing, false, 'primaryMissing')
  })

  it('never flags a non-durable engine or a filtered system name', () => {
    assertEqual(
      buildSyncedDatabaseList({
        engine: Engine.MongoDB,
        primary: 'app',
        listed: [],
      }).primaryMissing,
      false,
      'mongodb',
    )
    assertEqual(
      buildSyncedDatabaseList({
        engine: Engine.PostgreSQL,
        primary: 'postgres',
        listed: ['app'],
      }).primaryMissing,
      false,
      'postgres',
    )
  })
})

describe('backup database_not_found', () => {
  it('returns the structured refusal when the server proves the target absent', async () => {
    const result = await checkBackupTarget({
      engine: {
        async listDatabases() {
          return ['renamed_app', 'test']
        },
      },
      container: makeConfig(),
      database: 'app',
    })
    assert(result !== null, 'should refuse')
    assertEqual(result.code, 'database_not_found', 'code')
    assertEqual(result.database, 'app', 'database')
    assertEqual(
      result.availableDatabases.join(','),
      'renamed_app,test',
      'availableDatabases',
    )
    assert(
      result.error.includes('renamed_app') &&
        result.error.includes('spindb databases refresh primary-test'),
      `error should be actionable: ${result.error}`,
    )
  })

  it('proceeds when the target exists, when the listing fails, and for non-durable engines', async () => {
    assertEqual(
      await checkBackupTarget({
        engine: {
          async listDatabases() {
            return ['app']
          },
        },
        container: makeConfig(),
        database: 'app',
      }),
      null,
      'present',
    )
    assertEqual(
      await checkBackupTarget({
        engine: {
          async listDatabases() {
            throw new Error('timeout')
          },
        },
        container: makeConfig(),
        database: 'app',
      }),
      null,
      'listing failed',
    )
    assertEqual(
      await checkBackupTarget({
        engine: {
          async listDatabases() {
            return []
          },
        },
        container: makeConfig({ engine: Engine.MongoDB }),
        database: 'app',
      }),
      null,
      'non-durable',
    )
  })
})
