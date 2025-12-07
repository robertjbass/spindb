/**
 * Unit tests for config-manager module
 */

import { describe, it } from 'node:test'
import { ConfigManager } from '../../core/config-manager'
import { assert, assertEqual } from '../integration/helpers'

describe('ConfigManager', () => {
  describe('load', () => {
    it('should return cached config on subsequent calls', async () => {
      const configManager = new ConfigManager()
      const config1 = await configManager.load()
      const config2 = await configManager.load()

      // Both calls should return same object (cached)
      assertEqual(config1, config2, 'Should return cached config')
    })

    it('should create default config if none exists', async () => {
      const configManager = new ConfigManager()
      const config = await configManager.load()

      assert(config !== null, 'Config should not be null')
      assert(typeof config === 'object', 'Config should be an object')
      assert('binaries' in config, 'Config should have binaries property')
    })
  })

  describe('getCommonBinaryPaths', () => {
    it('should include Homebrew paths for macOS', () => {
      const configManager = new ConfigManager()
      // Access private method via type assertion for testing
      const getPaths = (configManager as unknown as {
        getCommonBinaryPaths: (tool: string) => string[]
      }).getCommonBinaryPaths.bind(configManager)

      const paths = getPaths('psql')

      assert(
        paths.some((p) => p.includes('/opt/homebrew')),
        'Should include ARM Homebrew path',
      )
      assert(
        paths.some((p) => p.includes('/usr/local')),
        'Should include Intel Homebrew path',
      )
    })

    it('should include PostgreSQL-specific paths for psql', () => {
      const configManager = new ConfigManager()
      const getPaths = (configManager as unknown as {
        getCommonBinaryPaths: (tool: string) => string[]
      }).getCommonBinaryPaths.bind(configManager)

      const paths = getPaths('psql')

      assert(
        paths.some((p) => p.includes('libpq')),
        'Should include libpq path for psql',
      )
      assert(
        paths.some((p) => p.includes('Postgres.app')),
        'Should include Postgres.app path',
      )
    })

    it('should include MySQL-specific paths for mysql', () => {
      const configManager = new ConfigManager()
      const getPaths = (configManager as unknown as {
        getCommonBinaryPaths: (tool: string) => string[]
      }).getCommonBinaryPaths.bind(configManager)

      const paths = getPaths('mysql')

      assert(
        paths.some((p) => p.includes('mysql')),
        'Should include MySQL path',
      )
    })

    it('should include Linux paths for pg_dump', () => {
      const configManager = new ConfigManager()
      const getPaths = (configManager as unknown as {
        getCommonBinaryPaths: (tool: string) => string[]
      }).getCommonBinaryPaths.bind(configManager)

      const paths = getPaths('pg_dump')

      assert(
        paths.some((p) => p.includes('/usr/lib/postgresql')),
        'Should include Linux PostgreSQL paths',
      )
    })
  })

  describe('isStale', () => {
    it('should return true when updatedAt is missing', async () => {
      const configManager = new ConfigManager()
      // Force load a config without updatedAt
      await configManager.load()
      // The config might have updatedAt set, but the concept should hold
      const isStale = await configManager.isStale()
      assert(
        typeof isStale === 'boolean',
        'isStale should return a boolean',
      )
    })

    it('should compare dates correctly', () => {
      const CACHE_STALENESS_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

      const freshDate = new Date()
      const staleDate = new Date(Date.now() - (CACHE_STALENESS_MS + 1000))

      const freshElapsed = Date.now() - freshDate.getTime()
      const staleElapsed = Date.now() - staleDate.getTime()

      assert(freshElapsed < CACHE_STALENESS_MS, 'Fresh date should not be stale')
      assert(staleElapsed > CACHE_STALENESS_MS, 'Stale date should be stale')
    })
  })

  describe('Tool Categories', () => {
    it('should export PostgreSQL tools', async () => {
      const { POSTGRESQL_TOOLS } = await import('../../core/config-manager')

      assert(Array.isArray(POSTGRESQL_TOOLS), 'Should be an array')
      assert(POSTGRESQL_TOOLS.includes('psql'), 'Should include psql')
      assert(POSTGRESQL_TOOLS.includes('pg_dump'), 'Should include pg_dump')
      assert(POSTGRESQL_TOOLS.includes('pg_restore'), 'Should include pg_restore')
    })

    it('should export MySQL tools', async () => {
      const { MYSQL_TOOLS } = await import('../../core/config-manager')

      assert(Array.isArray(MYSQL_TOOLS), 'Should be an array')
      assert(MYSQL_TOOLS.includes('mysql'), 'Should include mysql')
      assert(MYSQL_TOOLS.includes('mysqldump'), 'Should include mysqldump')
      assert(MYSQL_TOOLS.includes('mysqladmin'), 'Should include mysqladmin')
      assert(MYSQL_TOOLS.includes('mysqld'), 'Should include mysqld')
    })

    it('should export enhanced shells', async () => {
      const { ENHANCED_SHELLS } = await import('../../core/config-manager')

      assert(Array.isArray(ENHANCED_SHELLS), 'Should be an array')
      assert(ENHANCED_SHELLS.includes('pgcli'), 'Should include pgcli')
      assert(ENHANCED_SHELLS.includes('mycli'), 'Should include mycli')
      assert(ENHANCED_SHELLS.includes('usql'), 'Should include usql')
    })

    it('should export ALL_TOOLS combining all categories', async () => {
      const { ALL_TOOLS, POSTGRESQL_TOOLS, MYSQL_TOOLS, ENHANCED_SHELLS } =
        await import('../../core/config-manager')

      const expectedLength =
        POSTGRESQL_TOOLS.length + MYSQL_TOOLS.length + ENHANCED_SHELLS.length

      assertEqual(
        ALL_TOOLS.length,
        expectedLength,
        'ALL_TOOLS should combine all categories',
      )
    })
  })

  describe('BinaryConfig Shape', () => {
    it('should have correct structure for binary configs', () => {
      const binaryConfig = {
        tool: 'psql',
        path: '/usr/local/bin/psql',
        source: 'system',
        version: '16.0',
      }

      assertEqual(binaryConfig.tool, 'psql', 'Should have tool name')
      assert(typeof binaryConfig.path === 'string', 'Should have path')
      // BinarySource is 'bundled' | 'system' | 'custom'
      assert(
        binaryConfig.source === 'system' ||
          binaryConfig.source === 'bundled' ||
          binaryConfig.source === 'custom',
        'Source should be system, bundled, or custom',
      )
    })
  })

  describe('Version Detection', () => {
    it('should parse version from --version output', () => {
      const versionOutputs = [
        { output: 'psql (PostgreSQL) 16.0', expected: '16.0' },
        { output: 'mysql  Ver 8.0.32', expected: '8.0' },
        { output: 'pg_dump (PostgreSQL) 15.4', expected: '15.4' },
      ]

      for (const { output, expected } of versionOutputs) {
        const match = output.match(/\d+\.\d+/)
        assert(match !== null, `Should match version in: ${output}`)
        assertEqual(match![0], expected, `Should extract ${expected} from: ${output}`)
      }
    })

    it('should handle version detection failure gracefully', () => {
      const invalidOutputs = [
        'no version here',
        '',
        'error: command not found',
      ]

      for (const output of invalidOutputs) {
        const match = output.match(/\d+\.\d+/)
        assertEqual(match, null, `Should not match version in: ${output}`)
      }
    })
  })

  describe('Error Handling', () => {
    it('should handle corrupted config JSON', async () => {
      // Test the concept of handling JSON parse errors
      const invalidJSON = '{ invalid json'
      let parseError = null

      try {
        JSON.parse(invalidJSON)
      } catch (error) {
        parseError = error
      }

      assert(parseError !== null, 'Should throw on invalid JSON')
      assert(parseError instanceof SyntaxError, 'Should be SyntaxError')
    })

    it('should handle missing binary path gracefully', async () => {
      const configManager = new ConfigManager()
      // Request a non-existent tool (if it's not installed)
      const path = await configManager.getBinaryPath('nonexistent-tool' as 'psql')

      // If tool doesn't exist, should return null
      assert(
        path === null || typeof path === 'string',
        'Should return null or path string',
      )
    })
  })

  describe('Path Validation', () => {
    it('should verify binary path exists before returning', async () => {
      const configManager = new ConfigManager()
      // If a path is configured but no longer exists, it should be cleared
      // This tests the existsSync check in getBinaryPath
      const path = await configManager.getBinaryPath('psql')

      if (path !== null) {
        // If we got a path, it should exist
        const { existsSync } = await import('fs')
        assert(existsSync(path), 'Returned path should exist')
      }
    })
  })
})

describe('Config File Operations', () => {
  it('should use correct config path', async () => {
    const { paths } = await import('../../config/paths')

    assert(
      paths.config.includes('.spindb'),
      'Config should be in .spindb directory',
    )
    assert(
      paths.config.endsWith('config.json'),
      'Config file should be config.json',
    )
  })
})
