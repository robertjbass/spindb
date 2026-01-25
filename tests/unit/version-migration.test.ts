import { describe, it } from 'node:test'
import {
  getMajorVersion,
  getDocumentDBMajorVersion,
  isVersionSupported,
  isDocumentDBVersionSupported,
  getTargetVersion,
  getDocumentDBTargetVersion,
} from '../../core/version-migration'
import { Engine } from '../../types'
import { assert, assertEqual, assertNullish } from '../utils/assertions'

describe('version-migration', () => {
  describe('getMajorVersion', () => {
    describe('PostgreSQL (single digit majors)', () => {
      it('should extract major version from full version', () => {
        const major = getMajorVersion(Engine.PostgreSQL, '17.2.0')
        assertEqual(major, '17', 'Should extract major 17')
      })

      it('should extract major version from 15.x version', () => {
        const major = getMajorVersion(Engine.PostgreSQL, '15.15.0')
        assertEqual(major, '15', 'Should extract major 15')
      })

      it('should return null for unsupported major version', () => {
        const major = getMajorVersion(Engine.PostgreSQL, '12.0.0')
        assertNullish(major, 'PostgreSQL 12 is not supported')
      })
    })

    describe('MySQL (two-part majors)', () => {
      it('should extract major version 8.4', () => {
        const major = getMajorVersion(Engine.MySQL, '8.4.3')
        assertEqual(major, '8.4', 'Should extract major 8.4')
      })

      it('should extract major version 8.0', () => {
        const major = getMajorVersion(Engine.MySQL, '8.0.40')
        assertEqual(major, '8.0', 'Should extract major 8.0')
      })

      it('should extract major version 9.1', () => {
        const major = getMajorVersion(Engine.MySQL, '9.1.0')
        assertEqual(major, '9.1', 'Should extract major 9.1')
      })
    })

    describe('MariaDB (two-part majors)', () => {
      it('should extract major version 10.11', () => {
        const major = getMajorVersion(Engine.MariaDB, '10.11.15')
        assertEqual(major, '10.11', 'Should extract major 10.11')
      })

      it('should extract major version 11.8', () => {
        const major = getMajorVersion(Engine.MariaDB, '11.8.5')
        assertEqual(major, '11.8', 'Should extract major 11.8')
      })
    })

    describe('MongoDB (two-part majors)', () => {
      it('should extract major version 8.0', () => {
        const major = getMajorVersion(Engine.MongoDB, '8.0.17')
        assertEqual(major, '8.0', 'Should extract major 8.0')
      })

      it('should extract major version 7.0', () => {
        const major = getMajorVersion(Engine.MongoDB, '7.0.28')
        assertEqual(major, '7.0', 'Should extract major 7.0')
      })
    })

    describe('Redis (single digit majors)', () => {
      it('should extract major version 7', () => {
        const major = getMajorVersion(Engine.Redis, '7.4.7')
        assertEqual(major, '7', 'Should extract major 7')
      })

      it('should extract major version 8', () => {
        const major = getMajorVersion(Engine.Redis, '8.4.0')
        assertEqual(major, '8', 'Should extract major 8')
      })
    })

    describe('ClickHouse (YY.MM majors)', () => {
      it('should extract major version 25.12', () => {
        const major = getMajorVersion(Engine.ClickHouse, '25.12.3.21')
        assertEqual(major, '25.12', 'Should extract major 25.12')
      })
    })

    describe('Qdrant/Meilisearch (single digit majors)', () => {
      it('should extract major version 1 for Qdrant', () => {
        const major = getMajorVersion(Engine.Qdrant, '1.16.3')
        assertEqual(major, '1', 'Should extract major 1')
      })

      it('should extract major version 1 for Meilisearch', () => {
        const major = getMajorVersion(Engine.Meilisearch, '1.33.1')
        assertEqual(major, '1', 'Should extract major 1')
      })
    })
  })

  describe('getDocumentDBMajorVersion', () => {
    it('should extract major version from DocumentDB version', () => {
      const major = getDocumentDBMajorVersion('17-0.107.0')
      assertEqual(major, '17', 'Should extract major 17')
    })

    it('should return null for invalid format', () => {
      const major = getDocumentDBMajorVersion('invalid')
      assertNullish(major, 'Invalid format should return null')
    })

    it('should return null for unsupported major', () => {
      const major = getDocumentDBMajorVersion('16-0.107.0')
      assertNullish(major, 'PostgreSQL 16 backend is not supported')
    })
  })

  describe('isVersionSupported', () => {
    it('should return true for current PostgreSQL version', () => {
      const supported = isVersionSupported(Engine.PostgreSQL, '17.7.0')
      assert(supported, 'PostgreSQL 17.7.0 should be supported')
    })

    it('should return false for outdated PostgreSQL version', () => {
      const supported = isVersionSupported(Engine.PostgreSQL, '17.2.0')
      assert(!supported, 'PostgreSQL 17.2.0 should not be supported (outdated)')
    })

    it('should return true for current MySQL version', () => {
      const supported = isVersionSupported(Engine.MySQL, '8.4.3')
      assert(supported, 'MySQL 8.4.3 should be supported')
    })

    it('should return false for outdated MySQL version', () => {
      const supported = isVersionSupported(Engine.MySQL, '8.4.0')
      assert(!supported, 'MySQL 8.4.0 should not be supported (outdated)')
    })

    it('should return true for current Redis version', () => {
      const supported = isVersionSupported(Engine.Redis, '7.4.7')
      assert(supported, 'Redis 7.4.7 should be supported')
    })

    it('should return false for outdated Redis version', () => {
      const supported = isVersionSupported(Engine.Redis, '7.2.0')
      assert(!supported, 'Redis 7.2.0 should not be supported (outdated)')
    })
  })

  describe('isDocumentDBVersionSupported', () => {
    it('should return true for current DocumentDB version', () => {
      const supported = isDocumentDBVersionSupported('17-0.107.0')
      assert(supported, 'DocumentDB 17-0.107.0 should be supported')
    })

    it('should return false for outdated DocumentDB version', () => {
      const supported = isDocumentDBVersionSupported('17-0.100.0')
      assert(!supported, 'DocumentDB 17-0.100.0 should not be supported')
    })
  })

  describe('getTargetVersion', () => {
    it('should return target version for PostgreSQL major 17', () => {
      const target = getTargetVersion(Engine.PostgreSQL, '17')
      assertEqual(target, '17.7.0', 'Should target 17.7.0')
    })

    it('should return target version for PostgreSQL major 16', () => {
      const target = getTargetVersion(Engine.PostgreSQL, '16')
      assertEqual(target, '16.11.0', 'Should target 16.11.0')
    })

    it('should return target version for MySQL major 8.4', () => {
      const target = getTargetVersion(Engine.MySQL, '8.4')
      assertEqual(target, '8.4.3', 'Should target 8.4.3')
    })

    it('should return target version for MySQL major 8.0', () => {
      const target = getTargetVersion(Engine.MySQL, '8.0')
      assertEqual(target, '8.0.40', 'Should target 8.0.40')
    })

    it('should return target version for Redis major 7', () => {
      const target = getTargetVersion(Engine.Redis, '7')
      assertEqual(target, '7.4.7', 'Should target 7.4.7')
    })

    it('should return null for unsupported major version', () => {
      const target = getTargetVersion(Engine.PostgreSQL, '12')
      assertNullish(target, 'PostgreSQL 12 is not supported')
    })
  })

  describe('getDocumentDBTargetVersion', () => {
    it('should return target version for DocumentDB major 17', () => {
      const target = getDocumentDBTargetVersion('17')
      assertEqual(target, '17-0.107.0', 'Should target 17-0.107.0')
    })

    it('should return null for unsupported major version', () => {
      const target = getDocumentDBTargetVersion('16')
      assertNullish(target, 'DocumentDB 16 is not supported')
    })
  })
})

