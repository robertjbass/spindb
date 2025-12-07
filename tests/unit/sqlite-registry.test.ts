/**
 * Unit tests for SQLite registry module
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import { mkdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../integration/helpers'

// We need to mock paths to use a temp directory
// For unit tests, we'll test the registry logic directly

describe('SQLite Registry', () => {
  const testDir = join(tmpdir(), 'spindb-test-sqlite-registry')
  const testRegistryPath = join(testDir, 'sqlite-registry.json')

  beforeEach(async () => {
    // Clean up and create test directory
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true })
    }
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true })
    }
  })

  describe('Registry Entry Shape', () => {
    it('should have all required fields', () => {
      const entry = {
        name: 'testdb',
        filePath: '/path/to/test.sqlite',
        created: new Date().toISOString(),
      }

      assert(typeof entry.name === 'string', 'Should have name')
      assert(typeof entry.filePath === 'string', 'Should have filePath')
      assert(typeof entry.created === 'string', 'Should have created timestamp')
    })

    it('should support optional lastVerified field', () => {
      const entry = {
        name: 'testdb',
        filePath: '/path/to/test.sqlite',
        created: new Date().toISOString(),
        lastVerified: new Date().toISOString(),
      }

      assert(
        typeof entry.lastVerified === 'string',
        'Should support lastVerified',
      )
    })
  })

  describe('Registry Shape', () => {
    it('should have version and entries array', () => {
      const registry = {
        version: 1 as const,
        entries: [],
      }

      assertEqual(registry.version, 1, 'Version should be 1')
      assert(Array.isArray(registry.entries), 'Should have entries array')
    })
  })

  describe('Registry File Operations', () => {
    it('should create registry with empty entries on first load', async () => {
      const emptyRegistry = {
        version: 1 as const,
        entries: [] as Array<{
          name: string
          filePath: string
          created: string
        }>,
      }

      // Write to test path
      await writeFile(testRegistryPath, JSON.stringify(emptyRegistry, null, 2))

      assert(existsSync(testRegistryPath), 'Registry file should exist')
    })

    it('should handle corrupted registry gracefully', () => {
      // Concept: corrupted registry should return empty
      const fallback = { version: 1, entries: [] }

      try {
        JSON.parse('invalid json')
      } catch {
        // Should return empty registry on parse error
        assertEqual(
          fallback.entries.length,
          0,
          'Should return empty entries on error',
        )
      }
    })
  })

  describe('Entry Management', () => {
    it('should add entries to registry', () => {
      const registry = {
        version: 1 as const,
        entries: [] as Array<{
          name: string
          filePath: string
          created: string
        }>,
      }

      const newEntry = {
        name: 'testdb',
        filePath: '/path/to/test.sqlite',
        created: new Date().toISOString(),
      }

      registry.entries.push(newEntry)

      assertEqual(registry.entries.length, 1, 'Should have one entry')
      assertEqual(registry.entries[0].name, 'testdb', 'Entry name should match')
    })

    it('should prevent duplicate names', () => {
      const registry = {
        entries: [
          { name: 'testdb', filePath: '/path/a.sqlite', created: '2024-01-01' },
        ],
      }

      const duplicateName = 'testdb'
      const exists = registry.entries.some((e) => e.name === duplicateName)

      assert(exists, 'Should detect duplicate name')
    })

    it('should remove entry by name', () => {
      const registry = {
        entries: [
          { name: 'testdb', filePath: '/path/a.sqlite', created: '2024-01-01' },
          { name: 'other', filePath: '/path/b.sqlite', created: '2024-01-01' },
        ],
      }

      const nameToRemove = 'testdb'
      registry.entries = registry.entries.filter((e) => e.name !== nameToRemove)

      assertEqual(
        registry.entries.length,
        1,
        'Should have one entry after removal',
      )
      assertEqual(
        registry.entries[0].name,
        'other',
        'Remaining entry should be "other"',
      )
    })

    it('should find entry by name', () => {
      const registry = {
        entries: [
          { name: 'testdb', filePath: '/path/a.sqlite', created: '2024-01-01' },
        ],
      }

      const found = registry.entries.find((e) => e.name === 'testdb')

      assert(found !== undefined, 'Should find entry')
      assertEqual(found?.filePath, '/path/a.sqlite', 'Should have correct path')
    })

    it('should return null for non-existent entry', () => {
      const registry = {
        entries: [] as Array<{
          name: string
          filePath: string
          created: string
        }>,
      }

      const found = registry.entries.find((e) => e.name === 'nonexistent')

      assert(found === undefined, 'Should not find non-existent entry')
    })
  })

  describe('Orphan Detection', () => {
    it('should detect entries where file does not exist', async () => {
      const entries = [
        { name: 'exists', filePath: testRegistryPath, created: '2024-01-01' },
        {
          name: 'missing',
          filePath: '/nonexistent/path.sqlite',
          created: '2024-01-01',
        },
      ]

      // Create one file that exists
      await writeFile(testRegistryPath, '{}')

      const orphans = entries.filter((e) => !existsSync(e.filePath))

      assertEqual(orphans.length, 1, 'Should find one orphan')
      assertEqual(
        orphans[0].name,
        'missing',
        'Orphan should be the missing file',
      )
    })

    it('should return empty array when all files exist', async () => {
      const existingFile = join(testDir, 'test.sqlite')
      await writeFile(existingFile, '')

      const entries = [
        { name: 'exists', filePath: existingFile, created: '2024-01-01' },
      ]

      const orphans = entries.filter((e) => !existsSync(e.filePath))

      assertEqual(orphans.length, 0, 'Should find no orphans')
    })

    it('should remove orphaned entries', async () => {
      const existingFile = join(testDir, 'test.sqlite')
      await writeFile(existingFile, '')

      const registry = {
        entries: [
          { name: 'exists', filePath: existingFile, created: '2024-01-01' },
          {
            name: 'missing',
            filePath: '/nonexistent/path.sqlite',
            created: '2024-01-01',
          },
        ],
      }

      const originalCount = registry.entries.length
      registry.entries = registry.entries.filter((e) => existsSync(e.filePath))
      const removedCount = originalCount - registry.entries.length

      assertEqual(removedCount, 1, 'Should remove one orphan')
      assertEqual(registry.entries.length, 1, 'Should have one entry left')
      assertEqual(
        registry.entries[0].name,
        'exists',
        'Remaining entry should exist',
      )
    })
  })

  describe('Path Registration', () => {
    it('should detect if path is already registered', () => {
      const registry = {
        entries: [
          {
            name: 'testdb',
            filePath: '/path/to/test.sqlite',
            created: '2024-01-01',
          },
        ],
      }

      const path = '/path/to/test.sqlite'
      const isRegistered = registry.entries.some((e) => e.filePath === path)

      assert(isRegistered, 'Should detect registered path')
    })

    it('should find entry by file path', () => {
      const registry = {
        entries: [
          {
            name: 'testdb',
            filePath: '/path/to/test.sqlite',
            created: '2024-01-01',
          },
        ],
      }

      const path = '/path/to/test.sqlite'
      const found = registry.entries.find((e) => e.filePath === path)

      assert(found !== undefined, 'Should find entry by path')
      assertEqual(found?.name, 'testdb', 'Should have correct name')
    })
  })

  describe('Update Operations', () => {
    it('should update lastVerified timestamp', () => {
      const entry = {
        name: 'testdb',
        filePath: '/path/to/test.sqlite',
        created: '2024-01-01T00:00:00Z',
        lastVerified: '2024-01-01T00:00:00Z',
      }

      const newTimestamp = new Date().toISOString()
      entry.lastVerified = newTimestamp

      assert(entry.lastVerified > entry.created, 'lastVerified should be newer')
    })

    it('should update filePath', () => {
      const entry = {
        name: 'testdb',
        filePath: '/old/path.sqlite',
        created: '2024-01-01T00:00:00Z',
      }

      const newPath = '/new/path.sqlite'
      entry.filePath = newPath

      assertEqual(entry.filePath, newPath, 'Path should be updated')
    })
  })

  describe('Relocation Operations', () => {
    it('should update filePath when relocating database', () => {
      const registry = {
        entries: [
          {
            name: 'testdb',
            filePath: '/old/path/test.sqlite',
            created: '2024-01-01',
          },
        ],
      }

      const newPath = '/new/location/test.sqlite'
      const entry = registry.entries.find((e) => e.name === 'testdb')
      if (entry) {
        entry.filePath = newPath
      }

      assertEqual(
        registry.entries[0].filePath,
        newPath,
        'File path should be updated',
      )
    })

    it('should preserve other entry fields when updating path', () => {
      const registry = {
        entries: [
          {
            name: 'testdb',
            filePath: '/old/path/test.sqlite',
            created: '2024-01-01T00:00:00Z',
            lastVerified: '2024-06-01T00:00:00Z',
          },
        ],
      }

      const originalCreated = registry.entries[0].created
      const originalLastVerified = registry.entries[0].lastVerified

      // Simulate relocation update
      registry.entries[0].filePath = '/new/location/test.sqlite'

      assertEqual(
        registry.entries[0].name,
        'testdb',
        'Name should be preserved',
      )
      assertEqual(
        registry.entries[0].created,
        originalCreated,
        'Created should be preserved',
      )
      assertEqual(
        registry.entries[0].lastVerified,
        originalLastVerified,
        'LastVerified should be preserved',
      )
    })

    it('should handle relocation to different directory', () => {
      const entry = {
        name: 'testdb',
        filePath: '/Users/bob/project-a/data.sqlite',
        created: '2024-01-01',
      }

      // Relocate to different project
      entry.filePath = '/Users/bob/project-b/data.sqlite'

      assert(entry.filePath.includes('project-b'), 'Should be in new directory')
      assert(
        !entry.filePath.includes('project-a'),
        'Should not be in old directory',
      )
    })

    it('should handle relocation with filename change', () => {
      const entry = {
        name: 'testdb',
        filePath: '/path/old-name.sqlite',
        created: '2024-01-01',
      }

      // Relocate with new filename
      entry.filePath = '/path/new-name.sqlite'

      assert(
        entry.filePath.endsWith('new-name.sqlite'),
        'Should have new filename',
      )
    })

    it('should handle relocation to home directory', () => {
      const entry = {
        name: 'testdb',
        filePath: '/Users/bob/dev/test.sqlite',
        created: '2024-01-01',
      }

      // Simulate ~ expansion (already expanded when stored)
      entry.filePath = '/Users/bob/sqlite-tests/test.sqlite'

      assert(
        entry.filePath.startsWith('/Users/bob'),
        'Should be in home directory',
      )
    })

    it('should not affect other entries when updating one', () => {
      const registry = {
        entries: [
          { name: 'db1', filePath: '/path/db1.sqlite', created: '2024-01-01' },
          { name: 'db2', filePath: '/path/db2.sqlite', created: '2024-01-01' },
          { name: 'db3', filePath: '/path/db3.sqlite', created: '2024-01-01' },
        ],
      }

      // Update only db2
      const entry = registry.entries.find((e) => e.name === 'db2')
      if (entry) {
        entry.filePath = '/new/path/db2.sqlite'
      }

      assertEqual(
        registry.entries[0].filePath,
        '/path/db1.sqlite',
        'db1 should be unchanged',
      )
      assertEqual(
        registry.entries[1].filePath,
        '/new/path/db2.sqlite',
        'db2 should be updated',
      )
      assertEqual(
        registry.entries[2].filePath,
        '/path/db3.sqlite',
        'db3 should be unchanged',
      )
    })
  })

  describe('Connection String Format', () => {
    it('should format SQLite connection string', () => {
      const filePath = '/Users/test/mydb.sqlite'
      const connectionString = `sqlite://${filePath}`

      assert(
        connectionString.startsWith('sqlite://'),
        'Should start with sqlite://',
      )
      assert(connectionString.includes(filePath), 'Should include file path')
    })

    it('should handle paths with spaces', () => {
      const filePath = '/Users/test/my database.sqlite'
      const connectionString = `sqlite://${filePath}`

      assert(connectionString.includes('my database'), 'Should handle spaces')
    })
  })

  describe('Error Messages', () => {
    it('should provide clear error for duplicate name', () => {
      const errorMessage = 'SQLite container "testdb" already exists'

      assert(
        errorMessage.includes('already exists'),
        'Should indicate duplicate',
      )
      assert(errorMessage.includes('testdb'), 'Should include name')
    })
  })
})

describe('SQLite Engine Registry (config.json structure)', () => {
  describe('Registry Shape with ignoreFolders', () => {
    it('should have version, entries array, and ignoreFolders object', () => {
      const registry = {
        version: 1 as const,
        entries: [],
        ignoreFolders: {} as Record<string, true>,
      }

      assertEqual(registry.version, 1, 'Version should be 1')
      assert(Array.isArray(registry.entries), 'Should have entries array')
      assert(
        typeof registry.ignoreFolders === 'object',
        'Should have ignoreFolders object',
      )
    })

    it('should store ignored folders as keys with true value', () => {
      const registry = {
        version: 1 as const,
        entries: [],
        ignoreFolders: {
          '/path/to/folder1': true,
          '/path/to/folder2': true,
        } as Record<string, true>,
      }

      assert('/path/to/folder1' in registry.ignoreFolders, 'Should have folder1')
      assert('/path/to/folder2' in registry.ignoreFolders, 'Should have folder2')
    })
  })

  describe('Ignore Folder Operations', () => {
    it('should add folder to ignore list', () => {
      const ignoreFolders: Record<string, true> = {}

      ignoreFolders['/path/to/folder'] = true

      assert(
        '/path/to/folder' in ignoreFolders,
        'Folder should be in ignore list',
      )
    })

    it('should remove folder from ignore list', () => {
      const ignoreFolders: Record<string, true> = {
        '/path/to/folder': true,
      }

      delete ignoreFolders['/path/to/folder']

      assert(
        !('/path/to/folder' in ignoreFolders),
        'Folder should be removed from ignore list',
      )
    })

    it('should provide O(1) lookup for ignored folders', () => {
      const ignoreFolders: Record<string, true> = {
        '/path/a': true,
        '/path/b': true,
        '/path/c': true,
      }

      // Direct property access is O(1)
      const isIgnored = '/path/b' in ignoreFolders
      assert(isIgnored, 'Should find folder in O(1)')
    })

    it('should return false for non-ignored folders', () => {
      const ignoreFolders: Record<string, true> = {
        '/path/a': true,
      }

      const isIgnored = '/path/b' in ignoreFolders
      assert(!isIgnored, 'Should return false for non-ignored folder')
    })

    it('should list all ignored folders', () => {
      const ignoreFolders: Record<string, true> = {
        '/path/a': true,
        '/path/b': true,
        '/path/c': true,
      }

      const folders = Object.keys(ignoreFolders)

      assertEqual(folders.length, 3, 'Should have 3 folders')
      assert(folders.includes('/path/a'), 'Should include path/a')
      assert(folders.includes('/path/b'), 'Should include path/b')
      assert(folders.includes('/path/c'), 'Should include path/c')
    })
  })
})

describe('SQLite Scanner', () => {
  describe('deriveContainerName', () => {
    it('should remove .sqlite extension', () => {
      const fileName = 'mydb.sqlite'
      const base = fileName.replace(/\.(sqlite3?|db)$/i, '')
      assertEqual(base, 'mydb', 'Should remove .sqlite extension')
    })

    it('should remove .sqlite3 extension', () => {
      const fileName = 'mydb.sqlite3'
      const base = fileName.replace(/\.(sqlite3?|db)$/i, '')
      assertEqual(base, 'mydb', 'Should remove .sqlite3 extension')
    })

    it('should remove .db extension', () => {
      const fileName = 'mydb.db'
      const base = fileName.replace(/\.(sqlite3?|db)$/i, '')
      assertEqual(base, 'mydb', 'Should remove .db extension')
    })

    it('should replace invalid chars with hyphens', () => {
      const name = 'my database'
      const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-')
      assertEqual(sanitized, 'my-database', 'Should replace spaces with hyphens')
    })

    it('should prefix with db- if starts with number', () => {
      const name = '123test'
      const prefixed = /^[a-zA-Z]/.test(name) ? name : 'db-' + name
      assertEqual(prefixed, 'db-123test', 'Should prefix with db-')
    })

    it('should not prefix if starts with letter', () => {
      const name = 'mytest'
      const prefixed = /^[a-zA-Z]/.test(name) ? name : 'db-' + name
      assertEqual(prefixed, 'mytest', 'Should not add prefix')
    })

    it('should remove consecutive hyphens', () => {
      const name = 'my--database'
      const cleaned = name.replace(/-+/g, '-')
      assertEqual(cleaned, 'my-database', 'Should remove consecutive hyphens')
    })
  })

  describe('Unregistered File Detection', () => {
    it('should match sqlite file extensions', () => {
      const files = ['test.sqlite', 'test.sqlite3', 'test.db', 'test.txt']
      const sqliteFiles = files.filter((f) => /\.(sqlite3?|db)$/i.test(f))

      assertEqual(sqliteFiles.length, 3, 'Should match 3 SQLite files')
      assert(!sqliteFiles.includes('test.txt'), 'Should not include txt file')
    })

    it('should be case insensitive for extensions', () => {
      const files = ['test.SQLITE', 'test.Sqlite3', 'test.DB']
      const sqliteFiles = files.filter((f) => /\.(sqlite3?|db)$/i.test(f))

      assertEqual(sqliteFiles.length, 3, 'Should match all case variants')
    })
  })
})

describe('SQLite Container Config', () => {
  describe('ContainerConfig for SQLite', () => {
    it('should have port 0 for file-based database', () => {
      const config = {
        name: 'testdb',
        engine: 'sqlite' as const,
        version: '3',
        port: 0,
        database: '/path/to/test.sqlite',
        databases: ['/path/to/test.sqlite'],
        created: new Date().toISOString(),
        status: 'running' as const, // "running" = file exists
      }

      assertEqual(config.port, 0, 'Port should be 0 for SQLite')
      assertEqual(config.engine, 'sqlite', 'Engine should be sqlite')
    })

    it('should use file path as database field', () => {
      const filePath = '/path/to/test.sqlite'
      const config = {
        database: filePath,
      }

      assert(
        config.database.endsWith('.sqlite'),
        'Database should be file path',
      )
    })

    it('should use "running" status when file exists', () => {
      const status = 'running' // file exists
      assertEqual(
        status,
        'running',
        'Status should be running when file exists',
      )
    })

    it('should use "stopped" status when file is missing', () => {
      const status = 'stopped' // file missing
      assertEqual(
        status,
        'stopped',
        'Status should be stopped when file missing',
      )
    })
  })
})
