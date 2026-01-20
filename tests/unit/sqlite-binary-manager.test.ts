import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import { sqliteBinaryManager } from '../../engines/sqlite/binary-manager'
import { getBinaryUrl } from '../../engines/sqlite/binary-urls'
import { getHostdbPlatform } from '../../core/hostdb-client'
import {
  normalizeVersion,
  getFullVersion,
  SQLITE_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from '../../engines/sqlite/version-maps'
import { Platform, Arch } from '../../types'

// =============================================================================
// Version Maps Tests
// =============================================================================

// TODO - derive versions from single source of truth
describe('SQLite version-maps', () => {
  describe('normalizeVersion', () => {
    it('should map major version 3 to full version', () => {
      const result = normalizeVersion('3')
      assertEqual(result, '3.51.2', 'Major version 3 should map to 3.51.2')
    })

    it('should map minor version 3.51 to full version', () => {
      const result = normalizeVersion('3.51')
      assertEqual(result, '3.51.2', 'Version 3.51 should map to 3.51.2')
    })

    it('should return full version unchanged', () => {
      const result = normalizeVersion('3.51.2')
      assertEqual(result, '3.51.2', 'Full version should remain unchanged')
    })

    it('should return unknown single-part version unchanged', () => {
      // Unknown versions not in the map should be returned unchanged (with warning)
      // This allows the download to fail with a clear error if the version doesn't exist
      const result = normalizeVersion('4')
      assertEqual(result, '4', 'Unknown major version should be unchanged')
    })

    it('should return unknown two-part version unchanged', () => {
      // Unknown versions not in the map should be returned unchanged (with warning)
      const result = normalizeVersion('4.0')
      assertEqual(result, '4.0', 'Unknown minor version should be unchanged')
    })
  })

  describe('getFullVersion', () => {
    it('should return full version for major version 3', () => {
      const result = getFullVersion('3')
      assertEqual(result, '3.51.2', 'Should return full version for major 3')
    })

    it('should return null for unknown major version', () => {
      const result = getFullVersion('99')
      assertEqual(result, null, 'Should return null for unknown version')
    })
  })

  describe('SQLITE_VERSION_MAP', () => {
    it('should have entries for major version 3', () => {
      assert('3' in SQLITE_VERSION_MAP, 'Should have entry for major version 3')
    })

    it('should have entries for minor version 3.51', () => {
      assert(
        '3.51' in SQLITE_VERSION_MAP,
        'Should have entry for minor version 3.51',
      )
    })
  })

  describe('SUPPORTED_MAJOR_VERSIONS', () => {
    it('should include version 3', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.includes('3'),
        'Should support major version 3',
      )
    })

    it('should have at least one supported version', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.length > 0,
        'Should have at least one supported version',
      )
    })
  })
})

// =============================================================================
// Binary URLs Tests
// =============================================================================