describe('test container detection patterns', () => {
  // Test patterns match various test container naming conventions
  const TEST_CONTAINER_PATTERNS = [
    /^.+-test_[0-9a-f]{6,}$/i,
    /^.+-test-.+_[0-9a-f]{6,}$/i,
    /^.+-test-renamed[-_][0-9a-f]{6,}$/i,
  ]

  function isTestContainer(name: string): boolean {
    return TEST_CONTAINER_PATTERNS.some((pattern) => pattern.test(name))
  }

  it('should match pattern: name-test_<hex>', () => {
    assert(isTestContainer('duckdb-test_04b0613f'), 'Should match duckdb-test_04b0613f')
    assert(isTestContainer('postgres-test_abcd1234'), 'Should match postgres-test_abcd1234')
    assert(isTestContainer('mysql-test_AABBCC'), 'Should match mysql-test_AABBCC (case insensitive)')
  })

  it('should match pattern: name-test-suffix_<hex>', () => {
    assert(
      isTestContainer('ferretdb-test-conflict_21e4d447'),
      'Should match ferretdb-test-conflict_21e4d447',
    )
    assert(
      isTestContainer('postgres-test-backup_12345678'),
      'Should match postgres-test-backup_12345678',
    )
  })

  it('should match pattern: name-test-renamed_<hex>', () => {
    assert(
      isTestContainer('mysql-test-renamed_1862f018'),
      'Should match mysql-test-renamed_1862f018',
    )
    assert(
      isTestContainer('duckdb-test-renamed-80a8a099'),
      'Should match duckdb-test-renamed-80a8a099',
    )
  })

  it('should not match regular container names', () => {
    assert(!isTestContainer('myapp'), 'Should not match myapp')
    assert(!isTestContainer('production-db'), 'Should not match production-db')
    assert(!isTestContainer('test-app'), 'Should not match test-app (no hex suffix)')
    assert(!isTestContainer('dev-test'), 'Should not match dev-test (no hex suffix)')
  })

  it('should not match short hex suffixes', () => {
    assert(!isTestContainer('db-test_abc'), 'Should not match db-test_abc (hex too short)')
    assert(!isTestContainer('db-test_12345'), 'Should not match db-test_12345 (hex too short)')
  })
})
