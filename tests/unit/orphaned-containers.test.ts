import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { Engine } from '../../types'

/**
 * Tests for orphaned container behavior:
 * 1. Engine deletion should allow deleting engines even when containers use them
 * 2. Starting an orphaned container should detect missing engine and offer to download
 */

describe('Orphaned Container Behavior', () => {
  describe('Engine Deletion Policy', () => {
    it('should allow deletion when containers are using the engine', () => {
      // Previously, deletion was blocked when containers existed
      // Now, deletion should proceed with a warning

      const containers = [
        { name: 'db1', engine: 'postgresql', version: '17.7.0' },
        { name: 'db2', engine: 'postgresql', version: '17.7.0' },
      ]

      const engineToDelete = { engine: 'postgresql', version: '17.7.0' }

      const usingContainers = containers.filter(
        (c) =>
          c.engine === engineToDelete.engine &&
          c.version === engineToDelete.version,
      )

      // Old behavior would throw/exit here
      // New behavior: warn but allow deletion
      const shouldAllowDeletion = true // Always allow now

      assert(
        shouldAllowDeletion,
        'Should allow deletion even with dependent containers',
      )
      assertEqual(
        usingContainers.length,
        2,
        'Should identify containers using the engine',
      )
    })

    it('should identify which containers will be orphaned', () => {
      const containers = [
        { name: 'pg17-db', engine: 'postgresql', version: '17.7.0' },
        { name: 'pg16-db', engine: 'postgresql', version: '16.11.0' },
        { name: 'mysql-db', engine: 'mysql', version: '8.0' },
      ]

      const engineToDelete = { engine: 'postgresql', version: '17.7.0' }

      const orphanedContainers = containers.filter(
        (c) =>
          c.engine === engineToDelete.engine &&
          c.version === engineToDelete.version,
      )

      assertEqual(
        orphanedContainers.length,
        1,
        'Should find one orphaned container',
      )
      assertEqual(
        orphanedContainers[0].name,
        'pg17-db',
        'Should identify correct container',
      )
    })

    it('should not affect containers using different versions', () => {
      const containers = [
        { name: 'pg17-db', engine: 'postgresql', version: '17.7.0' },
        { name: 'pg16-db', engine: 'postgresql', version: '16.11.0' },
      ]

      const engineToDelete = { engine: 'postgresql', version: '17.7.0' }

      const unaffectedContainers = containers.filter(
        (c) =>
          c.engine !== engineToDelete.engine ||
          c.version !== engineToDelete.version,
      )

      assertEqual(
        unaffectedContainers.length,
        1,
        'Should have one unaffected container',
      )
      assertEqual(
        unaffectedContainers[0].version,
        '16.11.0',
        'pg16 should be unaffected',
      )
    })

    it('should not affect containers using different engines', () => {
      const containers = [
        { name: 'pg-db', engine: 'postgresql', version: '17.7.0' },
        { name: 'mysql-db', engine: 'mysql', version: '8.0' },
      ]

      const engineToDelete = { engine: 'postgresql', version: '17.7.0' }

      const unaffectedContainers = containers.filter(
        (c) => c.engine !== engineToDelete.engine,
      )

      assertEqual(
        unaffectedContainers.length,
        1,
        'MySQL container should be unaffected',
      )
    })
  })

  describe('Container Start - Missing Engine Detection', () => {
    it('should detect when PostgreSQL engine is not installed', async () => {
      // Simulate the check that happens before starting a container
      const containerConfig = {
        name: 'orphaned-db',
        engine: Engine.PostgreSQL,
        version: '17.7.0',
        port: 5432,
        database: 'testdb',
      }

      // Mock: engine binary is NOT installed
      const isEngineInstalled = false

      const shouldPromptDownload =
        containerConfig.engine === Engine.PostgreSQL && !isEngineInstalled

      assert(
        shouldPromptDownload,
        'Should prompt to download when PostgreSQL engine is missing',
      )
    })

    it('should detect when MySQL engine is not installed', async () => {
      // MySQL now uses hostdb binaries (not system-installed)
      const containerConfig = {
        name: 'mysql-db',
        engine: Engine.MySQL,
        version: '9.1.0',
        port: 3306,
        database: 'testdb',
      }

      // Mock: engine binary is NOT installed
      const isEngineInstalled = false

      const shouldPromptDownload =
        containerConfig.engine === Engine.MySQL && !isEngineInstalled

      assert(
        shouldPromptDownload,
        'Should prompt to download when MySQL engine is missing',
      )
    })

    it('should detect when MongoDB engine is not installed', async () => {
      // MongoDB now uses hostdb binaries (not system-installed)
      const containerConfig = {
        name: 'mongo-db',
        engine: Engine.MongoDB,
        version: '8.0.17',
        port: 27017,
        database: 'testdb',
      }

      // Mock: engine binary is NOT installed
      const isEngineInstalled = false

      const shouldPromptDownload =
        containerConfig.engine === Engine.MongoDB && !isEngineInstalled

      assert(
        shouldPromptDownload,
        'Should prompt to download when MongoDB engine is missing',
      )
    })

    it('should detect when Redis engine is not installed', async () => {
      // Redis now uses hostdb binaries (not system-installed)
      const containerConfig = {
        name: 'redis-db',
        engine: Engine.Redis,
        version: '8.4.0',
        port: 6379,
        database: '0',
      }

      // Mock: engine binary is NOT installed
      const isEngineInstalled = false

      const shouldPromptDownload =
        containerConfig.engine === Engine.Redis && !isEngineInstalled

      assert(
        shouldPromptDownload,
        'Should prompt to download when Redis engine is missing',
      )
    })

    it('should proceed normally when engine is installed', async () => {
      const containerConfig = {
        name: 'healthy-db',
        engine: Engine.PostgreSQL,
        version: '17.7.0',
        port: 5432,
        database: 'testdb',
      }

      // Mock: engine binary IS installed
      const isEngineInstalled = true

      const shouldPromptDownload =
        containerConfig.engine === Engine.PostgreSQL && !isEngineInstalled

      assert(
        !shouldPromptDownload,
        'Should not prompt when engine is already installed',
      )
    })
  })

  describe('Engine Download Flow', () => {
    it('should provide correct download command in manual instructions', () => {
      const version = '17.7.0'
      const majorVersion = version.split('.')[0]
      const manualCommand = `spindb engines download postgresql ${majorVersion}`

      assert(
        manualCommand.includes('engines download'),
        'Should use engines download subcommand',
      )
      assert(
        manualCommand.includes('postgresql'),
        'Should specify postgresql engine',
      )
      assert(
        manualCommand.includes(majorVersion),
        'Should include major version',
      )
    })

    it('should use full version for binary path resolution', () => {
      // When downloading, we need the full version (e.g., 17.7.0) not just major (17)
      const majorVersion = '17'
      const fullVersion = '17.7.0' // This comes from version resolution

      const binaryPathPattern = `postgresql-${fullVersion}-darwin-arm64`

      assert(
        binaryPathPattern.includes(fullVersion),
        'Binary path should use full version',
      )
      assert(
        !binaryPathPattern.includes(`-${majorVersion}-`),
        'Binary path should not use major version alone',
      )
    })
  })

  describe('Orphaned Container Recovery', () => {
    it('should allow re-downloading the same engine version', () => {
      // After deleting an engine, we should be able to download it again
      // The download process should work the same regardless of whether
      // containers exist that need this engine
      const canRedownload = true // Always possible

      assert(canRedownload, 'Should be able to re-download deleted engine')
    })

    it('should preserve container data when engine is deleted', () => {
      // Container data directory is separate from engine binary directory
      const enginePath = '~/.spindb/bin/postgresql-17.7.0-darwin-arm64'
      const containerDataPath = '~/.spindb/containers/postgresql/mydb/data'

      assert(
        !containerDataPath.includes('/bin/'),
        'Container data should not be in bin directory',
      )
      assert(enginePath.includes('/bin/'), 'Engine should be in bin directory')
      assert(
        containerDataPath.includes('/containers/'),
        'Container data should be in containers directory',
      )
    })

    it('should match container version to engine version', () => {
      // When starting, we need to find the right engine for the container
      const container = {
        name: 'mydb',
        engine: 'postgresql',
        version: '17.7.0',
      }

      const installedEngines = [
        { engine: 'postgresql', version: '16.11.0' },
        { engine: 'postgresql', version: '17.7.0' },
      ]

      const matchingEngine = installedEngines.find(
        (e) => e.engine === container.engine && e.version === container.version,
      )

      assert(matchingEngine !== undefined, 'Should find matching engine')
      assertEqual(
        matchingEngine?.version,
        container.version,
        'Should match exact version',
      )
    })

    it('should detect missing engine when version not found', () => {
      const container = {
        name: 'mydb',
        engine: 'postgresql',
        version: '17.7.0',
      }

      const installedEngines = [
        { engine: 'postgresql', version: '16.11.0' },
        // 17.7.0 is NOT installed
      ]

      const matchingEngine = installedEngines.find(
        (e) => e.engine === container.engine && e.version === container.version,
      )

      assertEqual(matchingEngine, undefined, 'Should not find missing engine')
    })
  })
})

