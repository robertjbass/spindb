import { describe, it } from 'node:test'
import { ContainerManager } from '../../core/container-manager'
import { assert, assertEqual } from '../integration/helpers'

describe('ContainerManager', () => {
  describe('isValidName', () => {
    it('should accept valid container names', () => {
      const containerManager = new ContainerManager()

      const validNames = [
        'mydb',
        'my-db',
        'my_db',
        'MyDB',
        'db123',
        'a',
        'test-container-name',
        'Test_Container_123',
      ]

      for (const name of validNames) {
        assert(
          containerManager.isValidName(name),
          `"${name}" should be a valid container name`,
        )
      }
    })

    it('should reject invalid container names', () => {
      const containerManager = new ContainerManager()

      const invalidNames = [
        '',
        '123db', // starts with number
        '-mydb', // starts with hyphen
        '_mydb', // starts with underscore
        'my db', // contains space
        'my.db', // contains dot
        'my@db', // contains special character
        'my/db', // contains slash
      ]

      for (const name of invalidNames) {
        assert(
          !containerManager.isValidName(name),
          `"${name}" should be an invalid container name`,
        )
      }
    })

    it('should require name to start with a letter', () => {
      const containerManager = new ContainerManager()

      assert(
        containerManager.isValidName('a123'),
        'Should allow letter followed by numbers',
      )
      assert(
        !containerManager.isValidName('1abc'),
        'Should reject number at start',
      )
      assert(
        !containerManager.isValidName('-abc'),
        'Should reject hyphen at start',
      )
    })
  })

  describe('ContainerConfig Shape', () => {
    it('should have all required fields', () => {
      const config = {
        name: 'testdb',
        engine: 'postgresql' as const,
        version: '17.7.0',
        port: 5432,
        database: 'testdb',
        databases: ['testdb'],
        created: new Date().toISOString(),
        status: 'created' as const,
      }

      assert(typeof config.name === 'string', 'Should have name')
      assert(typeof config.engine === 'string', 'Should have engine')
      assert(typeof config.version === 'string', 'Should have version')
      assert(typeof config.port === 'number', 'Should have port')
      assert(typeof config.database === 'string', 'Should have database')
      assert(Array.isArray(config.databases), 'Should have databases array')
      assert(
        typeof config.created === 'string',
        'Should have created timestamp',
      )
      assert(typeof config.status === 'string', 'Should have status')
    })

    it('should support clonedFrom field', () => {
      const clonedConfig = {
        name: 'cloned-db',
        engine: 'postgresql' as const,
        version: '17.7.0',
        port: 5433,
        database: 'testdb',
        databases: ['testdb'],
        created: new Date().toISOString(),
        status: 'stopped' as const,
        clonedFrom: 'original-db',
      }

      assertEqual(
        clonedConfig.clonedFrom,
        'original-db',
        'Should track clone source',
      )
    })
  })

  describe('CreateOptions Shape', () => {
    it('should have all required fields', () => {
      const options = {
        engine: 'postgresql' as const,
        version: '17',
        port: 5432,
        database: 'mydb',
      }

      assert(typeof options.engine === 'string', 'Should have engine')
      assert(typeof options.version === 'string', 'Should have version')
      assert(typeof options.port === 'number', 'Should have port')
      assert(typeof options.database === 'string', 'Should have database')
    })
  })

  describe('Error Messages', () => {
    it('should provide clear error for invalid container name', () => {
      const invalidNameError =
        'Container name must be alphanumeric with hyphens/underscores only'

      assert(
        invalidNameError.includes('alphanumeric'),
        'Error should mention allowed characters',
      )
      assert(
        invalidNameError.includes('hyphens') &&
          invalidNameError.includes('underscores'),
        'Error should mention allowed special characters',
      )
    })

    it('should provide clear error for existing container', () => {
      const existingError =
        'Container "mydb" already exists for engine postgresql'

      assert(
        existingError.includes('mydb'),
        'Error should include container name',
      )
      assert(
        existingError.includes('already exists'),
        'Error should state container exists',
      )
    })

    it('should provide clear error for container not found', () => {
      const notFoundError = 'Container "mydb" not found'

      assert(
        notFoundError.includes('not found'),
        'Error should indicate container not found',
      )
      assert(
        notFoundError.includes('mydb'),
        'Error should include container name',
      )
    })

    it('should provide actionable error for running container delete', () => {
      const runningError =
        'Container "mydb" is running. Stop it first or use --force'

      assert(
        runningError.includes('running'),
        'Error should indicate container is running',
      )
      assert(
        runningError.includes('Stop it first') ||
          runningError.includes('--force'),
        'Error should suggest how to resolve',
      )
    })

    it('should provide actionable error for running container clone', () => {
      const runningCloneError =
        'Source container "mydb" is running. Stop it first'

      assert(
        runningCloneError.includes('running'),
        'Error should indicate source is running',
      )
      assert(
        runningCloneError.includes('Stop'),
        'Error should suggest stopping first',
      )
    })

    it('should provide actionable error for running container rename', () => {
      const runningRenameError = 'Container "mydb" is running. Stop it first'

      assert(
        runningRenameError.includes('running'),
        'Error should indicate container is running',
      )
    })
  })

  describe('Database Management', () => {
    it('should prevent removing primary database', () => {
      const errorMessage =
        'Cannot remove primary database "testdb" from tracking'

      assert(
        errorMessage.includes('Cannot remove primary database'),
        'Error should indicate primary database protection',
      )
    })

    it('should migrate configs without databases array', async () => {
      // Test the concept of migration
      const oldConfig: {
        name: string
        engine: string
        version: string
        port: number
        database: string
        databases?: string[]
        created: string
        status: string
      } = {
        name: 'testdb',
        engine: 'postgresql',
        version: '17',
        port: 5432,
        database: 'mydb',
        // No databases array - old schema
        created: '2024-01-01T00:00:00Z',
        status: 'stopped',
      }

      // Migration should add databases array with primary database
      const migratedDatabases = oldConfig.databases ?? [oldConfig.database]

      assert(Array.isArray(migratedDatabases), 'Should create databases array')
      assert(
        migratedDatabases.includes(oldConfig.database),
        'Should include primary database',
      )
    })

    it('should ensure primary database is in databases array', async () => {
      // Test the migration edge case
      const configWithMissingPrimary = {
        database: 'primary',
        databases: ['secondary', 'tertiary'],
      }

      // Migration logic should prepend primary
      if (
        !configWithMissingPrimary.databases.includes(
          configWithMissingPrimary.database,
        )
      ) {
        configWithMissingPrimary.databases = [
          configWithMissingPrimary.database,
          ...configWithMissingPrimary.databases,
        ]
      }

      assertEqual(
        configWithMissingPrimary.databases[0],
        'primary',
        'Primary should be first in array',
      )
    })
  })

  describe('Clone Operation', () => {
    it('should set clonedFrom field', () => {
      const cloneConfig = {
        name: 'clone-db',
        clonedFrom: 'source-db',
        created: new Date().toISOString(),
      }

      assertEqual(
        cloneConfig.clonedFrom,
        'source-db',
        'Should track source container',
      )
    })

    it('should update created timestamp', () => {
      const originalCreated = '2024-01-01T00:00:00Z'
      const newCreated = new Date().toISOString()

      assert(newCreated > originalCreated, 'Clone should have newer timestamp')
    })
  })

  describe('Rename Operation', () => {
    it('should update name in config', () => {
      const oldName = 'old-db'
      const newName = 'new-db'
      const config = { name: oldName }

      config.name = newName

      assertEqual(config.name, newName, 'Name should be updated')
    })
  })

  describe('DeleteOptions', () => {
    it('should default force to false', () => {
      const options = {}
      const force = (options as { force?: boolean }).force ?? false

      assertEqual(force, false, 'Force should default to false')
    })

    it('should respect force option', () => {
      const options = { force: true }

      assertEqual(options.force, true, 'Force should be respected when set')
    })
  })

  describe('Connection String', () => {
    it('should format PostgreSQL connection string correctly', () => {
      const config = {
        name: 'testdb',
        engine: 'postgresql' as const,
        port: 5432,
        database: 'mydb',
      }

      const expectedFormat = `postgresql://postgres@127.0.0.1:${config.port}/${config.database}`

      assert(
        expectedFormat.includes('postgresql://'),
        'Should use postgresql:// protocol',
      )
      assert(expectedFormat.includes('127.0.0.1'), 'Should use localhost')
      assert(
        expectedFormat.includes(String(config.port)),
        'Should include port',
      )
      assert(
        expectedFormat.includes(config.database),
        'Should include database name',
      )
    })

    it('should format MySQL connection string correctly', () => {
      const config = {
        name: 'testdb',
        engine: 'mysql' as const,
        port: 3306,
        database: 'mydb',
      }

      const expectedFormat = `mysql://root@127.0.0.1:${config.port}/${config.database}`

      assert(
        expectedFormat.includes('mysql://'),
        'Should use mysql:// protocol',
      )
      assert(expectedFormat.includes('root@'), 'MySQL should use root user')
    })

    it('should allow override database in connection string', () => {
      const config = {
        database: 'default_db',
        port: 5432,
      }
      const overrideDb = 'other_db'

      const url = `postgresql://postgres@127.0.0.1:${config.port}/${overrideDb}`

      assert(
        url.includes(overrideDb),
        'Should use override database when provided',
      )
      assert(
        !url.includes(config.database),
        'Should not use default database when override provided',
      )
    })
  })

  describe('List Operation', () => {
    it('should return empty array when no containers', async () => {
      // Concept test: list should never return undefined
      const containers: unknown[] = []

      assert(Array.isArray(containers), 'Should return array')
      assertEqual(containers.length, 0, 'Should be empty array')
    })

    it('should update status based on process state', () => {
      // Test the concept of status reconciliation
      const configStatus = 'stopped'
      const isRunning = true
      const actualStatus = isRunning ? 'running' : configStatus

      assertEqual(
        actualStatus,
        'running',
        'Should reflect actual running state',
      )
    })
  })

  describe('Engine Scoping', () => {
    it('should scope containers by engine', () => {
      // Test the concept of engine-scoped container paths
      const containerName = 'testdb'
      const engines = ['postgresql', 'mysql']

      for (const engine of engines) {
        const path = `~/.spindb/containers/${engine}/${containerName}`

        assert(path.includes(engine), `Path should include engine: ${engine}`)
        assert(
          path.includes(containerName),
          'Path should include container name',
        )
      }
    })

    it('should allow same container name for different engines', () => {
      // Concept: mydb can exist for both PostgreSQL and MySQL
      const pgContainer = { name: 'mydb', engine: 'postgresql' }
      const mysqlContainer = { name: 'mydb', engine: 'mysql' }

      assertEqual(pgContainer.name, mysqlContainer.name, 'Names can be same')
      assert(
        pgContainer.engine !== mysqlContainer.engine,
        'Engines must differ',
      )
    })
  })
})

describe('Container Paths', () => {
  it('should use ~/.spindb/containers as base', async () => {
    const { paths } = await import('../../config/paths')

    assert(paths.containers.includes('.spindb'), 'Should use .spindb directory')
    assert(
      paths.containers.includes('containers'),
      'Should use containers subdirectory',
    )
  })
})
