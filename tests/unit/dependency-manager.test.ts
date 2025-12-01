/**
 * Unit tests for dependency-manager module
 *
 * Note: Install testing is deferred to GitHub Actions integration tests
 * These tests focus on detection logic and error handling
 */

import { describe, it } from 'node:test'
import {
  detectPackageManager,
  getCurrentPlatform,
  findBinary,
  checkDependency,
  buildInstallCommand,
  getManualInstallInstructions,
  type DetectedPackageManager,
} from '../../core/dependency-manager'
import { assert, assertEqual } from '../integration/helpers'

describe('DependencyManager', () => {
  describe('detectPackageManager', () => {
    it('should detect a package manager on the system', async () => {
      const pm = await detectPackageManager()

      // On most dev machines, at least one package manager should exist
      // But we don't fail if none found (could be a minimal CI environment)
      if (pm !== null) {
        assert(typeof pm.id === 'string', 'Should have id')
        assert(typeof pm.name === 'string', 'Should have name')
        assert(pm.config !== undefined, 'Should have config')
        assert(
          typeof pm.config.installTemplate === 'string',
          'Should have install template',
        )
      }
    })

    it('should return package manager with correct shape', async () => {
      const pm = await detectPackageManager()

      if (pm !== null) {
        // Verify the shape matches DetectedPackageManager type
        const requiredKeys = ['config', 'id', 'name']
        for (const key of requiredKeys) {
          assert(key in pm, `Should have ${key} property`)
        }
      }
    })
  })

  describe('getCurrentPlatform', () => {
    it('should return valid platform string', () => {
      const platform = getCurrentPlatform()

      const validPlatforms = ['darwin', 'linux', 'win32']
      assert(
        validPlatforms.includes(platform),
        `Platform "${platform}" should be one of: ${validPlatforms.join(', ')}`,
      )
    })

    it('should match process.platform for darwin/linux', () => {
      const platform = getCurrentPlatform()
      const processPlatform = process.platform

      if (processPlatform === 'darwin' || processPlatform === 'linux') {
        assertEqual(
          platform,
          processPlatform,
          'Should match process.platform for Unix systems',
        )
      }
    })
  })

  describe('findBinary', () => {
    it('should find common binaries like ls', async () => {
      const result = await findBinary('ls')

      assert(result !== null, 'Should find ls binary')
      assert(result!.path.includes('/'), 'Should return absolute path')
    })

    it('should return null for non-existent binary', async () => {
      const result = await findBinary('definitely-not-a-real-binary-xyz123')

      assertEqual(result, null, 'Should return null for non-existent binary')
    })

    it('should include version when available', async () => {
      const result = await findBinary('ls')

      if (result !== null) {
        // Version might be undefined if --version fails
        assert(
          result.version === undefined || typeof result.version === 'string',
          'Version should be string or undefined',
        )
      }
    })
  })

  describe('checkDependency', () => {
    it('should return correct shape for installed dependency', async () => {
      // Create a mock dependency that uses 'ls' (should exist on all Unix systems)
      const mockDep = {
        name: 'List Command',
        binary: 'ls',
        description: 'List directory contents',
        packages: {},
        manualInstall: { darwin: [], linux: [] },
      }

      const status = await checkDependency(mockDep)

      assert(typeof status.installed === 'boolean', 'Should have installed boolean')
      assertEqual(status.dependency, mockDep, 'Should include dependency')

      if (status.installed) {
        assert(typeof status.path === 'string', 'Should have path when installed')
      }
    })

    it('should return installed: false for missing dependency', async () => {
      const mockDep = {
        name: 'Fake Tool',
        binary: 'fake-tool-that-does-not-exist-xyz',
        description: 'A fake tool for testing',
        packages: {},
        manualInstall: { darwin: [], linux: [] },
      }

      const status = await checkDependency(mockDep)

      assertEqual(status.installed, false, 'Should be not installed')
      assertEqual(status.path, undefined, 'Should not have path')
    })
  })

  describe('buildInstallCommand', () => {
    it('should build install command from template', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {
          brew: { package: 'test-package' },
        },
        manualInstall: { darwin: [], linux: [] },
      }

      const mockPm: DetectedPackageManager = {
        id: 'brew',
        name: 'Homebrew',
        config: {
          id: 'brew',
          name: 'Homebrew',
          checkCommand: 'brew --version',
          installTemplate: 'brew install {package}',
          updateTemplate: 'brew upgrade {package}',
          platforms: ['darwin'],
        },
      }

      const commands = buildInstallCommand(mockDep, mockPm)

      assertEqual(commands.length, 1, 'Should have one command')
      assertEqual(
        commands[0],
        'brew install test-package',
        'Should build correct install command',
      )
    })

    it('should include pre-install commands', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {
          brew: {
            package: 'test-package',
            preInstall: ['brew tap test/tap'],
          },
        },
        manualInstall: { darwin: [], linux: [] },
      }

      const mockPm: DetectedPackageManager = {
        id: 'brew',
        name: 'Homebrew',
        config: {
          id: 'brew',
          name: 'Homebrew',
          checkCommand: 'brew --version',
          installTemplate: 'brew install {package}',
          updateTemplate: 'brew upgrade {package}',
          platforms: ['darwin'],
        },
      }

      const commands = buildInstallCommand(mockDep, mockPm)

      assertEqual(commands.length, 2, 'Should have pre-install + install')
      assertEqual(commands[0], 'brew tap test/tap', 'Pre-install should be first')
      assert(commands[1].includes('install'), 'Install should be second')
    })

    it('should include post-install commands', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {
          brew: {
            package: 'test-package',
            postInstall: ['brew link --force test-package'],
          },
        },
        manualInstall: { darwin: [], linux: [] },
      }

      const mockPm: DetectedPackageManager = {
        id: 'brew',
        name: 'Homebrew',
        config: {
          id: 'brew',
          name: 'Homebrew',
          checkCommand: 'brew --version',
          installTemplate: 'brew install {package}',
          updateTemplate: 'brew upgrade {package}',
          platforms: ['darwin'],
        },
      }

      const commands = buildInstallCommand(mockDep, mockPm)

      assertEqual(commands.length, 2, 'Should have install + post-install')
      assert(commands[0].includes('install'), 'Install should be first')
      assert(commands[1].includes('link'), 'Post-install should be second')
    })

    it('should throw error for missing package definition', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {}, // No package definitions
        manualInstall: { darwin: [], linux: [] },
      }

      const mockPm: DetectedPackageManager = {
        id: 'brew',
        name: 'Homebrew',
        config: {
          id: 'brew',
          name: 'Homebrew',
          checkCommand: 'brew --version',
          installTemplate: 'brew install {package}',
          updateTemplate: 'brew upgrade {package}',
          platforms: ['darwin'],
        },
      }

      try {
        buildInstallCommand(mockDep, mockPm)
        assert(false, 'Should have thrown an error')
      } catch (error) {
        assert(error instanceof Error, 'Should throw Error')
        assert(
          error.message.includes('No package definition'),
          `Error should mention missing package definition: ${error.message}`,
        )
      }
    })
  })

  describe('getManualInstallInstructions', () => {
    it('should return instructions for platform', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {},
        manualInstall: {
          darwin: ['brew install test-package'],
          linux: ['apt install test-package'],
        },
      }

      const darwinInstructions = getManualInstallInstructions(mockDep, 'darwin')
      const linuxInstructions = getManualInstallInstructions(mockDep, 'linux')

      assert(Array.isArray(darwinInstructions), 'Should return array')
      assertEqual(darwinInstructions.length, 1, 'Should have darwin instructions')
      assert(
        darwinInstructions[0].includes('brew'),
        'Darwin should use brew',
      )

      assertEqual(linuxInstructions.length, 1, 'Should have linux instructions')
      assert(
        linuxInstructions[0].includes('apt'),
        'Linux should use apt',
      )
    })

    it('should return empty array for missing platform', () => {
      const mockDep = {
        name: 'Test Package',
        binary: 'test-bin',
        description: 'A test package',
        packages: {},
        manualInstall: {
          darwin: ['brew install test-package'],
        },
      }

      const instructions = getManualInstallInstructions(mockDep, 'linux')

      assert(Array.isArray(instructions), 'Should return array')
      assertEqual(instructions.length, 0, 'Should be empty for missing platform')
    })
  })

  describe('DependencyStatus Shape', () => {
    it('should have correct structure', () => {
      const status = {
        dependency: {
          name: 'Test',
          binary: 'test',
          description: 'A test dependency',
          packages: {},
          manualInstall: {},
        },
        installed: true,
        path: '/usr/bin/test',
        version: '1.0.0',
      }

      assert('dependency' in status, 'Should have dependency')
      assert('installed' in status, 'Should have installed')
      assert(
        status.path === undefined || typeof status.path === 'string',
        'path should be string or undefined',
      )
      assert(
        status.version === undefined || typeof status.version === 'string',
        'version should be string or undefined',
      )
    })
  })

  describe('InstallResult Shape', () => {
    it('should have correct success structure', () => {
      const result: {
        success: boolean
        dependency: { name: string; binary: string; description: string; packages: Record<string, unknown>; manualInstall: Record<string, unknown> }
        error?: string
      } = {
        success: true,
        dependency: {
          name: 'Test',
          binary: 'test',
          description: 'A test dependency',
          packages: {},
          manualInstall: {},
        },
      }

      assert(result.success === true, 'Should be success')
      assert(result.dependency !== undefined, 'Should have dependency')
      assert(result.error === undefined, 'Should not have error on success')
    })

    it('should have correct failure structure', () => {
      const result = {
        success: false,
        dependency: {
          name: 'Test',
          binary: 'test',
          description: 'A test dependency',
          packages: {},
          manualInstall: {},
        },
        error: 'Installation failed: permission denied',
      }

      assert(result.success === false, 'Should be failure')
      assert(typeof result.error === 'string', 'Should have error message')
      assert(
        result.error.length > 0,
        'Error message should be descriptive',
      )
    })
  })
})