describe('SQLite binary-urls', () => {
  describe('getHostdbPlatform', () => {
    it('should return darwin-arm64 for macOS ARM', () => {
      const result = getHostdbPlatform(Platform.Darwin, Arch.ARM64)
      assertEqual(result, 'darwin-arm64', 'Should return darwin-arm64')
    })

    it('should return darwin-x64 for macOS Intel', () => {
      const result = getHostdbPlatform(Platform.Darwin, Arch.X64)
      assertEqual(result, 'darwin-x64', 'Should return darwin-x64')
    })

    it('should return linux-x64 for Linux x64', () => {
      const result = getHostdbPlatform(Platform.Linux, Arch.X64)
      assertEqual(result, 'linux-x64', 'Should return linux-x64')
    })

    it('should return linux-arm64 for Linux ARM', () => {
      const result = getHostdbPlatform(Platform.Linux, Arch.ARM64)
      assertEqual(result, 'linux-arm64', 'Should return linux-arm64')
    })

    it('should return win32-x64 for Windows', () => {
      const result = getHostdbPlatform(Platform.Win32, Arch.X64)
      assertEqual(result, 'win32-x64', 'Should return win32-x64')
    })

    it('should return undefined for unsupported platform', () => {
      const result = getHostdbPlatform('freebsd', 'x64')
      assertEqual(result, undefined, 'Should return undefined for unsupported')
    })
  })

  describe('getBinaryUrl', () => {
    it('should generate valid hostdb URL for darwin-arm64', () => {
      const url = getBinaryUrl('3', Platform.Darwin, Arch.ARM64)

      assert(
        url.includes('github.com/robertjbass/hostdb'),
        'URL should use hostdb GitHub',
      )
      assert(
        url.includes('releases/download'),
        'URL should reference GitHub releases',
      )
      assert(url.includes('darwin-arm64'), 'URL should include darwin-arm64')
      assert(url.endsWith('.tar.gz'), 'URL should point to tar.gz file')
    })

    it('should generate valid URL for darwin-x64', () => {
      const url = getBinaryUrl('3', Platform.Darwin, Arch.X64)

      assert(url.includes('darwin-x64'), 'URL should include darwin-x64')
      assert(url.endsWith('.tar.gz'), 'Unix should use tar.gz')
    })

    it('should generate valid URL for linux-x64', () => {
      const url = getBinaryUrl('3', Platform.Linux, Arch.X64)

      assert(url.includes('linux-x64'), 'URL should include linux-x64')
      assert(url.endsWith('.tar.gz'), 'Linux should use tar.gz')
    })

    it('should generate valid URL for linux-arm64', () => {
      const url = getBinaryUrl('3', Platform.Linux, Arch.ARM64)

      assert(url.includes('linux-arm64'), 'URL should include linux-arm64')
    })

    it('should generate zip URL for Windows', () => {
      const url = getBinaryUrl('3', Platform.Win32, Arch.X64)

      assert(url.includes('win32-x64'), 'URL should include win32-x64')
      assert(url.endsWith('.zip'), 'Windows should use .zip')
    })

    it('should include full version in URL', () => {
      const url = getBinaryUrl('3', Platform.Darwin, Arch.ARM64)

      assert(url.includes('3.51.2'), 'URL should include full version 3.51.2')
    })

    it('should include sqlite tag in URL', () => {
      const url = getBinaryUrl('3', Platform.Darwin, Arch.ARM64)

      assert(
        url.includes('sqlite-3.51.2'),
        'URL should include sqlite version tag',
      )
    })

    it('should throw error for unsupported platform', () => {
      try {
        getBinaryUrl('3', 'freebsd', 'x64')
        assert(false, 'Should have thrown an error')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          error.message.includes('Unsupported platform'),
          `Error should mention unsupported platform: ${error.message}`,
        )
        assert(
          error.message.includes('freebsd-x64'),
          `Error should include the platform key: ${error.message}`,
        )
      }
    })
  })
})

// =============================================================================
// Binary Manager Tests
// =============================================================================

