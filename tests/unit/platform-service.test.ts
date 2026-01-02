import { describe, it } from 'node:test'
import {
  platformService,
  resolveHomeDir,
  type PlatformInfo,
  type ClipboardConfig,
  type PackageManagerInfo,
} from '../../core/platform-service'
import { assert, assertEqual } from '../utils/assertions'

describe('PlatformService', () => {
  describe('getPlatformInfo', () => {
    it('should return valid platform info', () => {
      const info: PlatformInfo = platformService.getPlatformInfo()

      // Platform should be one of the supported values
      assert(
        ['darwin', 'linux', 'win32'].includes(info.platform),
        `Platform should be darwin, linux, or win32, got: ${info.platform}`,
      )

      // Architecture should be one of the supported values
      assert(
        ['arm64', 'x64'].includes(info.arch),
        `Architecture should be arm64 or x64, got: ${info.arch}`,
      )

      // Home directory should be a non-empty string
      assert(
        typeof info.homeDir === 'string' && info.homeDir.length > 0,
        'Home directory should be a non-empty string',
      )

      // Boolean properties
      assert(typeof info.isWSL === 'boolean', 'isWSL should be a boolean')
      assert(typeof info.isSudo === 'boolean', 'isSudo should be a boolean')

      // sudoUser should be string or null
      assert(
        info.sudoUser === null || typeof info.sudoUser === 'string',
        'sudoUser should be string or null',
      )
    })

    it('should return consistent results on repeated calls', () => {
      const info1 = platformService.getPlatformInfo()
      const info2 = platformService.getPlatformInfo()

      assertEqual(
        info1.platform,
        info2.platform,
        'Platform should be consistent',
      )
      assertEqual(info1.arch, info2.arch, 'Architecture should be consistent')
      assertEqual(
        info1.homeDir,
        info2.homeDir,
        'Home directory should be consistent',
      )
    })
  })

  describe('getClipboardConfig', () => {
    it('should return valid clipboard config', () => {
      const config: ClipboardConfig = platformService.getClipboardConfig()

      assert(
        typeof config.copyCommand === 'string',
        'copyCommand should be a string',
      )
      assert(Array.isArray(config.copyArgs), 'copyArgs should be an array')
      assert(
        typeof config.pasteCommand === 'string',
        'pasteCommand should be a string',
      )
      assert(Array.isArray(config.pasteArgs), 'pasteArgs should be an array')
      assert(
        typeof config.available === 'boolean',
        'available should be a boolean',
      )
    })

    it('should return platform-appropriate commands', () => {
      const config = platformService.getClipboardConfig()
      const info = platformService.getPlatformInfo()

      if (info.platform === 'darwin') {
        assert(
          config.copyCommand.includes('pbcopy') ||
            config.copyCommand === 'pbcopy',
          'macOS should use pbcopy',
        )
      } else if (info.platform === 'linux') {
        assert(
          config.copyCommand.includes('xclip') ||
            config.copyCommand.includes('xsel') ||
            config.copyCommand === 'xclip',
          'Linux should use xclip or xsel',
        )
      }
    })
  })

  describe('getWhichCommand', () => {
    it('should return valid which command config', () => {
      const config = platformService.getWhichCommand()

      assert(
        typeof config.command === 'string' && config.command.length > 0,
        'command should be a non-empty string',
      )
      assert(Array.isArray(config.args), 'args should be an array')
    })

    it('should return platform-appropriate command', () => {
      const config = platformService.getWhichCommand()
      const info = platformService.getPlatformInfo()

      if (info.platform === 'win32') {
        assert(config.command === 'where', 'Windows should use "where" command')
      } else {
        assert(config.command === 'which', 'Unix should use "which" command')
      }
    })
  })

  describe('getSearchPaths', () => {
    it('should return array of paths for MySQL', () => {
      const paths = platformService.getSearchPaths('mysql')

      assert(Array.isArray(paths), 'Should return an array')
      assert(paths.length > 0, 'Should return at least one path')

      for (const path of paths) {
        assert(
          typeof path === 'string' && path.length > 0,
          `Path should be non-empty string: ${path}`,
        )
      }
    })

    it('should return array of paths for PostgreSQL tools', () => {
      const paths = platformService.getSearchPaths('psql')

      assert(Array.isArray(paths), 'Should return an array')
      assert(paths.length > 0, 'Should return at least one path')
    })

    it('should include common paths for current platform', () => {
      const paths = platformService.getSearchPaths('mysqld')
      const info = platformService.getPlatformInfo()

      if (info.platform === 'darwin') {
        const hasHomebrew = paths.some(
          (p) => p.includes('/opt/homebrew') || p.includes('/usr/local'),
        )
        assert(hasHomebrew, 'macOS should include Homebrew paths')
      } else if (info.platform === 'linux') {
        const hasStandardPaths = paths.some(
          (p) => p.includes('/usr/bin') || p.includes('/usr/local/bin'),
        )
        assert(hasStandardPaths, 'Linux should include standard bin paths')
      }
    })
  })

  describe('detectPackageManager', () => {
    it('should return PackageManagerInfo or null', async () => {
      const result: PackageManagerInfo | null =
        await platformService.detectPackageManager()

      if (result !== null) {
        assert(typeof result.id === 'string', 'id should be a string')
        assert(typeof result.name === 'string', 'name should be a string')
        assert(
          typeof result.checkCommand === 'string',
          'checkCommand should be a string',
        )
        assert(
          typeof result.installTemplate === 'string',
          'installTemplate should be a string',
        )
        assert(
          typeof result.updateCommand === 'string',
          'updateCommand should be a string',
        )
      }
    })

    it('should detect package manager appropriate for platform', async () => {
      const result = await platformService.detectPackageManager()
      const info = platformService.getPlatformInfo()

      if (result !== null) {
        if (info.platform === 'darwin') {
          assertEqual(result.id, 'brew', 'macOS should detect Homebrew')
        } else if (info.platform === 'linux') {
          assert(
            ['apt', 'yum', 'dnf', 'pacman'].includes(result.id),
            `Linux should detect apt, yum, dnf, or pacman, got: ${result.id}`,
          )
        }
      }
    })
  })

  describe('findToolPath', () => {
    it('should find common tools', async () => {
      // Try to find a tool that should exist on any system
      const info = platformService.getPlatformInfo()
      const toolToFind = info.platform === 'win32' ? 'cmd' : 'ls'

      const path = await platformService.findToolPath(toolToFind)

      // This might return null if tool isn't found, but if found it should be a path
      if (path !== null) {
        assert(
          typeof path === 'string' && path.length > 0,
          'Found path should be non-empty string',
        )
      }
    })

    it('should return null for non-existent tool', async () => {
      const path = await platformService.findToolPath(
        'definitely-not-a-real-tool-12345',
      )

      assertEqual(path, null, 'Should return null for non-existent tool')
    })
  })

  describe('getToolVersion', () => {
    it('should return version string or null', async () => {
      // Try to get version of a tool we know exists
      const info = platformService.getPlatformInfo()
      const toolPath = info.platform === 'win32' ? 'cmd' : '/bin/ls'

      const version = await platformService.getToolVersion(toolPath)

      // Version might be null if we can't parse it
      if (version !== null) {
        assert(
          typeof version === 'string',
          'Version should be a string if found',
        )
      }
    })

    it('should return null for non-existent path', async () => {
      const version = await platformService.getToolVersion('/non/existent/path')

      assertEqual(version, null, 'Should return null for non-existent path')
    })
  })

  describe('copyToClipboard', () => {
    // Note: This test may behave differently in CI environments without clipboard
    it('should return boolean indicating success', async () => {
      const result = await platformService.copyToClipboard('test content')

      assert(typeof result === 'boolean', 'Should return a boolean')
    })
  })

  describe('getZonkyPlatform', () => {
    it('should return platform string for supported platforms or null', () => {
      const zonkyPlatform = platformService.getZonkyPlatform()
      const info = platformService.getPlatformInfo()

      if (info.platform === 'darwin' || info.platform === 'linux') {
        assert(
          zonkyPlatform !== null,
          'Should return platform string for darwin/linux',
        )
        assert(
          typeof zonkyPlatform === 'string' && zonkyPlatform.length > 0,
          'Platform string should be non-empty',
        )
      }

      if (info.platform === 'win32') {
        assertEqual(
          zonkyPlatform,
          null,
          'Windows should return null (not supported by zonky)',
        )
      }

      if (zonkyPlatform !== null) {
        // Check it returns expected zonky.io format (includes architecture)
        // Examples: darwin-arm64v8, darwin-amd64, linux-arm64v8, linux-amd64
        assert(
          zonkyPlatform.startsWith('darwin-') ||
            zonkyPlatform.startsWith('linux-') ||
            zonkyPlatform.startsWith('alpine-linux-'),
          `Zonky platform should start with darwin-, linux-, or alpine-linux-, got: ${zonkyPlatform}`,
        )
      }
    })
  })
})

