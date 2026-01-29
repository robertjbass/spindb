/**
 * CouchDB version validator unit tests
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  compareVersions,
  isVersionCompatible,
} from '../../engines/couchdb/version-validator'

describe('CouchDB Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const parsed = parseVersion('3.5.1')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 3, 'Major should be 3')
      assertEqual(parsed!.minor, 5, 'Minor should be 5')
      assertEqual(parsed!.patch, 1, 'Patch should be 1')
      assertEqual(parsed!.full, '3.5.1', 'Full should be 3.5.1')
    })

    it('should parse older version', () => {
      const parsed = parseVersion('3.3.0')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 3, 'Major should be 3')
      assertEqual(parsed!.minor, 3, 'Minor should be 3')
      assertEqual(parsed!.patch, 0, 'Patch should be 0')
    })

    it('should return null for invalid version', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, 'Should return null for invalid')
    })

    it('should return null for partial version', () => {
      const parsed = parseVersion('3.5')
      assertEqual(parsed, null, 'Should return null for partial version')
    })

    it('should return null for major only version', () => {
      const parsed = parseVersion('3')
      assertEqual(parsed, null, 'Should return null for major only')
    })
  })

  describe('isVersionSupported', () => {
    it('should support version 3.x', () => {
      assert(isVersionSupported('3.5.1'), 'Version 3.5.1 should be supported')
      assert(isVersionSupported('3'), 'Version 3 should be supported')
      assert(isVersionSupported('3.5'), 'Version 3.5 should be supported')
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
        !isVersionSupported('1.6.1'),
        'Version 1.6.1 should not be supported',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version from full version', () => {
      assertEqual(getMajorVersion('3.5.1'), '3', 'Should extract 3')
    })

    it('should extract major version from partial version', () => {
      assertEqual(getMajorVersion('3.5'), '3', 'Should extract 3 from 3.5')
    })

    it('should extract major version from major only', () => {
      assertEqual(getMajorVersion('3'), '3', 'Should extract 3 from 3')
    })
  })

  describe('compareVersions', () => {
    it('should compare equal versions', () => {
      assertEqual(compareVersions('3.5.1', '3.5.1'), 0, 'Equal versions')
    })

    it('should compare different major versions', () => {
      assert(compareVersions('3.5.1', '4.0.0') < 0, '3.x < 4.x')
      assert(compareVersions('4.0.0', '3.5.1') > 0, '4.x > 3.x')
    })

    it('should compare different minor versions', () => {
      assert(compareVersions('3.4.0', '3.5.0') < 0, '3.4 < 3.5')
      assert(compareVersions('3.5.0', '3.4.0') > 0, '3.5 > 3.4')
    })

    it('should compare different patch versions', () => {
      assert(compareVersions('3.5.0', '3.5.1') < 0, '3.5.0 < 3.5.1')
      assert(compareVersions('3.5.1', '3.5.0') > 0, '3.5.1 > 3.5.0')
    })

    it('should handle invalid versions with string comparison', () => {
      // Falls back to localeCompare for invalid versions
      const result = compareVersions('invalid', '3.5.1')
      assert(typeof result === 'number', 'Should return a number')
    })
  })

  describe('isVersionCompatible', () => {
    it('should be compatible for same major version', () => {
      assert(
        isVersionCompatible('3.4.0', '3.5.1'),
        'Same major should be compatible',
      )
    })

    it('should not be compatible for different major versions', () => {
      assert(
        !isVersionCompatible('3.5.1', '4.0.0'),
        'Different major should not be compatible',
      )
    })

    it('should be compatible for exact same version', () => {
      assert(
        isVersionCompatible('3.5.1', '3.5.1'),
        'Same version should be compatible',
      )
    })
  })
})