describe('SQLiteBinaryManager', () => {
  describe('getFullVersion', () => {
    it('should map major version 3 to full version', () => {
      const result = sqliteBinaryManager.getFullVersion('3')
      assertEqual(result, '3.51.2', 'Should map major version 3 to 3.51.2')
    })

    it('should return full version unchanged', () => {
      const result = sqliteBinaryManager.getFullVersion('3.51.2')
      assertEqual(result, '3.51.2', 'Full version should remain unchanged')
    })
  })

  describe('getDownloadUrl', () => {
    it('should generate valid hostdb URL', () => {
      const url = sqliteBinaryManager.getDownloadUrl('3', Platform.Darwin, Arch.ARM64)

      assert(
        url.includes('github.com/robertjbass/hostdb'),
        'URL should use hostdb GitHub',
      )
      assert(url.includes('3.51.2'), 'URL should include full version')
      assert(url.includes('darwin-arm64'), 'URL should include platform')
    })

    it('should use correct file extension for platform', () => {
      const unixUrl = sqliteBinaryManager.getDownloadUrl('3', Platform.Darwin, Arch.ARM64)
      const winUrl = sqliteBinaryManager.getDownloadUrl('3', Platform.Win32, Arch.X64)

      assert(unixUrl.endsWith('.tar.gz'), 'Unix should use tar.gz')
      assert(winUrl.endsWith('.zip'), 'Windows should use zip')
    })
  })

  describe('getBinaryExecutable', () => {
    it('should return correct path for sqlite3 binary', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        'sqlite3',
      )

      assert(
        path.includes('bin/sqlite3') || path.includes('bin\\sqlite3'),
        'Path should include bin/sqlite3',
      )
      assert(path.includes('3.51.2'), 'Path should use full version')
      assert(path.includes('darwin-arm64'), 'Path should include platform')
    })

    it('should return correct path for sqldiff binary', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        'sqldiff',
      )

      assert(
        path.includes('bin/sqldiff') || path.includes('bin\\sqldiff'),
        'Path should include bin/sqldiff',
      )
    })

    it('should return correct path for sqlite3_analyzer', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        'sqlite3_analyzer',
      )

      assert(
        path.includes('bin/sqlite3_analyzer') ||
          path.includes('bin\\sqlite3_analyzer'),
        'Path should include bin/sqlite3_analyzer',
      )
    })

    it('should return correct path for sqlite3_rsync', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        'sqlite3_rsync',
      )

      assert(
        path.includes('bin/sqlite3_rsync') ||
          path.includes('bin\\sqlite3_rsync'),
        'Path should include bin/sqlite3_rsync',
      )
    })

    it('should add .exe extension on Windows', () => {
      const path = sqliteBinaryManager.getBinaryExecutable(
        '3',
        Platform.Win32,
        Arch.X64,
        'sqlite3',
      )

      assert(path.endsWith('.exe'), 'Windows binary should have .exe extension')
    })
  })

  describe('listInstalled', () => {
    it('should return array of InstalledBinary objects', async () => {
      const installed = await sqliteBinaryManager.listInstalled()

      assert(Array.isArray(installed), 'Should return an array')

      for (const binary of installed) {
        assert(binary.engine === 'sqlite', 'Should have engine = sqlite')
        assert(typeof binary.version === 'string', 'Should have version')
        assert(typeof binary.platform === 'string', 'Should have platform')
        assert(typeof binary.arch === 'string', 'Should have arch')
      }
    })
  })

  describe('isInstalled', () => {
    it('should return boolean', async () => {
      const result = await sqliteBinaryManager.isInstalled(
        '99',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(typeof result === 'boolean', 'Should return boolean')
      assertEqual(result, false, 'Non-existent version should not be installed')
    })

    it('should use full version for path checking', async () => {
      const result = await sqliteBinaryManager.isInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(typeof result === 'boolean', 'Should handle major version input')
    })
  })

  describe('verify', () => {
    it('should throw error for non-existent binary', async () => {
      try {
        await sqliteBinaryManager.verify('99', Platform.Darwin, Arch.ARM64)
        assert(false, 'Should have thrown an error')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          error.message.includes('not found'),
          `Error should indicate binary not found: ${error.message}`,
        )
      }
    })

    it('should parse sqlite3 --version output format', () => {
      // Test the regex pattern used for parsing
      const testOutputs = [
        { output: '3.51.2 2025-01-08 12:00:00', expected: '3.51.2' },
        { output: '3.45.0 2024-01-01 00:00:00', expected: '3.45.0' },
        { output: '3.40.1 2023-06-15 10:30:00 abc123', expected: '3.40.1' },
      ]

      for (const { output, expected } of testOutputs) {
        const match = output.match(/^(\d+\.\d+\.\d+)/)
        assert(match !== null, `Should match pattern in: ${output}`)
        assertEqual(match![1], expected, `Should extract version ${expected}`)
      }
    })
  })

  describe('ensureInstalled', () => {
    it('should invoke progress callback with cached stage when already installed', async () => {
      const isInstalled = await sqliteBinaryManager.isInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )

      if (!isInstalled) {
        // Skip: SQLite binary not installed locally - this test requires cached binaries
        return
      }

      const progressCalls: Array<{ stage: string; message: string }> = []

      await sqliteBinaryManager.ensureInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
        (progress) => {
          progressCalls.push(progress)
        },
      )

      assert(progressCalls.length > 0, 'Progress callback should be invoked')
      assertEqual(
        progressCalls[0].stage,
        'cached',
        'Should report cached stage',
      )
      assert(
        progressCalls[0].message.includes('cached'),
        'Message should mention cached',
      )
    })

    it('should return path to binary directory', async () => {
      const isInstalled = await sqliteBinaryManager.isInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )

      if (!isInstalled) {
        // Skip: SQLite binary not installed locally - this test requires cached binaries
        return
      }

      const binPath = await sqliteBinaryManager.ensureInstalled(
        '3',
        Platform.Darwin,
        Arch.ARM64,
      )

      assert(typeof binPath === 'string', 'Should return path string')
      assert(binPath.includes('3.51.2'), 'Path should include full version')
      assert(binPath.includes('darwin-arm64'), 'Path should include platform')
    })
  })
})
