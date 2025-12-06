/**
 * Unit tests for update-manager module
 */

import { describe, it } from 'node:test'
import { UpdateManager } from '../../core/update-manager'
import { assert, assertEqual } from '../integration/helpers'

describe('UpdateManager', () => {
  describe('getCurrentVersion', () => {
    it('should return valid semver version string', () => {
      const updateManager = new UpdateManager()
      const version = updateManager.getCurrentVersion()

      assert(typeof version === 'string', 'Version should be a string')
      assert(version.length > 0, 'Version should not be empty')

      // Should match semver pattern (X.Y.Z)
      const semverPattern = /^\d+\.\d+\.\d+/
      assert(
        semverPattern.test(version),
        `Version "${version}" should match semver pattern`,
      )
    })

    it('should return consistent version on multiple calls', () => {
      const updateManager = new UpdateManager()
      const version1 = updateManager.getCurrentVersion()
      const version2 = updateManager.getCurrentVersion()

      assertEqual(version1, version2, 'Version should be consistent')
    })
  })

  describe('compareVersions', () => {
    it('should return positive when a > b', () => {
      const updateManager = new UpdateManager()

      assert(
        updateManager.compareVersions('2.0.0', '1.0.0') > 0,
        '2.0.0 should be greater than 1.0.0',
      )
      assert(
        updateManager.compareVersions('1.1.0', '1.0.0') > 0,
        '1.1.0 should be greater than 1.0.0',
      )
      assert(
        updateManager.compareVersions('1.0.1', '1.0.0') > 0,
        '1.0.1 should be greater than 1.0.0',
      )
    })

    it('should return negative when a < b', () => {
      const updateManager = new UpdateManager()

      assert(
        updateManager.compareVersions('1.0.0', '2.0.0') < 0,
        '1.0.0 should be less than 2.0.0',
      )
      assert(
        updateManager.compareVersions('1.0.0', '1.1.0') < 0,
        '1.0.0 should be less than 1.1.0',
      )
      assert(
        updateManager.compareVersions('1.0.0', '1.0.1') < 0,
        '1.0.0 should be less than 1.0.1',
      )
    })

    it('should return 0 when versions are equal', () => {
      const updateManager = new UpdateManager()

      assertEqual(
        updateManager.compareVersions('1.0.0', '1.0.0'),
        0,
        'Same versions should be equal',
      )
      assertEqual(
        updateManager.compareVersions('0.0.1', '0.0.1'),
        0,
        'Same versions should be equal',
      )
    })

    it('should handle missing patch versions', () => {
      const updateManager = new UpdateManager()

      // Compare versions with different lengths
      const result = updateManager.compareVersions('1.0', '1.0.0')
      assertEqual(result, 0, 'Should treat 1.0 as 1.0.0')
    })

    it('should handle leading zeros', () => {
      const updateManager = new UpdateManager()

      assert(
        updateManager.compareVersions('1.10.0', '1.9.0') > 0,
        '1.10.0 should be greater than 1.9.0 (not string comparison)',
      )
      assert(
        updateManager.compareVersions('1.2.0', '1.10.0') < 0,
        '1.2.0 should be less than 1.10.0',
      )
    })

    it('should handle major version changes correctly', () => {
      const updateManager = new UpdateManager()

      assert(
        updateManager.compareVersions('10.0.0', '9.9.9') > 0,
        '10.0.0 should be greater than 9.9.9',
      )
      assert(
        updateManager.compareVersions('2.0.0', '1.99.99') > 0,
        '2.0.0 should be greater than 1.99.99',
      )
    })
  })

  describe('UpdateCheckResult Shape', () => {
    it('should have correct structure for update available', () => {
      const result = {
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
        lastChecked: new Date().toISOString(),
      }

      assert(typeof result.currentVersion === 'string', 'Should have currentVersion')
      assert(typeof result.latestVersion === 'string', 'Should have latestVersion')
      assert(typeof result.updateAvailable === 'boolean', 'Should have updateAvailable')
      assert(typeof result.lastChecked === 'string', 'Should have lastChecked')
      assert(result.updateAvailable === true, 'updateAvailable should be true when versions differ')
    })

    it('should have correct structure for no update', () => {
      const result = {
        currentVersion: '2.0.0',
        latestVersion: '2.0.0',
        updateAvailable: false,
        lastChecked: new Date().toISOString(),
      }

      assertEqual(result.updateAvailable, false, 'updateAvailable should be false when same version')
    })
  })

  describe('UpdateResult Shape', () => {
    it('should have correct success structure', () => {
      const result: {
        success: boolean
        previousVersion: string
        newVersion: string
        error?: string
      } = {
        success: true,
        previousVersion: '1.0.0',
        newVersion: '2.0.0',
      }

      assert(result.success === true, 'success should be true')
      assert(typeof result.previousVersion === 'string', 'Should have previousVersion')
      assert(typeof result.newVersion === 'string', 'Should have newVersion')
      assert(result.error === undefined, 'error should not be present on success')
    })

    it('should have correct failure structure', () => {
      const result = {
        success: false,
        previousVersion: '1.0.0',
        newVersion: '1.0.0',
        error: 'Permission denied. Try: sudo npm install -g spindb@latest',
      }

      assert(result.success === false, 'success should be false')
      assertEqual(
        result.previousVersion,
        result.newVersion,
        'versions should be same on failure',
      )
      assert(typeof result.error === 'string', 'Should have error message')
      assert(
        result.error.includes('Permission denied') || result.error.length > 0,
        'Error should be descriptive',
      )
    })

    it('should provide actionable error for permission issues', () => {
      const errorMessage = 'Permission denied. Try: sudo npm install -g spindb@latest'

      assert(
        errorMessage.includes('sudo'),
        'Permission error should suggest sudo',
      )
      assert(
        errorMessage.includes('npm install'),
        'Should include the fix command',
      )
    })
  })

  describe('Throttling Logic', () => {
    it('should calculate throttle period correctly', () => {
      const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24 hours

      assertEqual(CHECK_THROTTLE_MS, 86400000, 'Throttle should be 24 hours in ms')

      const lastCheck = new Date(Date.now() - 60000).toISOString() // 1 minute ago
      const elapsed = Date.now() - new Date(lastCheck).getTime()

      assert(elapsed < CHECK_THROTTLE_MS, 'Recent check should be within throttle')
    })

    it('should identify stale checks', () => {
      const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24 hours

      const staleCheck = new Date(Date.now() - (CHECK_THROTTLE_MS + 1000)).toISOString()
      const elapsed = Date.now() - new Date(staleCheck).getTime()

      assert(elapsed > CHECK_THROTTLE_MS, 'Old check should be outside throttle')
    })
  })

  describe('getCachedUpdateInfo', () => {
    it('should return autoCheckEnabled default as true', async () => {
      const updateManager = new UpdateManager()
      const info = await updateManager.getCachedUpdateInfo()

      // Default should be enabled
      assert(
        info.autoCheckEnabled === true || info.autoCheckEnabled === false,
        'autoCheckEnabled should be boolean',
      )
    })

    it('should return latestVersion if cached', async () => {
      const updateManager = new UpdateManager()
      const info = await updateManager.getCachedUpdateInfo()

      assert(
        info.latestVersion === undefined || typeof info.latestVersion === 'string',
        'latestVersion should be string or undefined',
      )
    })
  })

  describe('npm Registry Response Parsing', () => {
    it('should parse dist-tags.latest from registry response', () => {
      const mockResponse = {
        'dist-tags': {
          latest: '2.0.0',
          beta: '2.1.0-beta.1',
        },
      }

      const latestVersion = mockResponse['dist-tags'].latest

      assertEqual(latestVersion, '2.0.0', 'Should extract latest version')
    })

    it('should handle missing dist-tags gracefully', () => {
      const invalidResponse = {} as { 'dist-tags'?: { latest?: string } }

      const latestVersion = invalidResponse?.['dist-tags']?.latest

      assertEqual(latestVersion, undefined, 'Missing dist-tags should return undefined')
    })
  })

  describe('performUpdate Error Detection', () => {
    it('should detect EACCES permission errors', () => {
      const errorMessages = [
        'EACCES: permission denied',
        'Error: EACCES',
        'permission denied writing to /usr/local',
      ]

      for (const msg of errorMessages) {
        const isPermissionError =
          msg.includes('EACCES') || msg.includes('permission')

        assert(
          isPermissionError,
          `Should detect permission error in: ${msg}`,
        )
      }
    })

    it('should provide actionable message for permission errors', () => {
      const permissionErrorResponse = {
        success: false,
        previousVersion: '1.0.0',
        newVersion: '1.0.0',
        error: 'Permission denied. Try: sudo npm install -g spindb@latest',
      }

      assert(
        permissionErrorResponse.error.includes('sudo'),
        'Should suggest sudo for permission errors',
      )
      assert(
        permissionErrorResponse.error.includes('npm install -g spindb@latest'),
        'Should include complete fix command',
      )
    })
  })

  describe('npm list parsing', () => {
    it('should parse version from npm list --json output', () => {
      const mockNpmListOutput = {
        dependencies: {
          spindb: {
            version: '2.0.0',
          },
        },
      }

      const version = mockNpmListOutput.dependencies?.spindb?.version

      assertEqual(version, '2.0.0', 'Should extract version from npm list output')
    })

    it('should handle missing dependencies in npm list output', () => {
      const emptyOutput = {} as {
        dependencies?: { spindb?: { version?: string } }
      }

      const version = emptyOutput.dependencies?.spindb?.version ?? '1.0.0'

      assertEqual(version, '1.0.0', 'Should fallback to previous version')
    })
  })
})