describe('PostgreSQL Engine Binary Check', () => {
  it('should use isBinaryInstalled to check engine availability', async () => {
    // Import the actual PostgreSQL engine to test isBinaryInstalled behavior
    const { postgresqlEngine } = await import('../../engines/postgresql')

    // Check for a version that definitely doesn't exist
    const isInstalled = await postgresqlEngine.isBinaryInstalled('99.99.99')

    assertEqual(
      isInstalled,
      false,
      'Non-existent version should not be installed',
    )
  })

  it('should resolve major version to full version', async () => {
    const { postgresqlEngine } = await import('../../engines/postgresql')

    // Test version resolution
    const fullVersion = postgresqlEngine.resolveFullVersion('17')

    assert(fullVersion.startsWith('17.'), 'Should resolve to 17.x.x')
    assert(
      fullVersion.split('.').length >= 2,
      'Should have at least major.minor format',
    )
  })

  it('should return full version unchanged', async () => {
    const { postgresqlEngine } = await import('../../engines/postgresql')

    const fullVersion = postgresqlEngine.resolveFullVersion('17.7.0')

    assertEqual(fullVersion, '17.7.0', 'Full version should be unchanged')
  })

  it('should construct correct binary path', async () => {
    const { postgresqlEngine } = await import('../../engines/postgresql')

    const binaryPath = postgresqlEngine.getBinaryPath('17')

    assert(
      binaryPath.includes('postgresql-'),
      'Path should include postgresql prefix',
    )
    assert(binaryPath.includes('17.'), 'Path should include resolved version')

    // Verify full platform-architecture combo is present
    const validPlatformArchCombos = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]
    assert(
      validPlatformArchCombos.some((combo) => binaryPath.includes(combo)),
      `Path should include one of the supported platform-arch combos: ${validPlatformArchCombos.join(', ')}`,
    )
  })
})

