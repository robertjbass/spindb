/**
 * QuestDB version validator unit tests
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
} from '../../engines/questdb/version-validator'

describe('QuestDB Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const parsed = parseVersion('9.2.3')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 9, 'Major should be 9')
      assertEqual(parsed!.minor, 2, 'Minor should be 2')
      assertEqual(parsed!.patch, 3, 'Patch should be 3')
      assertEqual(parsed!.full, '9.2.3', 'Full should be 9.2.3')
    })

    it('should parse older version', () => {
      const parsed = parseVersion('8.1.0')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 8, 'Major should be 8')
      assertEqual(parsed!.minor, 1, 'Minor should be 1')
      assertEqual(parsed!.patch, 0, 'Patch should be 0')
    })

    it('should return null for invalid version', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, 'Should return null for invalid')
    })

    it('should parse partial version with defaults', () => {
      const parsed = parseVersion('9.2')
      assert(parsed !== null, 'Should parse partial version')
      assertEqual(parsed!.major, 9, 'Major should be 9')
      assertEqual(parsed!.minor, 2, 'Minor should be 2')
      assertEqual(parsed!.patch, 0, 'Patch should default to 0')
    })

    it('should parse major only version with defaults', () => {
      const parsed = parseVersion('9')
      assert(parsed !== null, 'Should parse major only version')
      assertEqual(parsed!.major, 9, 'Major should be 9')
      assertEqual(parsed!.minor, 0, 'Minor should default to 0')
      assertEqual(parsed!.patch, 0, 'Patch should default to 0')
    })
  })

  describe('isVersionSupported', () => {
    it('should support version 9.x', () => {
      assert(isVersionSupported('9.2.3'), 'Version 9.2.3 should be supported')
      assert(isVersionSupported('9'), 'Version 9 should be supported')
      assert(isVersionSupported('9.2'), 'Version 9.2 should be supported')
    })

    it('should not support version 8.x', () => {
      assert(!isVersionSupported('8.0.0'), 'Version 8.0.0 should not be supported')
      assert(!isVersionSupported('8'), 'Version 8 should not be supported')
    })

    it('should not support version 7.x', () => {
      assert(!isVersionSupported('7.0.0'), 'Version 7.0.0 should not be supported')
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version from full version', () => {
      assertEqual(getMajorVersion('9.2.3'), '9', 'Should extract 9')
    })

    it('should extract major version from partial version', () => {
      assertEqual(getMajorVersion('9.2'), '9', 'Should extract 9 from 9.2')
    })

    it('should extract major version from major only', () => {
      assertEqual(getMajorVersion('9'), '9', 'Should extract 9 from 9')
    })
  })

  describe('compareVersions', () => {
    it('should compare equal versions', () => {
      assertEqual(compareVersions('9.2.3', '9.2.3'), 0, 'Equal versions')
    })

    it('should compare different major versions', () => {
      assert(compareVersions('8.0.0', '9.0.0') < 0, '8.x < 9.x')
      assert(compareVersions('9.0.0', '8.0.0') > 0, '9.x > 8.x')
    })

    it('should compare different minor versions', () => {
      assert(compareVersions('9.1.0', '9.2.0') < 0, '9.1 < 9.2')
      assert(compareVersions('9.2.0', '9.1.0') > 0, '9.2 > 9.1')
    })

    it('should compare different patch versions', () => {
      assert(compareVersions('9.2.0', '9.2.3') < 0, '9.2.0 < 9.2.3')
      assert(compareVersions('9.2.3', '9.2.0') > 0, '9.2.3 > 9.2.0')
    })

    it('should handle invalid versions with string comparison', () => {
      // Falls back to localeCompare for invalid versions
      const result = compareVersions('invalid', '9.2.3')
      assert(typeof result === 'number', 'Should return a number')
    })
  })

  describe('isVersionCompatible', () => {
    it('should be compatible for same major version', () => {
      assert(
        isVersionCompatible('9.1.0', '9.2.3'),
        'Same major should be compatible',
      )
    })

    it('should be compatible for restoring to newer major version', () => {
      // QuestDB allows restoring to same or newer major version
      assert(
        isVersionCompatible('8.0.0', '9.0.0'),
        'Restoring from 8.x to 9.x should be compatible',
      )
    })

    it('should not be compatible for restoring to older major version', () => {
      assert(
        !isVersionCompatible('9.0.0', '8.0.0'),
        'Restoring from 9.x to 8.x should not be compatible',
      )
    })

    it('should be compatible for exact same version', () => {
      assert(
        isVersionCompatible('9.2.3', '9.2.3'),
        'Same version should be compatible',
      )
    })
  })
})
