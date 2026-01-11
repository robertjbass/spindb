import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseToolVersion,
  parseDumpVersion,
  checkVersionCompatibility,
} from '../../engines/mysql/version-validator'
import type {
  VersionInfo,
  DumpInfo,
} from '../../engines/mysql/version-validator'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mysqlFixturesDir = path.join(__dirname, '../fixtures/mysql/dumps')
const mariadbFixturesDir = path.join(__dirname, '../fixtures/mariadb/dumps')
// Alias for backward compatibility in existing tests
const fixturesDir = mysqlFixturesDir

// =============================================================================
// parseToolVersion Tests
// =============================================================================

describe('parseToolVersion', () => {
  it('should parse MySQL version string', () => {
    const result = parseToolVersion(
      'mysql  Ver 8.0.35 for macos14.0 on arm64 (Homebrew)',
    )
    assert.equal(result.version.major, 8)
    assert.equal(result.version.minor, 0)
    assert.equal(result.version.patch, 35)
    assert.equal(result.variant, 'mysql')
  })

  it('should parse MariaDB version string with Distrib', () => {
    const result = parseToolVersion(
      'mysql  Ver 15.1 Distrib 10.11.6-MariaDB, for osx10.19 (arm64)',
    )
    assert.equal(result.version.major, 10)
    assert.equal(result.version.minor, 11)
    assert.equal(result.version.patch, 6)
    assert.equal(result.variant, 'mariadb')
  })

  it('should parse newer MariaDB version string with from', () => {
    const result = parseToolVersion(
      'mysql from 11.4.3-MariaDB, client 15.2 for osx10.20 (arm64)',
    )
    assert.equal(result.version.major, 11)
    assert.equal(result.version.minor, 4)
    assert.equal(result.version.patch, 3)
    assert.equal(result.variant, 'mariadb')
  })

  it('should parse MySQL version without patch number', () => {
    const result = parseToolVersion('mysql  Ver 8.0 for linux on x86_64')
    assert.equal(result.version.major, 8)
    assert.equal(result.version.minor, 0)
    assert.equal(result.version.patch, 0)
    assert.equal(result.variant, 'mysql')
  })

  it('should parse MySQL 5.7 version string', () => {
    const result = parseToolVersion(
      'mysql  Ver 14.14 Distrib 5.7.44, for Linux (x86_64)',
    )
    assert.equal(result.version.major, 5)
    assert.equal(result.version.minor, 7)
    assert.equal(result.version.patch, 44)
    assert.equal(result.variant, 'mysql')
  })

  it('should throw on invalid version string', () => {
    assert.throws(() => parseToolVersion('mysql version unknown'), {
      message: /Cannot parse version/,
    })
  })
})

// =============================================================================
// parseDumpVersion Tests
// =============================================================================

describe('parseDumpVersion', () => {
  describe('MySQL dumps', () => {
    it('should parse MySQL 8.0 dump file header', async () => {
      const dumpPath = path.join(fixturesDir, 'mysql-8.0-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mysql')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 8)
      assert.equal(result.version?.minor, 0)
      assert.equal(result.version?.patch, 36)
    })

    it('should parse MySQL 8.4 dump file header', async () => {
      const dumpPath = path.join(fixturesDir, 'mysql-8.4-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mysql')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 8)
      assert.equal(result.version?.minor, 4)
      assert.equal(result.version?.patch, 3)
    })

    it('should parse MySQL 9 dump file header', async () => {
      const dumpPath = path.join(fixturesDir, 'mysql-9-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mysql')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 9)
      assert.equal(result.version?.minor, 0)
      assert.equal(result.version?.patch, 1)
    })

    it('should extract server version from MySQL dump', async () => {
      const dumpPath = path.join(fixturesDir, 'mysql-8.0-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      // Server version line: "-- Server version	8.0.36"
      assert.ok(result.serverVersion?.includes('8.0.36'))
    })
  })

  describe('MariaDB dumps', () => {
    it('should parse MariaDB 10.11 dump file header', async () => {
      const dumpPath = path.join(mariadbFixturesDir, 'mariadb-10.11-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mariadb')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 10)
      assert.equal(result.version?.minor, 11)
      assert.equal(result.version?.patch, 6)
    })

    it('should parse MariaDB 11.4 dump file header', async () => {
      const dumpPath = path.join(mariadbFixturesDir, 'mariadb-11.4-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      assert.equal(result.variant, 'mariadb')
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 11)
      assert.equal(result.version?.minor, 4)
      assert.equal(result.version?.patch, 3)
    })

    it('should detect MariaDB variant from header', async () => {
      const dumpPath = path.join(mariadbFixturesDir, 'mariadb-10.11-plain.sql')
      const result = await parseDumpVersion(dumpPath)

      // Should detect from "MariaDB dump" or "-MariaDB" in header
      assert.equal(result.variant, 'mariadb')
    })
  })

  describe('error handling', () => {
    it('should return null version for non-existent file', async () => {
      const result = await parseDumpVersion('/nonexistent/path/dump.sql')

      assert.equal(result.version, null)
      assert.equal(result.variant, 'unknown')
    })

    it('should parse version from non-dump files containing dump headers', async () => {
      // Tests that parseDumpVersion can extract version info from files
      // that contain dump headers in the first 30 lines but aren't actual dumps
      const result = await parseDumpVersion(
        path.join(fixturesDir, 'embedded-header-example.txt'),
      )

      // Should parse the example dump header
      // Example: "-- MySQL dump 10.13  Distrib 8.0.36, for macos14.2 (arm64)"
      assert.notEqual(result.version, null)
      assert.equal(result.version?.major, 8)
      assert.equal(result.version?.minor, 0)
    })
  })
})