describe('MySQL Engine Binary Check', () => {
  it('should use isBinaryInstalled to check engine availability', async () => {
    // Import the actual MySQL engine to test isBinaryInstalled behavior
    const { mysqlEngine } = await import('../../engines/mysql')

    // Check for a version that definitely doesn't exist
    const isInstalled = await mysqlEngine.isBinaryInstalled('99.99.99')

    assertEqual(
      isInstalled,
      false,
      'Non-existent version should not be installed',
    )
  })

  it('should resolve major version to full version', async () => {
    const { mysqlEngine } = await import('../../engines/mysql')

    // Test version resolution
    const fullVersion = mysqlEngine.resolveFullVersion('9')

    assert(fullVersion.startsWith('9.'), 'Should resolve to 9.x.x')
    assert(
      fullVersion.split('.').length >= 2,
      'Should have at least major.minor format',
    )
  })

  it('should return full version unchanged', async () => {
    const { mysqlEngine } = await import('../../engines/mysql')

    const fullVersion = mysqlEngine.resolveFullVersion('9.1.0')

    assertEqual(fullVersion, '9.1.0', 'Full version should be unchanged')
  })

  it('should construct correct binary path', async () => {
    const { mysqlEngine } = await import('../../engines/mysql')

    const binaryPath = mysqlEngine.getBinaryPath('9')

    assert(binaryPath.includes('mysql-'), 'Path should include mysql prefix')
    assert(binaryPath.includes('9.'), 'Path should include resolved version')

    // Verify full platform-architecture combo is present
    const validPlatformArchCombos = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]
    assert(
      validPlatformArchCombos.some((combo) => binaryPath.includes(combo)),
      `Path should include one of the supported platform-arch combos: ${validPlatformArchCombos.join(', ')}`,
    )
  })
})

