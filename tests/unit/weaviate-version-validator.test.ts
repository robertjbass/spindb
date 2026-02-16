/**
 * Weaviate version validator unit tests
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
} from '../../engines/weaviate/version-validator'

describe('Weaviate Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const parsed = parseVersion('1.35.7')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 1, 'Major should be 1')
      assertEqual(parsed!.minor, 35, 'Minor should be 35')
      assertEqual(parsed!.patch, 7, 'Patch should be 7')
      assertEqual(parsed!.raw, '1.35.7', 'Raw should be 1.35.7')
    })

    it('should parse version with v prefix', () => {
      const parsed = parseVersion('v1.35.7')
      assert(parsed !== null, 'Should parse version with v prefix')
      assertEqual(parsed!.major, 1, 'Major should be 1')
      assertEqual(parsed!.minor, 35, 'Minor should be 35')
      assertEqual(parsed!.patch, 7, 'Patch should be 7')
    })

    it('should parse major.minor version', () => {
      const parsed = parseVersion('1.35')
      assert(parsed !== null, 'Should parse major.minor')
      assertEqual(parsed!.major, 1, 'Major should be 1')
      assertEqual(parsed!.minor, 35, 'Minor should be 35')
      assertEqual(parsed!.patch, 0, 'Patch should default to 0')
    })

    it('should parse major version only', () => {
      const parsed = parseVersion('1')
      assert(parsed !== null, 'Should parse major only')
      assertEqual(parsed!.major, 1, 'Major should be 1')
      assertEqual(parsed!.minor, 0, 'Minor should default to 0')
      assertEqual(parsed!.patch, 0, 'Patch should default to 0')
    })

    it('should return null for invalid version', () => {
      const parsed = parseVersion('invalid')
      assertEqual(parsed, null, 'Should return null for invalid')
    })
  })

  describe('isVersionSupported', () => {
    it('should support version 1.x', () => {
      assert(isVersionSupported('1.35.7'), 'Version 1.35.7 should be supported')
      assert(isVersionSupported('1.0.0'), 'Version 1.0.0 should be supported')
    })

    it('should support future major versions', () => {
      assert(isVersionSupported('2.0.0'), 'Version 2.0.0 should be supported')
    })

    it('should not support version 0.x', () => {
      assert(
        !isVersionSupported('0.9.0'),
        'Version 0.9.0 should not be supported',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version', () => {
      assertEqual(getMajorVersion('1.35.7'), '1', 'Should extract 1')
      assertEqual(getMajorVersion('2.0.0'), '2', 'Should extract 2')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('should extract major.minor version', () => {
      assertEqual(getMajorMinorVersion('1.35.7'), '1.35', 'Should extract 1.35')
      assertEqual(getMajorMinorVersion('2.0.1'), '2.0', 'Should extract 2.0')
    })
  })

  describe('compareVersions', () => {
    it('should compare equal versions', () => {
      assertEqual(compareVersions('1.35.7', '1.35.7'), 0, 'Equal versions')
    })

    it('should compare different major versions', () => {
      assertEqual(compareVersions('1.35.7', '2.0.0'), -1, '1.x < 2.x')
      assertEqual(compareVersions('2.0.0', '1.35.7'), 1, '2.x > 1.x')
    })

    it('should compare different minor versions', () => {
      assertEqual(compareVersions('1.34.0', '1.35.0'), -1, '1.34 < 1.35')
      assertEqual(compareVersions('1.35.0', '1.34.0'), 1, '1.35 > 1.34')
    })

    it('should compare different patch versions', () => {
      assertEqual(compareVersions('1.35.6', '1.35.7'), -1, '1.35.6 < 1.35.7')
      assertEqual(compareVersions('1.35.7', '1.35.6'), 1, '1.35.7 > 1.35.6')
    })

    it('should return null for invalid versions', () => {
      assertEqual(compareVersions('invalid', '1.35.7'), null, 'Invalid first')
      assertEqual(compareVersions('1.35.7', 'invalid'), null, 'Invalid second')
    })
  })

  describe('isVersionCompatible', () => {
    it('should be compatible for same major version', () => {
      const result = isVersionCompatible('1.34.0', '1.35.7')
      assert(result.compatible, 'Same major should be compatible')
      assertEqual(result.warning, undefined, 'No warning expected')
    })

    it('should warn when upgrading from older major version', () => {
      const result = isVersionCompatible('1.35.7', '2.0.0')
      assert(result.compatible, 'Should be compatible for upgrade')
      assert(
        result.warning !== undefined,
        'Should have warning for version upgrade',
      )
    })

    it('should not be compatible when downgrading major version', () => {
      const result = isVersionCompatible('2.0.0', '1.35.7')
      assert(!result.compatible, 'Should not be compatible for downgrade')
      assert(result.warning !== undefined, 'Should have warning')
    })
  })

  describe('isValidVersionFormat', () => {
    it('should validate correct formats', () => {
      assert(isValidVersionFormat('1.35.7'), 'Full version should be valid')
      assert(isValidVersionFormat('1.35'), 'Major.minor should be valid')
      assert(isValidVersionFormat('1'), 'Major only should be valid')
    })

    it('should reject invalid formats', () => {
      assert(!isValidVersionFormat('invalid'), 'Text should be invalid')
      assert(!isValidVersionFormat(''), 'Empty should be invalid')
    })
  })
})