// =============================================================================
// checkVersionCompatibility Tests
// =============================================================================

describe('checkVersionCompatibility', () => {
  const mysqlTool: VersionInfo = {
    major: 8,
    minor: 0,
    patch: 35,
    full: '8.0.35',
  }
  const mariadbTool: VersionInfo = {
    major: 10,
    minor: 11,
    patch: 6,
    full: '10.11.6',
  }

  describe('compatible scenarios', () => {
    it('should be compatible when versions match exactly', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 35, full: '8.0.35' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.equal(result.error, undefined)
      assert.equal(result.warning, undefined)
    })

    it('should be compatible when tool is newer than dump', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 5, minor: 7, patch: 0, full: '5.7.0' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.equal(result.error, undefined)
    })

    it('should be compatible with same major, different minor', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 20, full: '8.0.20' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
    })

    it('should be compatible when dump version is null', () => {
      const dumpInfo: DumpInfo = {
        version: null,
        variant: 'unknown',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('Could not detect dump version'))
    })
  })

  describe('incompatible scenarios', () => {
    it('should be incompatible when MySQL 8 dump restored with MySQL 5.x client', () => {
      const oldMysqlTool: VersionInfo = {
        major: 5,
        minor: 7,
        patch: 0,
        full: '5.7.0',
      }
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 35, full: '8.0.35' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, oldMysqlTool, 'mysql')
      assert.equal(result.compatible, false)
      assert.ok(result.error?.includes('MySQL 8'))
      assert.ok(result.error?.includes('version 5'))
    })
  })

  describe('warning scenarios', () => {
    it('should warn when MariaDB dump is restored to MySQL', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 10, minor: 11, patch: 6, full: '10.11.6' },
        variant: 'mariadb',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('MariaDB'))
      assert.ok(result.warning?.includes('MySQL'))
    })

    it('should warn when MySQL dump is restored to MariaDB', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 35, full: '8.0.35' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mariadbTool, 'mariadb')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('MySQL'))
      assert.ok(result.warning?.includes('MariaDB'))
    })

    it('should warn when MariaDB 10.x dump restored to MySQL', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 10, minor: 5, patch: 0, full: '10.5.0' },
        variant: 'mariadb',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('MariaDB'))
    })

    it('should warn when dump is newer than tool (same variant)', () => {
      const newerDump: DumpInfo = {
        version: { major: 9, minor: 0, patch: 0, full: '9.0.0' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(newerDump, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('9.0.0'))
      assert.ok(result.warning?.includes('8.0.35'))
    })

    it('should warn when dump is very old (MySQL 5.5)', () => {
      const oldDump: DumpInfo = {
        version: { major: 5, minor: 5, patch: 0, full: '5.5.0' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(oldDump, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.ok(result.warning?.includes('very old'))
    })
  })

  describe('edge cases', () => {
    it('should handle unknown variants gracefully', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 0, full: '8.0.0' },
        variant: 'unknown',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      // No variant warning when one side is unknown
      assert.equal(result.compatible, true)
    })

    it('should return correct versions in result', () => {
      const dumpInfo: DumpInfo = {
        version: { major: 8, minor: 0, patch: 20, full: '8.0.20' },
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.deepEqual(result.dumpInfo, dumpInfo)
      assert.deepEqual(result.toolVersion, mysqlTool)
      assert.equal(result.toolVariant, 'mysql')
    })

    it('should handle null dump version correctly', () => {
      const dumpInfo: DumpInfo = {
        version: null,
        variant: 'mysql',
      }
      const result = checkVersionCompatibility(dumpInfo, mysqlTool, 'mysql')
      assert.equal(result.compatible, true)
      assert.equal(result.dumpInfo.version, null)
    })
  })
})
