/**
 * Unit tests for version-validator module
 */

import { describe, it } from 'node:test'
import {
  parseToolVersion,
  checkVersionCompatibility,
  type VersionInfo,
} from '../../engines/postgresql/version-validator'
import { assert, assertEqual } from '../integration/helpers'

describe('parseToolVersion', () => {
  it('should parse standard PostgreSQL version', () => {
    const version = parseToolVersion('pg_restore (PostgreSQL) 16.1')

    assertEqual(version.major, 16, 'Major version should be 16')
    assertEqual(version.minor, 1, 'Minor version should be 1')
    assertEqual(version.patch, 0, 'Patch version should default to 0')
    assertEqual(version.full, '16.1', 'Full version should be 16.1')
  })

  it('should parse version with three components', () => {
    const version = parseToolVersion('pg_dump (PostgreSQL) 14.9.1')

    assertEqual(version.major, 14, 'Major version should be 14')
    assertEqual(version.minor, 9, 'Minor version should be 9')
    assertEqual(version.patch, 1, 'Patch version should be 1')
    assertEqual(version.full, '14.9.1', 'Full version should be 14.9.1')
  })

  it('should parse Homebrew version string', () => {
    const version = parseToolVersion('pg_restore (PostgreSQL) 14.9 (Homebrew)')

    assertEqual(version.major, 14, 'Major version should be 14')
    assertEqual(version.minor, 9, 'Minor version should be 9')
    assertEqual(version.full, '14.9', 'Full version should be 14.9')
  })

  it('should parse version with extra text', () => {
    const version = parseToolVersion(
      'psql (PostgreSQL) 17.0 (Ubuntu 17.0-1.pgdg22.04+1)',
    )

    assertEqual(version.major, 17, 'Major version should be 17')
    assertEqual(version.minor, 0, 'Minor version should be 0')
  })

  it('should throw on invalid version string', () => {
    let threw = false
    try {
      parseToolVersion('no version here')
    } catch (error) {
      threw = true
      assert(
        (error as Error).message.includes('Cannot parse version'),
        'Error should mention parsing failure',
      )
    }

    assert(threw, 'Should throw on invalid input')
  })

  it('should throw on empty string', () => {
    let threw = false
    try {
      parseToolVersion('')
    } catch {
      threw = true
    }

    assert(threw, 'Should throw on empty string')
  })
})

describe('checkVersionCompatibility', () => {
  const createVersion = (major: number, minor = 0, patch = 0): VersionInfo => ({
    major,
    minor,
    patch,
    full: `${major}.${minor}.${patch}`,
  })

  describe('compatible scenarios', () => {
    it('should be compatible when versions match exactly', () => {
      const dumpVersion = createVersion(16, 1)
      const toolVersion = createVersion(16, 1)

      const result = checkVersionCompatibility(dumpVersion, toolVersion)

      assert(result.compatible, 'Same versions should be compatible')
      assert(result.error === undefined, 'Should have no error')
      assert(result.warning === undefined, 'Should have no warning')
    })

    it('should be compatible when tool is newer than dump (backwards compat)', () => {
      const dumpVersion = createVersion(14)
      const toolVersion = createVersion(16)

      const result = checkVersionCompatibility(dumpVersion, toolVersion)

      assert(
        result.compatible,
        'Newer tool should be compatible with older dump',
      )
      assert(result.error === undefined, 'Should have no error')
    })

    it('should be compatible with same major, different minor', () => {
      const dumpVersion = createVersion(16, 0)
      const toolVersion = createVersion(16, 2)

      const result = checkVersionCompatibility(dumpVersion, toolVersion)

      assert(result.compatible, 'Same major version should be compatible')
    })

    it('should be compatible when dump version is null', () => {
      const toolVersion = createVersion(16)

      const result = checkVersionCompatibility(null, toolVersion)

      assert(result.compatible, 'Unknown dump version should be compatible')
      assert(
        result.warning !== undefined,
        'Should have warning about unknown version',
      )
      assert(
        result.warning!.includes('Could not detect'),
        'Warning should mention detection',
      )
    })
  })

  describe('incompatible scenarios', () => {
    it('should be incompatible when dump is newer than tool', () => {
      const dumpVersion = createVersion(17)
      const toolVersion = createVersion(15)

      const result = checkVersionCompatibility(dumpVersion, toolVersion)

      assert(
        !result.compatible,
        'Older tool should be incompatible with newer dump',
      )
      assert(result.error !== undefined, 'Should have error message')
      assert(result.error!.includes('17'), 'Error should mention dump version')
      assert(result.error!.includes('15'), 'Error should mention tool version')
      assert(
        result.error!.includes('Install'),
        'Error should suggest installing',
      )
    })

    it('should be incompatible even when dump is only 1 major version newer', () => {
      const dumpVersion = createVersion(17)
      const toolVersion = createVersion(16)

      const result = checkVersionCompatibility(dumpVersion, toolVersion)

      assert(
        !result.compatible,
        'Dump one version newer should be incompatible',
      )
    })
  })

  describe('warning scenarios', () => {
    it('should warn when dump is very old (3+ major versions)', () => {
      const dumpVersion = createVersion(12)
      const toolVersion = createVersion(16)

      const result = checkVersionCompatibility(dumpVersion, toolVersion)

      assert(result.compatible, 'Should still be compatible')
      assert(result.warning !== undefined, 'Should have warning')
      assert(
        result.warning!.includes('12'),
        'Warning should mention old version',
      )
    })

    it('should not warn when dump is only 2 major versions old', () => {
      const dumpVersion = createVersion(14)
      const toolVersion = createVersion(16)

      const result = checkVersionCompatibility(dumpVersion, toolVersion)

      assert(result.compatible, 'Should be compatible')
      assert(
        result.warning === undefined,
        'Should not warn for 2 version difference',
      )
    })
  })

  describe('edge cases', () => {
    it('should handle version 10 correctly', () => {
      const dumpVersion = createVersion(10)
      const toolVersion = createVersion(16)

      const result = checkVersionCompatibility(dumpVersion, toolVersion)

      assert(result.compatible, 'Should be compatible')
      assert(result.warning !== undefined, 'Should warn about very old version')
    })

    it('should return correct versions in result', () => {
      const dumpVersion = createVersion(15, 3, 1)
      const toolVersion = createVersion(16, 1, 0)

      const result = checkVersionCompatibility(dumpVersion, toolVersion)

      assertEqual(result.dumpVersion!.major, 15, 'Should return dump version')
      assertEqual(result.toolVersion.major, 16, 'Should return tool version')
    })

    it('should handle null dump version correctly', () => {
      const toolVersion = createVersion(16)

      const result = checkVersionCompatibility(null, toolVersion)

      assertEqual(
        result.dumpVersion,
        null,
        'Null dump should remain null in result',
      )
      assert(
        result.compatible,
        'Should be compatible when dump version unknown',
      )
      assert(
        result.warning !== undefined,
        'Should have warning when version unknown',
      )
    })
  })
})
