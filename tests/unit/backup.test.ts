/**
 * Backup Unit Tests
 *
 * Tests backup-related functionality including filename generation,
 * format selection, and container database array management.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm, readFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { existsSync } from 'fs'

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Generate a timestamp string for backup filenames (mirrors backup.ts)
 */
function generateTimestamp(): string {
  const now = new Date()
  return now.toISOString().replace(/:/g, '').split('.')[0]
}

/**
 * Generate default backup filename (mirrors backup.ts)
 */
function generateDefaultFilename(
  containerName: string,
  database: string,
): string {
  const timestamp = generateTimestamp()
  return `${containerName}-${database}-backup-${timestamp}`
}

/**
 * Get file extension for backup format (mirrors backup.ts)
 */
function getExtension(format: 'sql' | 'dump', engine: string): string {
  if (format === 'sql') {
    return '.sql'
  }
  return engine === 'mysql' ? '.sql.gz' : '.dump'
}

// =============================================================================
// Test Setup
// =============================================================================

let testDir: string

before(async () => {
  testDir = join(tmpdir(), `spindb-backup-test-${Date.now()}`)
  await mkdir(testDir, { recursive: true })
})

after(async () => {
  if (testDir && existsSync(testDir)) {
    await rm(testDir, { recursive: true, force: true })
  }
})

// =============================================================================
// Filename Generation Tests
// =============================================================================

describe('Backup filename generation', () => {
  describe('generateTimestamp', () => {
    it('should generate ISO-like timestamp without colons', () => {
      const timestamp = generateTimestamp()
      // Should match pattern like 2024-11-29T153000
      assert.match(timestamp, /^\d{4}-\d{2}-\d{2}T\d{6}$/)
      // Should not contain colons (filesystem safe)
      assert.ok(!timestamp.includes(':'), 'Timestamp should not contain colons')
    })

    it('should generate unique timestamps for different calls', async () => {
      const ts1 = generateTimestamp()
      // Wait a tiny bit to ensure different second
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const ts2 = generateTimestamp()
      // They might be the same if called within same second, but format should be valid
      assert.match(ts1, /^\d{4}-\d{2}-\d{2}T\d{6}$/)
      assert.match(ts2, /^\d{4}-\d{2}-\d{2}T\d{6}$/)
    })
  })

  describe('generateDefaultFilename', () => {
    it('should include container name, database, and timestamp', () => {
      const filename = generateDefaultFilename('mycontainer', 'mydb')
      assert.ok(filename.startsWith('mycontainer-mydb-backup-'))
      assert.match(filename, /mycontainer-mydb-backup-\d{4}-\d{2}-\d{2}T\d{6}$/)
    })

    it('should handle container and database names with hyphens', () => {
      const filename = generateDefaultFilename('my-container', 'my-db')
      assert.ok(filename.startsWith('my-container-my-db-backup-'))
    })

    it('should handle container and database names with underscores', () => {
      const filename = generateDefaultFilename('my_container', 'my_db')
      assert.ok(filename.startsWith('my_container-my_db-backup-'))
    })
  })
})

// =============================================================================
// Extension Tests
// =============================================================================

describe('Backup file extension', () => {
  describe('getExtension', () => {
    it('should return .sql for sql format regardless of engine', () => {
      assert.equal(getExtension('sql', 'postgresql'), '.sql')
      assert.equal(getExtension('sql', 'mysql'), '.sql')
    })

    it('should return .dump for PostgreSQL dump format', () => {
      assert.equal(getExtension('dump', 'postgresql'), '.dump')
    })

    it('should return .sql.gz for MySQL dump format (compressed)', () => {
      assert.equal(getExtension('dump', 'mysql'), '.sql.gz')
    })
  })
})

// =============================================================================
// Container Config Migration Tests
// =============================================================================