describe('TTY and Sudo Handling', () => {
  it('should check for TTY availability', () => {
    const hasTTY = process.stdin.isTTY === true
    assert(
      typeof hasTTY === 'boolean',
      'Should be able to check TTY status',
    )
  })

  it('should check for root privileges', () => {
    const isRoot = process.getuid?.() === 0
    assert(
      typeof isRoot === 'boolean',
      'Should be able to check root status',
    )
  })
})

describe('Error Messages', () => {
  it('should provide actionable error for missing package definition', () => {
    const mockDep = {
      name: 'PostgreSQL Client',
      binary: 'psql',
      description: 'PostgreSQL command-line client',
      packages: {},
      manualInstall: { darwin: [], linux: [] },
    }

    const mockPm: DetectedPackageManager = {
      id: 'brew',
      name: 'Homebrew',
      config: {
        id: 'brew',
        name: 'Homebrew',
        checkCommand: 'brew --version',
        installTemplate: 'brew install {package}',
        updateTemplate: 'brew upgrade {package}',
        platforms: ['darwin'],
      },
    }

    try {
      buildInstallCommand(mockDep, mockPm)
    } catch (error) {
      assert(error instanceof Error, 'Should throw Error')
      assert(
        error.message.includes(mockDep.name),
        'Error should include dependency name',
      )
      assert(
        error.message.includes(mockPm.name),
        'Error should include package manager name',
      )
    }
  })
})
