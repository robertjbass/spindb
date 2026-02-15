/**
 * Unit tests for FerretDB version validator
 */

import { describe, it } from 'node:test'
import { assertEqual, assert } from '../utils/assertions'
import {
  FERRETDB_VERSION_MAP,
  DOCUMENTDB_VERSION_MAP,
  normalizeVersion,
  normalizeDocumentDBVersion,
  getFullVersion,
  DEFAULT_DOCUMENTDB_VERSION,
  DEFAULT_V1_POSTGRESQL_VERSION,
  SUPPORTED_MAJOR_VERSIONS,
  isV1,
} from '../../engines/ferretdb/version-maps'

describe('FerretDB Version Maps', () => {
  describe('FERRETDB_VERSION_MAP', () => {
    it('should contain major version 2', () => {
      assert(FERRETDB_VERSION_MAP['2'] !== undefined, 'Should have version 2')
    })

    it('should map major version to full version', () => {
      const fullVersion = FERRETDB_VERSION_MAP['2']
      assert(fullVersion.startsWith('2.'), 'Full version should start with 2.')
    })

    it('should have identity mapping for full versions', () => {
      // Find a full version key (x.y.z format) dynamically
      const fullVersionKey = Object.keys(FERRETDB_VERSION_MAP).find((key) =>
        /^\d+\.\d+\.\d+$/.test(key),
      )
      assert(
        fullVersionKey !== undefined,
        'Should have at least one full version key',
      )
      assertEqual(
        FERRETDB_VERSION_MAP[fullVersionKey!],
        fullVersionKey,
        'Full version should map to itself',
      )
    })
  })

  describe('DOCUMENTDB_VERSION_MAP', () => {
    it('should contain PostgreSQL 17 backend', () => {
      assert(
        DOCUMENTDB_VERSION_MAP['17'] !== undefined,
        'Should have PostgreSQL 17 backend',
      )
    })

    it('should map major version to full version', () => {
      const fullVersion = DOCUMENTDB_VERSION_MAP['17']
      assert(
        fullVersion.startsWith('17-'),
        'Full version should start with 17-',
      )
    })
  })

  describe('normalizeVersion', () => {
    it('should return full version when given major version', () => {
      const result = normalizeVersion('2')
      assert(
        result.startsWith('2.'),
        'Should return full version starting with 2.',
      )
    })

    it('should return same version when given full version', () => {
      const result = normalizeVersion('2.7.0')
      assertEqual(result, '2.7.0', 'Should return same version')
    })

    it('should return unknown versions unchanged', () => {
      const result = normalizeVersion('99')
      // Unknown versions are returned as-is (may cause download failures)
      assertEqual(
        result,
        '99',
        'Should return input unchanged for unknown version',
      )
    })
  })

  describe('normalizeDocumentDBVersion', () => {
    it('should normalize major PostgreSQL version', () => {
      const result = normalizeDocumentDBVersion('17')
      assert(
        result.startsWith('17-'),
        'Should return full version starting with 17-',
      )
    })

    it('should return same version for full version', () => {
      const result = normalizeDocumentDBVersion('17-0.107.0')
      assertEqual(result, '17-0.107.0', 'Should return same version')
    })
  })

  describe('getFullVersion', () => {
    it('should return full version for major version', () => {
      const result = getFullVersion('2')
      assert(result !== null, 'Should return a version')
      assert(result!.startsWith('2.'), 'Should start with 2.')
    })

    it('should return null for unknown version', () => {
      const result = getFullVersion('99')
      assertEqual(result, null, 'Should return null for unknown version')
    })
  })

  describe('DEFAULT_DOCUMENTDB_VERSION', () => {
    it('should be a valid version string', () => {
      assert(
        DEFAULT_DOCUMENTDB_VERSION.includes('-'),
        'Should contain a hyphen separating PG version and DocumentDB version',
      )
    })

    it('should start with PostgreSQL 17', () => {
      assert(
        DEFAULT_DOCUMENTDB_VERSION.startsWith('17-'),
        'Should start with 17-',
      )
    })
  })

  describe('SUPPORTED_MAJOR_VERSIONS', () => {
    it('should include version 1', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.includes('1'),
        'Should include major version 1',
      )
    })

    it('should include version 2', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.includes('2'),
        'Should include major version 2',
      )
    })

    it('should be a non-empty array', () => {
      assert(
        SUPPORTED_MAJOR_VERSIONS.length > 0,
        'Should have at least one version',
      )
    })
  })

  describe('isV1', () => {
    it('should return true for major version 1', () => {
      assert(isV1('1'), 'isV1("1") should be true')
    })

    it('should return true for full v1 version', () => {
      assert(isV1('1.24.2'), 'isV1("1.24.2") should be true')
    })

    it('should return false for major version 2', () => {
      assert(!isV1('2'), 'isV1("2") should be false')
    })

    it('should return false for full v2 version', () => {
      assert(!isV1('2.7.0'), 'isV1("2.7.0") should be false')
    })
  })

  describe('FERRETDB_VERSION_MAP v1 entries', () => {
    it('should contain major version 1', () => {
      assert(FERRETDB_VERSION_MAP['1'] !== undefined, 'Should have version 1')
    })

    it('should map major version 1 to a 1.x full version', () => {
      const fullVersion = FERRETDB_VERSION_MAP['1']
      assert(fullVersion.startsWith('1.'), 'Full version should start with 1.')
    })
  })

  describe('DEFAULT_V1_POSTGRESQL_VERSION', () => {
    it('should be a numeric major version string', () => {
      assert(
        /^\d+$/.test(DEFAULT_V1_POSTGRESQL_VERSION),
        'Should be a numeric major version (e.g., "17")',
      )
    })
  })
})