describe('resolveHomeDir', () => {
  describe('when not running under sudo', () => {
    it('should return default home directory', () => {
      const result = resolveHomeDir({
        sudoUser: null,
        getentResult: null,
        platform: 'darwin',
        defaultHome: '/Users/bob',
      })

      assertEqual(result, '/Users/bob', 'Should return default home')
    })

    it('should ignore getent result if sudoUser is null', () => {
      const result = resolveHomeDir({
        sudoUser: null,
        getentResult: 'bob:x:501:20::/Users/bob:/bin/zsh',
        platform: 'darwin',
        defaultHome: '/root',
      })

      assertEqual(
        result,
        '/root',
        'Should return default home even with getent',
      )
    })
  })

  describe('when running under sudo with valid getent result', () => {
    it('should parse home from standard getent passwd format', () => {
      // Format: username:password:uid:gid:gecos:home:shell
      const result = resolveHomeDir({
        sudoUser: 'bob',
        getentResult: 'bob:x:501:20:Bob Bass:/Users/bob:/bin/zsh',
        platform: 'darwin',
        defaultHome: '/root',
      })

      assertEqual(result, '/Users/bob', 'Should parse home from getent')
    })

    it('should handle getent with empty gecos field', () => {
      const result = resolveHomeDir({
        sudoUser: 'bob',
        getentResult: 'bob:x:501:20::/Users/bob:/bin/zsh',
        platform: 'darwin',
        defaultHome: '/root',
      })

      assertEqual(result, '/Users/bob', 'Should parse home with empty gecos')
    })

    it('should handle Linux-style home paths', () => {
      const result = resolveHomeDir({
        sudoUser: 'deploy',
        getentResult: 'deploy:x:1000:1000:Deploy User:/home/deploy:/bin/bash',
        platform: 'linux',
        defaultHome: '/root',
      })

      assertEqual(result, '/home/deploy', 'Should parse Linux home path')
    })

    it('should handle custom home directories', () => {
      const result = resolveHomeDir({
        sudoUser: 'service',
        getentResult:
          'service:x:999:999:Service Account:/var/lib/service:/bin/false',
        platform: 'linux',
        defaultHome: '/root',
      })

      assertEqual(result, '/var/lib/service', 'Should parse custom home path')
    })

    it('should handle getent with trailing newline', () => {
      const result = resolveHomeDir({
        sudoUser: 'bob',
        getentResult: 'bob:x:501:20::/Users/bob:/bin/zsh\n',
        platform: 'darwin',
        defaultHome: '/root',
      })

      assertEqual(result, '/Users/bob', 'Should handle trailing newline')
    })
  })

  describe('when running under sudo without valid getent result', () => {
    it('should fallback to /Users/{user} on macOS', () => {
      const result = resolveHomeDir({
        sudoUser: 'bob',
        getentResult: null,
        platform: 'darwin',
        defaultHome: '/root',
      })

      assertEqual(result, '/Users/bob', 'Should fallback to /Users/bob')
    })

    it('should fallback to /home/{user} on Linux', () => {
      const result = resolveHomeDir({
        sudoUser: 'bob',
        getentResult: null,
        platform: 'linux',
        defaultHome: '/root',
      })

      assertEqual(result, '/home/bob', 'Should fallback to /home/bob')
    })

    it('should fallback when getent result is malformed (too few fields)', () => {
      const result = resolveHomeDir({
        sudoUser: 'bob',
        getentResult: 'bob:x:501',
        platform: 'darwin',
        defaultHome: '/root',
      })

      assertEqual(result, '/Users/bob', 'Should fallback with malformed getent')
    })

    it('should fallback when home field is empty', () => {
      const result = resolveHomeDir({
        sudoUser: 'bob',
        getentResult: 'bob:x:501:20:::/bin/zsh',
        platform: 'darwin',
        defaultHome: '/root',
      })

      assertEqual(result, '/Users/bob', 'Should fallback when home is empty')
    })

    it('should fallback when getent is empty string', () => {
      const result = resolveHomeDir({
        sudoUser: 'bob',
        getentResult: '',
        platform: 'linux',
        defaultHome: '/root',
      })

      assertEqual(result, '/home/bob', 'Should fallback with empty getent')
    })
  })

  describe('edge cases', () => {
    it('should handle usernames with special characters', () => {
      const result = resolveHomeDir({
        sudoUser: 'bob-bass',
        getentResult: null,
        platform: 'darwin',
        defaultHome: '/root',
      })

      assertEqual(
        result,
        '/Users/bob-bass',
        'Should handle hyphenated username',
      )
    })

    it('should handle usernames with underscores', () => {
      const result = resolveHomeDir({
        sudoUser: 'bob_bass',
        getentResult: null,
        platform: 'linux',
        defaultHome: '/root',
      })

      assertEqual(
        result,
        '/home/bob_bass',
        'Should handle underscored username',
      )
    })

    it('should prevent using root home when sudo is detected', () => {
      // This is the key security test - we should NEVER return /root
      // when SUDO_USER is set
      const result = resolveHomeDir({
        sudoUser: 'bob',
        getentResult: null,
        platform: 'darwin',
        defaultHome: '/var/root', // macOS root home
      })

      assert(
        !result.includes('root'),
        `Should not return root home directory, got: ${result}`,
      )
      assertEqual(result, '/Users/bob', 'Should use user home, not root')
    })
  })
})
