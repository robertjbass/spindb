import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseVersion,
  extractDumpVersion,
  validateRestoreCompatibility,
} from '../../engines/mariadb/version-validator'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(__dirname, '../fixtures/mariadb/dumps')

// =============================================================================
// parseVersion Tests
// =============================================================================

describe('MariaDB parseVersion', () => {
  it('should parse full MariaDB version string', () => {
    const result = parseVersion('11.8.5')
    assert.equal(result.major, 11)
    assert.equal(result.minor, 8)
    assert.equal(result.patch, 5)
    assert.equal(result.full, '11.8.5')
  })

  it('should parse MariaDB 10.x version', () => {
    const result = parseVersion('10.11.6')
    assert.equal(result.major, 10)
    assert.equal(result.minor, 11)
    assert.equal(result.patch, 6)
    assert.equal(result.full, '10.11.6')
  })

  it('should parse version without patch number', () => {
    const result = parseVersion('11.4')
    assert.equal(result.major, 11)
    assert.equal(result.minor, 4)
    assert.equal(result.patch, 0)
  })

  it('should parse single digit version', () => {
    const result = parseVersion('10.5.8')
    assert.equal(result.major, 10)
    assert.equal(result.minor, 5)
    assert.equal(result.patch, 8)
  })

  it('should handle four-part versions', () => {
    const result = parseVersion('10.11.6.1')
    assert.equal(result.major, 10)
    assert.equal(result.minor, 11)
    assert.equal(result.patch, 6)
  })
})

// =============================================================================
// extractDumpVersion Tests
// =============================================================================

describe('MariaDB extractDumpVersion', () => {
  it('should extract version from MariaDB 10.11 dump', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-10.11-plain.sql')
    const result = await extractDumpVersion(dumpPath)

    assert.ok(result, 'Expected result to be defined')
    assert.equal(result.isMariaDB, true)
    // Version string should contain 10.11
    assert.ok(result.version.startsWith('10.11'))
  })

  it('should extract version from MariaDB 11.4 dump', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-11.4-plain.sql')
    const result = await extractDumpVersion(dumpPath)

    assert.ok(result, 'Expected result to be defined')
    assert.equal(result.isMariaDB, true)
    // Version string should contain 11.4
    assert.ok(result.version.startsWith('11.4'))
  })

  it('should return null for non-existent file', async () => {
    const result = await extractDumpVersion('/nonexistent/path/dump.sql')
    assert.equal(result, null)
  })
})

// =============================================================================
// validateRestoreCompatibility Tests
// =============================================================================

describe('MariaDB validateRestoreCompatibility', () => {
  it('should be compatible when restoring older dump to newer version', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-10.11-plain.sql')
    const result = await validateRestoreCompatibility({
      dumpPath,
      targetVersion: '11.8.5',
    })

    assert.equal(result.compatible, true)
    assert.equal(result.warning, undefined)
  })

  it('should be compatible for same major version', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-11.4-plain.sql')
    const result = await validateRestoreCompatibility({
      dumpPath,
      targetVersion: '11.8.5',
    })

    assert.equal(result.compatible, true)
  })

  it('should allow restore when dump version cannot be determined', async () => {
    const result = await validateRestoreCompatibility({
      dumpPath: '/nonexistent/path/dump.sql',
      targetVersion: '11.8.5',
    })

    assert.equal(result.compatible, true)
    assert.ok(result.warning?.includes('Could not determine'))
  })

  it('should be compatible when no target version specified', async () => {
    const dumpPath = path.join(fixturesDir, 'mariadb-11.4-plain.sql')
    const result = await validateRestoreCompatibility({
      dumpPath,
    })

    assert.equal(result.compatible, true)
  })
})