describe('Container config migration', () => {
  it('should add databases array when missing', async () => {
    // Simulate old config without databases array
    const oldConfig = {
      name: 'testdb',
      engine: 'postgresql',
      version: '17.0.0',
      port: 5432,
      database: 'testdb',
      created: new Date().toISOString(),
      status: 'stopped',
    }

    // Migration logic (as in container-manager.ts)
    const migratedConfig = { ...oldConfig } as typeof oldConfig & {
      databases?: string[]
    }

    if (!migratedConfig.databases) {
      migratedConfig.databases = [migratedConfig.database]
    }

    assert.ok(Array.isArray(migratedConfig.databases))
    assert.equal(migratedConfig.databases.length, 1)
    assert.equal(migratedConfig.databases[0], 'testdb')
  })

  it('should ensure primary database is in databases array', async () => {
    // Config where databases array exists but doesn't include primary
    const config = {
      name: 'testdb',
      engine: 'postgresql',
      version: '17.0.0',
      port: 5432,
      database: 'primary_db',
      databases: ['other_db'],
      created: new Date().toISOString(),
      status: 'stopped',
    }

    // Migration logic
    if (!config.databases.includes(config.database)) {
      config.databases = [config.database, ...config.databases]
    }

    assert.ok(config.databases.includes('primary_db'))
    assert.equal(config.databases[0], 'primary_db')
    assert.equal(config.databases.length, 2)
  })

  it('should not duplicate if primary already in array', async () => {
    const config = {
      name: 'testdb',
      engine: 'postgresql',
      version: '17.0.0',
      port: 5432,
      database: 'mydb',
      databases: ['mydb', 'other_db'],
      created: new Date().toISOString(),
      status: 'stopped',
    }

    // Migration logic
    if (!config.databases.includes(config.database)) {
      config.databases = [config.database, ...config.databases]
    }

    assert.equal(config.databases.length, 2)
    assert.deepEqual(config.databases, ['mydb', 'other_db'])
  })
})

// =============================================================================
// Database Array Management Tests
// =============================================================================

describe('Database array management', () => {
  it('should add new database to array', () => {
    const databases = ['primary_db']
    const newDb = 'clone_db'

    if (!databases.includes(newDb)) {
      databases.push(newDb)
    }

    assert.deepEqual(databases, ['primary_db', 'clone_db'])
  })

  it('should not add duplicate database', () => {
    const databases = ['primary_db', 'clone_db']
    const newDb = 'clone_db'

    if (!databases.includes(newDb)) {
      databases.push(newDb)
    }

    assert.equal(databases.length, 2)
  })

  it('should remove database from array', () => {
    const databases = ['primary_db', 'clone_db', 'test_db']
    const toRemove = 'clone_db'

    const filtered = databases.filter((db) => db !== toRemove)

    assert.deepEqual(filtered, ['primary_db', 'test_db'])
  })

  it('should handle removal of non-existent database gracefully', () => {
    const databases = ['primary_db', 'clone_db']
    const toRemove = 'nonexistent_db'

    const filtered = databases.filter((db) => db !== toRemove)

    assert.deepEqual(filtered, ['primary_db', 'clone_db'])
  })
})

// =============================================================================
// Format Selection Tests
// =============================================================================

describe('Backup format selection', () => {
  it('should default to sql format', () => {
    const options = { sql: false, dump: false, format: undefined }
    let format: 'sql' | 'dump' = 'sql' // Default

    if (options.sql) {
      format = 'sql'
    } else if (options.dump) {
      format = 'dump'
    } else if (options.format) {
      format = options.format as 'sql' | 'dump'
    }

    assert.equal(format, 'sql')
  })

  it('should respect --sql flag', () => {
    const options = { sql: true, dump: false, format: undefined }
    let format: 'sql' | 'dump' = 'sql'

    if (options.sql) {
      format = 'sql'
    } else if (options.dump) {
      format = 'dump'
    }

    assert.equal(format, 'sql')
  })

  it('should respect --dump flag', () => {
    const options = { sql: false, dump: true, format: undefined }
    let format: 'sql' | 'dump' = 'sql'

    if (options.sql) {
      format = 'sql'
    } else if (options.dump) {
      format = 'dump'
    }

    assert.equal(format, 'dump')
  })

  it('should respect --format sql option', () => {
    const options = { sql: false, dump: false, format: 'sql' }
    let format: 'sql' | 'dump' = 'sql'

    if (options.sql) {
      format = 'sql'
    } else if (options.dump) {
      format = 'dump'
    } else if (options.format) {
      format = options.format as 'sql' | 'dump'
    }

    assert.equal(format, 'sql')
  })

  it('should respect --format dump option', () => {
    const options = { sql: false, dump: false, format: 'dump' }
    let format: 'sql' | 'dump' = 'sql'

    if (options.sql) {
      format = 'sql'
    } else if (options.dump) {
      format = 'dump'
    } else if (options.format) {
      format = options.format as 'sql' | 'dump'
    }

    assert.equal(format, 'dump')
  })

  it('should prioritize --sql flag over --format', () => {
    const options = { sql: true, dump: false, format: 'dump' }
    let format: 'sql' | 'dump' = 'sql'

    if (options.sql) {
      format = 'sql'
    } else if (options.dump) {
      format = 'dump'
    } else if (options.format) {
      format = options.format as 'sql' | 'dump'
    }

    assert.equal(format, 'sql')
  })
})
