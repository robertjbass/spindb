/**
 * TigerBeetle version validator unit tests
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
} from '../../engines/tigerbeetle/version-validator'

describe('TigerBeetle Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const parsed = parseVersion('0.16.70')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 0, 'Major should be 0')
      assertEqual(parsed!.minor, 16, 'Minor should be 16')
      assertEqual(parsed!.patch, 70, 'Patch should be 70')
      assertEqual(parsed!.raw, '0.16.70', 'Raw should be 0.16.70')
    })

    it('should parse version with v prefix', () => {
      const parsed = parseVersion('v0.16.70')
      assert(parsed !== null, 'Should parse version with v prefix')
      assertEqual(parsed!.major, 0, 'Major should be 0')
      assertEqual(parsed!.minor, 16, 'Minor should be 16')
      assertEqual(parsed!.patch, 70, 'Patch should be 70')
    })

    it('should parse major.minor version', () => {
      const parsed = parseVersion('0.16')
      assert(parsed !== null, 'Should parse major.minor')
      assertEqual(parsed!.major, 0, 'Major should be 0')
      assertEqual(parsed!.minor, 16, 'Minor should be 16')
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

    it('should return null for empty string', () => {
      const parsed = parseVersion('')
      assertEqual(parsed, null, 'Should return null for empty string')
    })
  })

  describe('isVersionSupported', () => {
    it('should support version 0.16.x', () => {
      assert(
        isVersionSupported('0.16.70'),
        'Version 0.16.70 should be supported',
      )
      assert(isVersionSupported('0.16.0'), 'Version 0.16.0 should be supported')
    })

    it('should support future minor versions', () => {
      assert(isVersionSupported('0.17.0'), 'Version 0.17.0 should be supported')
    })

    it('should support future major versions', () => {
      assert(isVersionSupported('1.0.0'), 'Version 1.0.0 should be supported')
    })

    it('should not support version 0.15.x and below', () => {
      assert(
        !isVersionSupported('0.15.0'),
        'Version 0.15.0 should not be supported',
      )
      assert(
        !isVersionSupported('0.1.0'),
        'Version 0.1.0 should not be supported',
      )
    })
  })

  describe('getMajorVersion', () => {
    it('should extract xy-format major version', () => {
      assertEqual(getMajorVersion('0.16.70'), '0.16', 'Should extract 0.16')
      assertEqual(getMajorVersion('1.0.0'), '1.0', 'Should extract 1.0')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('should extract major.minor version (same as getMajorVersion for xy-format)', () => {
      assertEqual(
        getMajorMinorVersion('0.16.70'),
        '0.16',
        'Should extract 0.16',
      )
    })
  })

  describe('compareVersions', () => {
    it('should compare equal versions', () => {
      assertEqual(compareVersions('0.16.70', '0.16.70'), 0, 'Equal versions')
    })

    it('should compare different major versions', () => {
      assertEqual(compareVersions('0.16.70', '1.0.0'), -1, '0.x < 1.x')
      assertEqual(compareVersions('1.0.0', '0.16.70'), 1, '1.x > 0.x')
    })

    it('should compare different minor versions', () => {
      assertEqual(compareVersions('0.15.0', '0.16.0'), -1, '0.15 < 0.16')
      assertEqual(compareVersions('0.16.0', '0.15.0'), 1, '0.16 > 0.15')
    })

    it('should compare different patch versions', () => {
      assertEqual(
        compareVersions('0.16.69', '0.16.70'),
        -1,
        '0.16.69 < 0.16.70',
      )
      assertEqual(compareVersions('0.16.70', '0.16.69'), 1, '0.16.70 > 0.16.69')
    })

    it('should return null for invalid versions', () => {
      assertEqual(compareVersions('invalid', '0.16.70'), null, 'Invalid first')
      assertEqual(compareVersions('0.16.70', 'invalid'), null, 'Invalid second')
    })
  })

  describe('isVersionCompatible', () => {
    it('should be compatible for same major.minor version', () => {
      const result = isVersionCompatible('0.16.70', '0.16.70')
      assert(result.compatible, 'Same version should be compatible')
      assertEqual(result.warning, undefined, 'No warning expected')
    })

    it('should be compatible for same major.minor with different patch', () => {
      const result = isVersionCompatible('0.16.69', '0.16.70')
      assert(result.compatible, 'Same minor should be compatible')
    })

    it('should not be compatible across minor versions', () => {
      const result = isVersionCompatible('0.16.70', '0.17.0')
      assert(!result.compatible, 'Different minor should not be compatible')
      assert(result.warning !== undefined, 'Should have warning')
    })

    it('should not be compatible across major versions', () => {
      const result = isVersionCompatible('0.16.70', '1.0.0')
      assert(!result.compatible, 'Different major should not be compatible')
    })
  })

  describe('isValidVersionFormat', () => {
    it('should validate correct formats', () => {
      assert(isValidVersionFormat('0.16.70'), 'Full version should be valid')
      assert(isValidVersionFormat('0.16'), 'Major.minor should be valid')
      assert(isValidVersionFormat('1'), 'Major only should be valid')
    })

    it('should reject invalid formats', () => {
      assert(!isValidVersionFormat('invalid'), 'Text should be invalid')
      assert(!isValidVersionFormat(''), 'Empty should be invalid')
    })
  })
})
