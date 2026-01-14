import { describe, it } from 'node:test'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
} from '../../engines/valkey/version-validator'
import { assert, assertEqual } from '../utils/assertions'

describe('Valkey Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse standard Valkey version string', () => {
      const version = parseVersion('8.0.6')
      assert(version !== null, 'Version should not be null')
      assertEqual(version!.major, 8, 'Major version should be 8')
      assertEqual(version!.minor, 0, 'Minor version should be 0')
      assertEqual(version!.patch, 6, 'Patch version should be 6')
    })

    it('should parse version with just major.minor', () => {
      const version = parseVersion('9.0')
      assert(version !== null, 'Version should not be null')
      assertEqual(version!.major, 9, 'Major version should be 9')
      assertEqual(version!.minor, 0, 'Minor version should be 0')
      assertEqual(version!.patch, 0, 'Patch version should default to 0')
    })

    it('should parse major version only', () => {
      const version = parseVersion('8')
      assert(version !== null, 'Version should not be null')
      assertEqual(version!.major, 8, 'Major version should be 8')
      assertEqual(version!.minor, 0, 'Minor version should default to 0')
      assertEqual(version!.patch, 0, 'Patch version should default to 0')
    })

    it('should parse Valkey 9.x version', () => {
      const version = parseVersion('9.0.1')
      assert(version !== null, 'Version should not be null')
      assertEqual(version!.major, 9, 'Major version should be 9')
      assertEqual(version!.minor, 0, 'Minor version should be 0')
      assertEqual(version!.patch, 1, 'Patch version should be 1')
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
    it('should return true for Valkey 8.x', () => {
      assert(isVersionSupported('8.0.0'), 'Valkey 8.0.0 should be supported')
      assert(isVersionSupported('8.0.6'), 'Valkey 8.0.6 should be supported')
    })

    it('should return true for Valkey 9.x', () => {
      assert(isVersionSupported('9.0.0'), 'Valkey 9.0.0 should be supported')
      assert(isVersionSupported('9.0.1'), 'Valkey 9.0.1 should be supported')
    })

    it('should return false for Valkey 7.x', () => {
      assert(
        !isVersionSupported('7.0.0'),
        'Valkey 7.0.0 should not be supported',
      )
    })

    it('should return false for invalid version', () => {
      assert(
        !isVersionSupported('invalid'),
        'Invalid version should not be supported',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version from full version', () => {
      assertEqual(getMajorVersion('8.0.6'), '8', 'Major version should be 8')
      assertEqual(getMajorVersion('9.0.1'), '9', 'Major version should be 9')
    })

    it('should handle version with just major', () => {
      assertEqual(getMajorVersion('9'), '9', 'Major version should be 9')
    })

    it('should return original string for invalid version', () => {
      // getMajorVersion returns the original string if parsing fails
      assertEqual(
        getMajorVersion('invalid'),
        'invalid',
        'Should return original for invalid',
      )
    })
  })

  describe('compareVersions', () => {
    it('should return negative when a < b', () => {
      const r1 = compareVersions('8.0.0', '9.0.0')
      const r2 = compareVersions('8.0.0', '8.0.6')
      const r3 = compareVersions('9.0.0', '9.0.1')
      assert(r1 !== null && r1 < 0, '8.0.0 should be less than 9.0.0')
      assert(r2 !== null && r2 < 0, '8.0.0 should be less than 8.0.6')
      assert(r3 !== null && r3 < 0, '9.0.0 should be less than 9.0.1')
    })

    it('should return positive when a > b', () => {
      const r1 = compareVersions('9.0.0', '8.0.0')
      const r2 = compareVersions('8.0.6', '8.0.0')
      const r3 = compareVersions('9.0.1', '9.0.0')
      assert(r1 !== null && r1 > 0, '9.0.0 should be greater than 8.0.0')
      assert(r2 !== null && r2 > 0, '8.0.6 should be greater than 8.0.0')
      assert(r3 !== null && r3 > 0, '9.0.1 should be greater than 9.0.0')
    })

    it('should return 0 when versions are equal', () => {
      assertEqual(
        compareVersions('8.0.6', '8.0.6'),
        0,
        'Same versions should be equal',
      )
    })

    it('should return null when either version cannot be parsed', () => {
      assertEqual(
        compareVersions('invalid', '8.0.0'),
        null,
        'Invalid first version should return null',
      )
      assertEqual(
        compareVersions('8.0.0', 'invalid'),
        null,
        'Invalid second version should return null',
      )
      assertEqual(
        compareVersions('invalid', 'also-invalid'),
        null,
        'Both invalid should return null',
      )
      assertEqual(
        compareVersions('', '8.0.0'),
        null,
        'Empty first version should return null',
      )
    })
  })

  describe('isVersionCompatible (backup/restore)', () => {
    it('should be compatible when same major version', () => {
      const result = isVersionCompatible('8.0.6', '8.0.0')
      assert(result.compatible, '8.0.6 backup should restore to 8.0.0 server')
    })

    it('should be compatible when restoring to newer version (upgrade)', () => {
      const result = isVersionCompatible('8.0.0', '9.0.0')
      assert(result.compatible, '8.0.0 backup should restore to 9.0.0 server')
      assert(result.warning !== undefined, 'Should have upgrade warning')
    })

    it('should not be compatible when backup is from newer major version', () => {
      const result = isVersionCompatible('9.0.0', '8.0.0')
      assert(
        !result.compatible,
        '9.0.0 backup should not restore to 8.0.0 server',
      )
    })

    it('should be compatible with warning for invalid versions', () => {
      // Function returns compatible: true with a warning for unparseable versions
      const result = isVersionCompatible('invalid', '8.0.0')
      assert(result.compatible, 'Should be compatible with warning')
      assert(
        result.warning !== undefined,
        'Should have warning for invalid version',
      )
    })
  })
})