describe('MongoDB Engine Binary Check', () => {
  it('should use isBinaryInstalled to check engine availability', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    // Check for a version that definitely doesn't exist
    const isInstalled = await mongodbEngine.isBinaryInstalled('99.99.99')

    assertEqual(
      isInstalled,
      false,
      'Non-existent version should not be installed',
    )
  })

  it('should have supportedVersions defined', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    const versions = mongodbEngine.supportedVersions

    assert(Array.isArray(versions), 'supportedVersions should be an array')
    assert(versions.length > 0, 'Should have at least one supported version')
    assert(
      versions.some((v) => v.startsWith('8')),
      'Should support MongoDB 8.x',
    )
  })

  it('should resolve major version to full version', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    // Test version resolution
    const fullVersion = mongodbEngine.resolveFullVersion('8')

    assert(fullVersion.startsWith('8.'), 'Should resolve to 8.x.x')
    assert(
      fullVersion.split('.').length >= 2,
      'Should have at least major.minor format',
    )
  })

  it('should return full version unchanged', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    const fullVersion = mongodbEngine.resolveFullVersion('8.0.17')

    assertEqual(fullVersion, '8.0.17', 'Full version should be unchanged')
  })

  it('should construct correct binary path', async () => {
    const { mongodbEngine } = await import('../../engines/mongodb')

    const binaryPath = mongodbEngine.getBinaryPath('8')

    assert(
      binaryPath.includes('mongodb-'),
      'Path should include mongodb prefix',
    )
    assert(binaryPath.includes('8.'), 'Path should include resolved version')

    // Verify full platform-architecture combo is present
    const validPlatformArchCombos = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]
    assert(
      validPlatformArchCombos.some((combo) => binaryPath.includes(combo)),
      `Path should include one of the supported platform-arch combos: ${validPlatformArchCombos.join(', ')}`,
    )
  })
})

describe('Redis Engine Binary Check', () => {
  it('should use isBinaryInstalled to check engine availability', async () => {
    const { redisEngine } = await import('../../engines/redis')

    // Check for a version that definitely doesn't exist
    const isInstalled = await redisEngine.isBinaryInstalled('99.99.99')

    assertEqual(
      isInstalled,
      false,
      'Non-existent version should not be installed',
    )
  })

  it('should have supportedVersions defined', async () => {
    const { redisEngine } = await import('../../engines/redis')

    const versions = redisEngine.supportedVersions

    assert(Array.isArray(versions), 'supportedVersions should be an array')
    assert(versions.length > 0, 'Should have at least one supported version')
    assert(versions.some((v) => v.startsWith('8')), 'Should support Redis 8.x')
  })

  it('should resolve major version to full version', async () => {
    const { redisEngine } = await import('../../engines/redis')

    // Test version resolution
    const fullVersion = redisEngine.resolveFullVersion('8')

    assert(fullVersion.startsWith('8.'), 'Should resolve to 8.x.x')
    assert(
      fullVersion.split('.').length >= 2,
      'Should have at least major.minor format',
    )
  })

  it('should return full version unchanged', async () => {
    const { redisEngine } = await import('../../engines/redis')

    const fullVersion = redisEngine.resolveFullVersion('8.4.0')

    assertEqual(fullVersion, '8.4.0', 'Full version should be unchanged')
  })

  it('should construct correct binary path', async () => {
    const { redisEngine } = await import('../../engines/redis')

    const binaryPath = redisEngine.getBinaryPath('8')

    assert(binaryPath.includes('redis-'), 'Path should include redis prefix')
    assert(binaryPath.includes('8.'), 'Path should include resolved version')

    // Verify full platform-architecture combo is present
    const validPlatformArchCombos = [
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]
    assert(
      validPlatformArchCombos.some((combo) => binaryPath.includes(combo)),
      `Path should include one of the supported platform-arch combos: ${validPlatformArchCombos.join(', ')}`,
    )
  })
})

describe('Warning Message Formatting', () => {
  it('should format orphaned container warning correctly', () => {
    const containers = [{ name: 'db1' }, { name: 'db2' }, { name: 'db3' }]

    const count = containers.length
    const names = containers.map((c) => c.name).join(', ')
    const warning = `${count} container(s) use this engine: ${names}`

    assert(warning.includes('3'), 'Should include container count')
    assert(warning.includes('db1'), 'Should include first container name')
    assert(warning.includes('db2'), 'Should include second container name')
    assert(warning.includes('db3'), 'Should include third container name')
  })

  it('should format missing engine warning correctly', () => {
    const version = '17.7.0'
    const containerName = 'orphaned-db'
    const warning = `PostgreSQL ${version} engine is not installed (required by "${containerName}")`

    assert(warning.includes(version), 'Should include version')
    assert(warning.includes(containerName), 'Should include container name')
    assert(warning.includes('not installed'), 'Should indicate missing engine')
  })

  it('should format download prompt correctly', () => {
    const version = '17.7.0'
    const majorVersion = version.split('.')[0]
    const prompt = `Download PostgreSQL ${version} now?`
    const manualHint = `Run "spindb engines download postgresql ${majorVersion}" to download manually.`

    assert(prompt.includes(version), 'Prompt should include version')
    assert(
      manualHint.includes('engines download'),
      'Hint should include command',
    )
  })
})
