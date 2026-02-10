/**
 * InfluxDB version validator unit tests
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  getMajorMinorVersion,
  compareVersions,
  isVersionCompatible,
  isValidVersionFormat,
} from '../../engines/influxdb/version-validator'

describe('InfluxDB Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const parsed = parseVersion('3.8.0')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 3, 'Major should be 3')
      assertEqual(parsed!.minor, 8, 'Minor should be 8')
      assertEqual(parsed!.patch, 0, 'Patch should be 0')
      assertEqual(parsed!.raw, '3.8.0', 'Raw should be 3.8.0')
    })

    it('should parse version with v prefix', () => {
      const parsed = parseVersion('v3.8.0')
      assert(parsed !== null, 'Should parse version with v prefix')
      assertEqual(parsed!.major, 3, 'Major should be 3')
      assertEqual(parsed!.minor, 8, 'Minor should be 8')
      assertEqual(parsed!.patch, 0, 'Patch should be 0')
    })

    it('should parse major.minor version', () => {
      const parsed = parseVersion('3.8')
      assert(parsed !== null, 'Should parse major.minor')
      assertEqual(parsed!.major, 3, 'Major should be 3')
      assertEqual(parsed!.minor, 8, 'Minor should be 8')
      assertEqual(parsed!.patch, 0, 'Patch should default to 0')
    })

    it('should parse major version only', () => {
      const parsed = parseVersion('3')
      assert(parsed !== null, 'Should parse major only')
      assertEqual(parsed!.major, 3, 'Major should be 3')
      assertEqual(parsed!.minor, 0, 'Minor should default to 0')
      assertEqual(parsed!.patch, 0, 'Patch should default to 0')
    })

    it('should return null for invalid version', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, 'Should return null for invalid')
    })
  })

  describe('isVersionSupported', () => {
    it('should support version 3.x', () => {
      assert(isVersionSupported('3.8.0'), 'Version 3.8.0 should be supported')
      assert(isVersionSupported('3.0.0'), 'Version 3.0.0 should be supported')
    })

    it('should support future major versions', () => {
      assert(isVersionSupported('4.0.0'), 'Version 4.0.0 should be supported')
    })

    it('should not support version 2.x', () => {
      assert(
        !isVersionSupported('2.7.0'),
        'Version 2.7.0 should not be supported',
      )
    })

    it('should not support version 1.x', () => {
      assert(
        !isVersionSupported('1.8.0'),
        'Version 1.8.0 should not be supported',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version', () => {
      assertEqual(getMajorVersion('3.8.0'), '3', 'Should extract 3')
      assertEqual(getMajorVersion('4.0.0'), '4', 'Should extract 4')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('should extract major.minor version', () => {
      assertEqual(getMajorMinorVersion('3.8.0'), '3.8', 'Should extract 3.8')
      assertEqual(getMajorMinorVersion('4.0.1'), '4.0', 'Should extract 4.0')
    })
  })

  describe('compareVersions', () => {
    it('should compare equal versions', () => {
      assertEqual(compareVersions('3.8.0', '3.8.0'), 0, 'Equal versions')
    })

    it('should compare different major versions', () => {
      assertEqual(compareVersions('3.8.0', '4.0.0'), -1, '3.x < 4.x')
      assertEqual(compareVersions('4.0.0', '3.8.0'), 1, '4.x > 3.x')
    })

    it('should compare different minor versions', () => {
      assertEqual(compareVersions('3.7.0', '3.8.0'), -1, '3.7 < 3.8')
      assertEqual(compareVersions('3.8.0', '3.7.0'), 1, '3.8 > 3.7')
    })

    it('should compare different patch versions', () => {
      assertEqual(compareVersions('3.8.0', '3.8.1'), -1, '3.8.0 < 3.8.1')
      assertEqual(compareVersions('3.8.1', '3.8.0'), 1, '3.8.1 > 3.8.0')
    })

    it('should return null for invalid versions', () => {
      assertEqual(compareVersions('invalid', '3.8.0'), null, 'Invalid first')
      assertEqual(compareVersions('3.8.0', 'invalid'), null, 'Invalid second')
    })
  })

  describe('isVersionCompatible', () => {
    it('should be compatible for same major version', () => {
      const result = isVersionCompatible('3.7.0', '3.8.0')
      assert(result.compatible, 'Same major should be compatible')
      assertEqual(result.warning, undefined, 'No warning expected')
    })

    it('should warn when upgrading from older major version', () => {
      const result = isVersionCompatible('3.8.0', '4.0.0')
      assert(result.compatible, 'Should be compatible for upgrade')
      assert(
        result.warning !== undefined,
        'Should have warning for version upgrade',
      )
    })

    it('should not be compatible when downgrading major version', () => {
      const result = isVersionCompatible('4.0.0', '3.8.0')
      assert(!result.compatible, 'Should not be compatible for downgrade')
      assert(result.warning !== undefined, 'Should have warning')
    })
  })

  describe('isValidVersionFormat', () => {
    it('should validate correct formats', () => {
      assert(isValidVersionFormat('3.8.0'), 'Full version should be valid')
      assert(isValidVersionFormat('3.8'), 'Major.minor should be valid')
      assert(isValidVersionFormat('3'), 'Major only should be valid')
    })

    it('should reject invalid formats', () => {
      assert(!isValidVersionFormat('invalid'), 'Text should be invalid')
      assert(!isValidVersionFormat(''), 'Empty should be invalid')
    })
  })
})
