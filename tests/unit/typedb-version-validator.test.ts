/**
 * TypeDB version validator unit tests
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
  isValidVersionFormat,
} from '../../engines/typedb/version-validator'

describe('TypeDB Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const parsed = parseVersion('3.8.0')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 3, 'Major should be 3')
      assertEqual(parsed!.minor, 8, 'Minor should be 8')
      assertEqual(parsed!.patch, 0, 'Patch should be 0')
      assertEqual(parsed!.raw, '3.8.0', 'Raw should be 3.8.0')
    })

    it('should parse older version', () => {
      const parsed = parseVersion('2.0.0')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 2, 'Major should be 2')
      assertEqual(parsed!.minor, 0, 'Minor should be 0')
      assertEqual(parsed!.patch, 0, 'Patch should be 0')
    })

    it('should return null for invalid version', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, 'Should return null for invalid')
    })

    it('should parse partial version with defaults', () => {
      const parsed = parseVersion('3.8')
      assert(parsed !== null, 'Should parse partial version')
      assertEqual(parsed!.major, 3, 'Major should be 3')
      assertEqual(parsed!.minor, 8, 'Minor should be 8')
      assertEqual(parsed!.patch, 0, 'Patch should default to 0')
    })

    it('should parse major only version with defaults', () => {
      const parsed = parseVersion('3')
      assert(parsed !== null, 'Should parse major only version')
      assertEqual(parsed!.major, 3, 'Major should be 3')
      assertEqual(parsed!.minor, 0, 'Minor should default to 0')
      assertEqual(parsed!.patch, 0, 'Patch should default to 0')
    })

    it('should handle v prefix', () => {
      const parsed = parseVersion('v3.8.0')
      assert(parsed !== null, 'Should parse version with v prefix')
      assertEqual(parsed!.major, 3, 'Major should be 3')
    })
  })

  describe('isVersionSupported', () => {
    it('should support version 3.x', () => {
      assert(isVersionSupported('3.8.0'), 'Version 3.8.0 should be supported')
      assert(isVersionSupported('3'), 'Version 3 should be supported')
      assert(isVersionSupported('3.8'), 'Version 3.8 should be supported')
    })

    it('should not support version 2.x', () => {
      assert(
        !isVersionSupported('2.0.0'),
        'Version 2.0.0 should not be supported',
      )
      assert(!isVersionSupported('2'), 'Version 2 should not be supported')
    })

    it('should not support version 1.x', () => {
      assert(
        !isVersionSupported('1.0.0'),
        'Version 1.0.0 should not be supported',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version from full version', () => {
      assertEqual(getMajorVersion('3.8.0'), '3', 'Should extract 3')
    })

    it('should extract major version from partial version', () => {
      assertEqual(getMajorVersion('3.8'), '3', 'Should extract 3 from 3.8')
    })

    it('should extract major version from major only', () => {
      assertEqual(getMajorVersion('3'), '3', 'Should extract 3 from 3')
    })
  })

  describe('compareVersions', () => {
    it('should compare equal versions', () => {
      assertEqual(compareVersions('3.8.0', '3.8.0'), 0, 'Equal versions')
    })

    it('should compare different major versions', () => {
      const result1 = compareVersions('2.0.0', '3.0.0')
      assert(result1 !== null && result1 < 0, '2.x < 3.x')
      const result2 = compareVersions('3.0.0', '2.0.0')
      assert(result2 !== null && result2 > 0, '3.x > 2.x')
    })

    it('should compare different minor versions', () => {
      const result1 = compareVersions('3.7.0', '3.8.0')
      assert(result1 !== null && result1 < 0, '3.7 < 3.8')
      const result2 = compareVersions('3.8.0', '3.7.0')
      assert(result2 !== null && result2 > 0, '3.8 > 3.7')
    })

    it('should compare different patch versions', () => {
      const result1 = compareVersions('3.8.0', '3.8.1')
      assert(result1 !== null && result1 < 0, '3.8.0 < 3.8.1')
      const result2 = compareVersions('3.8.1', '3.8.0')
      assert(result2 !== null && result2 > 0, '3.8.1 > 3.8.0')
    })

    it('should return null for invalid versions', () => {
      const result = compareVersions('invalid', '3.8.0')
      assertEqual(result, null, 'Should return null for invalid version')
    })
  })

  describe('isValidVersionFormat', () => {
    it('should accept full semver', () => {
      assert(isValidVersionFormat('3.8.0'), '3.8.0 should be valid')
    })

    it('should accept major.minor', () => {
      assert(isValidVersionFormat('3.8'), '3.8 should be valid')
    })

    it('should accept major only', () => {
      assert(isValidVersionFormat('3'), '3 should be valid')
    })

    it('should accept v prefix', () => {
      assert(isValidVersionFormat('v3.8.0'), 'v3.8.0 should be valid')
    })

    it('should reject non-numeric strings', () => {
      assert(!isValidVersionFormat('invalid'), 'invalid should be rejected')
    })

    it('should reject empty string', () => {
      assert(!isValidVersionFormat(''), 'empty string should be rejected')
    })
  })

  describe('isVersionCompatible', () => {
    it('should be compatible for same major version', () => {
      const result = isVersionCompatible('3.7.0', '3.8.0')
      assert(result.compatible, 'Same major should be compatible')
    })

    it('should not be compatible for cross-major version restores', () => {
      const result = isVersionCompatible('2.0.0', '3.0.0')
      assert(
        !result.compatible,
        'Restoring from 2.x to 3.x should not be compatible (cross-major)',
      )
      assert(
        result.warning?.includes('Cross-major') === true,
        'Should include cross-major warning',
      )
    })

    it('should not be compatible for restoring to older major version', () => {
      const result = isVersionCompatible('3.0.0', '2.0.0')
      assert(
        !result.compatible,
        'Restoring from 3.x to 2.x should not be compatible',
      )
    })

    it('should be compatible for exact same version', () => {
      const result = isVersionCompatible('3.8.0', '3.8.0')
      assert(result.compatible, 'Same version should be compatible')
    })
  })
})
