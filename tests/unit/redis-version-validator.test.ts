import { describe, it } from 'node:test'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
} from '../../engines/redis/version-validator'
import { assert, assertEqual } from '../integration/helpers'

describe('Redis Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse standard Redis version string', () => {
      const version = parseVersion('7.2.4')
      assert(version !== null, 'Version should not be null')
      assertEqual(version!.major, 7, 'Major version should be 7')
      assertEqual(version!.minor, 2, 'Minor version should be 2')
      assertEqual(version!.patch, 4, 'Patch version should be 4')
    })

    it('should parse version with just major.minor', () => {
      const version = parseVersion('7.0')
      assert(version !== null, 'Version should not be null')
      assertEqual(version!.major, 7, 'Major version should be 7')
      assertEqual(version!.minor, 0, 'Minor version should be 0')
      assertEqual(version!.patch, 0, 'Patch version should default to 0')
    })

    it('should parse major version only', () => {
      const version = parseVersion('7')
      assert(version !== null, 'Version should not be null')
      assertEqual(version!.major, 7, 'Major version should be 7')
      assertEqual(version!.minor, 0, 'Minor version should default to 0')
      assertEqual(version!.patch, 0, 'Patch version should default to 0')
    })

    it('should parse Redis 6.x version', () => {
      const version = parseVersion('6.2.14')
      assert(version !== null, 'Version should not be null')
      assertEqual(version!.major, 6, 'Major version should be 6')
      assertEqual(version!.minor, 2, 'Minor version should be 2')
      assertEqual(version!.patch, 14, 'Patch version should be 14')
    })

    it('should return null on invalid version string', () => {
      const version = parseVersion('invalid')
      assertEqual(version, null, 'Should return null for invalid input')
    })

    it('should return null on empty string', () => {
      const version = parseVersion('')
      assertEqual(version, null, 'Should return null for empty string')
    })
  })

  describe('isVersionSupported', () => {
    it('should return true for Redis 6.x', () => {
      assert(isVersionSupported('6.2.14'), 'Redis 6.2.14 should be supported')
      assert(isVersionSupported('6.0.0'), 'Redis 6.0.0 should be supported')
    })

    it('should return true for Redis 7.x', () => {
      assert(isVersionSupported('7.0.0'), 'Redis 7.0.0 should be supported')
      assert(isVersionSupported('7.2.4'), 'Redis 7.2.4 should be supported')
    })

    it('should return true for Redis 8.x', () => {
      assert(isVersionSupported('8.0.0'), 'Redis 8.0.0 should be supported')
    })

    it('should return false for Redis 5.x', () => {
      assert(!isVersionSupported('5.0.14'), 'Redis 5.0.14 should not be supported')
    })

    it('should return false for invalid version', () => {
      assert(!isVersionSupported('invalid'), 'Invalid version should not be supported')
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version from full version', () => {
      assertEqual(getMajorVersion('7.2.4'), '7', 'Major version should be 7')
      assertEqual(getMajorVersion('6.2.14'), '6', 'Major version should be 6')
      assertEqual(getMajorVersion('8.0.0'), '8', 'Major version should be 8')
    })

    it('should handle version with just major', () => {
      assertEqual(getMajorVersion('7'), '7', 'Major version should be 7')
    })

    it('should return original string for invalid version', () => {
      // getMajorVersion returns the original string if parsing fails
      assertEqual(getMajorVersion('invalid'), 'invalid', 'Should return original for invalid')
    })
  })

  describe('compareVersions', () => {
    it('should return negative when a < b', () => {
      assert(compareVersions('6.0.0', '7.0.0') < 0, '6.0.0 should be less than 7.0.0')
      assert(compareVersions('7.0.0', '7.2.0') < 0, '7.0.0 should be less than 7.2.0')
      assert(compareVersions('7.2.0', '7.2.4') < 0, '7.2.0 should be less than 7.2.4')
    })

    it('should return positive when a > b', () => {
      assert(compareVersions('7.0.0', '6.0.0') > 0, '7.0.0 should be greater than 6.0.0')
      assert(compareVersions('7.2.0', '7.0.0') > 0, '7.2.0 should be greater than 7.0.0')
      assert(compareVersions('7.2.4', '7.2.0') > 0, '7.2.4 should be greater than 7.2.0')
    })

    it('should return 0 when versions are equal', () => {
      assertEqual(compareVersions('7.2.4', '7.2.4'), 0, 'Same versions should be equal')
    })
  })

  describe('isVersionCompatible (backup/restore)', () => {
    it('should be compatible when same major version', () => {
      const result = isVersionCompatible('7.2.4', '7.0.0')
      assert(result.compatible, '7.2.4 backup should restore to 7.0.0 server')
    })

    it('should be compatible when restoring to newer version (upgrade)', () => {
      const result = isVersionCompatible('6.2.0', '7.0.0')
      assert(result.compatible, '6.2.0 backup should restore to 7.0.0 server')
      assert(result.warning !== undefined, 'Should have upgrade warning')
    })

    it('should not be compatible when backup is from newer major version', () => {
      const result = isVersionCompatible('7.0.0', '6.0.0')
      assert(!result.compatible, '7.0.0 backup should not restore to 6.0.0 server')
    })

    it('should be compatible with warning for invalid versions', () => {
      // Function returns compatible: true with a warning for unparseable versions
      const result = isVersionCompatible('invalid', '7.0.0')
      assert(result.compatible, 'Should be compatible with warning')
      assert(result.warning !== undefined, 'Should have warning for invalid version')
    })
  })
})
