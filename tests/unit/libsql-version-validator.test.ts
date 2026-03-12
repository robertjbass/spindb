/**
 * libSQL version validator unit tests
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../utils/assertions'
import {
  LIBSQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
  getFullVersion,
  normalizeVersion,
} from '../../engines/libsql/version-maps'
import {
  parseVersion,
  isVersionSupported,
  getMajorVersion,
  getMajorMinorVersion,
  compareVersions,
  isVersionCompatible,
  isValidVersionFormat,
} from '../../engines/libsql/version-validator'

describe('libSQL Version Maps', () => {
  describe('LIBSQL_VERSION_MAP', () => {
    it('should contain major version 0', () => {
      assert(LIBSQL_VERSION_MAP['0'] !== undefined, 'Should have version 0')
    })

    it('should map major version to full version', () => {
      const fullVersion = LIBSQL_VERSION_MAP['0']
      assert(fullVersion.startsWith('0.'), 'Full version should start with 0.')
    })

    it('should have identity mapping for full versions', () => {
      const fullVersionKey = Object.keys(LIBSQL_VERSION_MAP).find((key) =>
        /^\d+\.\d+\.\d+$/.test(key),
      )
      assert(
        fullVersionKey !== undefined,
        'Should have at least one full version key',
      )
      assertEqual(
        LIBSQL_VERSION_MAP[fullVersionKey!],
        fullVersionKey,
        'Full version should map to itself',
      )
    })

    it('should map major.minor to full version', () => {
      const result = LIBSQL_VERSION_MAP['0.24']
      assert(result !== undefined, 'Should have 0.24 mapping')
      assert(result.startsWith('0.24.'), 'Should map to a 0.24.x version')
    })
  })

  describe('normalizeVersion', () => {
    it('should return full version when given major version', () => {
      const result = normalizeVersion('0')
      assert(
        result.startsWith('0.'),
        'Should return full version starting with 0.',
      )
    })

    it('should return full version when given major.minor version', () => {
      const result = normalizeVersion('0.24')
      assert(
        result.startsWith('0.24.'),
        'Should return full version starting with 0.24.',
      )
    })

    it('should return same version when given full version', () => {
      const result = normalizeVersion('0.24.32')
      assertEqual(result, '0.24.32', 'Should return same version')
    })

    it('should return unknown versions unchanged', () => {
      const result = normalizeVersion('99')
      assertEqual(
        result,
        '99',
        'Should return input unchanged for unknown version',
      )
    })

    it('should return invalid format unchanged', () => {
      const result = normalizeVersion('invalid')
      assertEqual(
        result,
        'invalid',
        'Should return input unchanged for invalid format',
      )
    })
  })

  describe('getFullVersion', () => {
    it('should return full version for major version', () => {
      const result = getFullVersion('0')
      assert(result !== null, 'Should return a version')
      assert(result!.startsWith('0.'), 'Should start with 0.')
    })

    it('should return full version for major.minor version', () => {
      const result = getFullVersion('0.24')
      assert(result !== null, 'Should return a version')
      assert(result!.startsWith('0.24.'), 'Should start with 0.24.')
    })

    it('should return full version for exact version', () => {
      const result = getFullVersion('0.24.32')
      assertEqual(result, '0.24.32', 'Should return exact version')
    })

    it('should return null for unknown version', () => {
      const result = getFullVersion('99')
      assertEqual(result, null, 'Should return null for unknown version')
    })

    it('should return null for unmapped major.minor version', () => {
      const result = getFullVersion('0.99')
      assertEqual(
        result,
        null,
        'Should return null for unmapped major.minor version',
      )
    })
  })

  describe('SUPPORTED_MAJOR_VERSIONS', () => {
    it('should include version 0', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.includes('0'),
        'Should include major version 0',
      )
    })

    it('should be a non-empty array', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.length > 0,
        'Should have at least one version',
      )
    })
  })
})

describe('libSQL Version Validator', () => {
  describe('parseVersion', () => {
    it('should parse full version string', () => {
      const parsed = parseVersion('0.24.32')
      assert(parsed !== null, 'Should parse version')
      assertEqual(parsed!.major, 0, 'Major should be 0')
      assertEqual(parsed!.minor, 24, 'Minor should be 24')
      assertEqual(parsed!.patch, 32, 'Patch should be 32')
      assertEqual(parsed!.raw, '0.24.32', 'Raw should be 0.24.32')
    })

    it('should parse version with v prefix', () => {
      const parsed = parseVersion('v0.24.32')
      assert(parsed !== null, 'Should parse version with v prefix')
      assertEqual(parsed!.major, 0, 'Major should be 0')
      assertEqual(parsed!.minor, 24, 'Minor should be 24')
      assertEqual(parsed!.patch, 32, 'Patch should be 32')
    })

    it('should parse major.minor version', () => {
      const parsed = parseVersion('0.24')
      assert(parsed !== null, 'Should parse major.minor')
      assertEqual(parsed!.major, 0, 'Major should be 0')
      assertEqual(parsed!.minor, 24, 'Minor should be 24')
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
      assertEqual(parseVersion('invalid'), null, 'Should return null')
    })

    it('should return null for empty string', () => {
      assertEqual(parseVersion(''), null, 'Should return null for empty')
    })
  })

  describe('isVersionSupported', () => {
    it('should support version 0.24.x', () => {
      assert(isVersionSupported('0.24.32'), '0.24.32 should be supported')
      assert(isVersionSupported('0.24.0'), '0.24.0 should be supported')
    })

    it('should support future minor versions', () => {
      assert(isVersionSupported('0.25.0'), '0.25.0 should be supported')
    })

    it('should support future major versions', () => {
      assert(isVersionSupported('1.0.0'), '1.0.0 should be supported')
    })

    it('should not support version 0.23.x and below', () => {
      assert(!isVersionSupported('0.23.0'), '0.23.0 should not be supported')
      assert(!isVersionSupported('0.1.0'), '0.1.0 should not be supported')
    })
  })

  describe('getMajorVersion', () => {
    it('should extract major version', () => {
      assertEqual(getMajorVersion('0.24.32'), '0', 'Should extract 0')
      assertEqual(getMajorVersion('1.0.0'), '1', 'Should extract 1')
    })
  })

  describe('getMajorMinorVersion', () => {
    it('should extract major.minor version', () => {
      assertEqual(
        getMajorMinorVersion('0.24.32'),
        '0.24',
        'Should extract 0.24',
      )
    })
  })

  describe('compareVersions', () => {
    it('should compare equal versions', () => {
      assertEqual(compareVersions('0.24.32', '0.24.32'), 0, 'Equal versions')
    })

    it('should compare different major versions', () => {
      assertEqual(compareVersions('0.24.32', '1.0.0'), -1, '0.x < 1.x')
      assertEqual(compareVersions('1.0.0', '0.24.32'), 1, '1.x > 0.x')
    })

    it('should compare different minor versions', () => {
      assertEqual(compareVersions('0.23.0', '0.24.0'), -1, '0.23 < 0.24')
      assertEqual(compareVersions('0.24.0', '0.23.0'), 1, '0.24 > 0.23')
    })

    it('should compare different patch versions', () => {
      assertEqual(compareVersions('0.24.31', '0.24.32'), -1, '.31 < .32')
      assertEqual(compareVersions('0.24.32', '0.24.31'), 1, '.32 > .31')
    })

    it('should return null for invalid versions', () => {
      assertEqual(compareVersions('invalid', '0.24.32'), null, 'Invalid first')
      assertEqual(compareVersions('0.24.32', 'invalid'), null, 'Invalid second')
    })
  })

  describe('isVersionCompatible', () => {
    it('should be compatible for same version', () => {
      const result = isVersionCompatible('0.24.32', '0.24.32')
      assert(result.compatible, 'Same version should be compatible')
      assertEqual(result.warning, undefined, 'No warning expected')
    })

    it('should warn when upgrading from older major version', () => {
      const result = isVersionCompatible('0.24.32', '1.0.0')
      assert(result.compatible, 'Should be compatible')
      assert(result.warning !== undefined, 'Should have warning')
    })

    it('should not be compatible when downgrading major version', () => {
      const result = isVersionCompatible('1.0.0', '0.24.32')
      assert(!result.compatible, 'Should not be compatible')
    })
  })

  describe('isValidVersionFormat', () => {
    it('should validate correct formats', () => {
      assert(isValidVersionFormat('0.24.32'), 'Full version should be valid')
      assert(isValidVersionFormat('0.24'), 'Major.minor should be valid')
      assert(isValidVersionFormat('1'), 'Major only should be valid')
    })

    it('should reject invalid formats', () => {
      assert(!isValidVersionFormat('invalid'), 'Text should be invalid')
      assert(!isValidVersionFormat(''), 'Empty should be invalid')
    })
  })
})
