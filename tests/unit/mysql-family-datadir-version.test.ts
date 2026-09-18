/**
 * Unit tests for the MySQL-family data directory version cross-check.
 *
 * `start()` picks the server binary from container.json's `version` alone, so
 * a container.json edited (or restored) onto a different release line points
 * mariadbd at a data directory it will upgrade in place on first boot. That
 * upgrade is irreversible: MariaDB has no cross-major downgrade. The data
 * directory records the last server version that opened it in
 * data/mariadb_upgrade_info (MariaDB 11+) or data/mysql_upgrade_info
 * (MariaDB 10.x, MySQL 5.7 and older), and these tests drive that file.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  assertDataDirVersionMatches,
  formatVersionLine,
  parseVersionLine,
  readDataDirVersion,
  versionLinesDisagree,
} from '../../core/mysql-family-datadir-version'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MARIADB_FIXTURES = join(__dirname, '../fixtures/mariadb/datadir-version')
const MYSQL_FIXTURES = join(__dirname, '../fixtures/mysql/datadir-version')

describe('parseVersionLine', () => {
  it('reads the line out of an upgrade-info string', () => {
    assert.deepEqual(parseVersionLine('11.8.9-MariaDB'), {
      major: 11,
      minor: 8,
    })
    assert.deepEqual(parseVersionLine('10.11.15-MariaDB'), {
      major: 10,
      minor: 11,
    })
    assert.deepEqual(parseVersionLine('5.7.44'), { major: 5, minor: 7 })
  })

  it('reads a bare major with no minor', () => {
    assert.deepEqual(parseVersionLine('11'), { major: 11 })
  })

  it('returns null for a version it cannot parse', () => {
    assert.equal(parseVersionLine('unknown'), null)
    assert.equal(parseVersionLine(''), null)
  })
})

describe('formatVersionLine', () => {
  it('formats major.minor, and a bare major when there is no minor', () => {
    assert.equal(formatVersionLine({ major: 13, minor: 0 }), '13.0')
    assert.equal(formatVersionLine({ major: 11 }), '11')
  })
})

describe('versionLinesDisagree', () => {
  it('accepts a newer patch on the same line', () => {
    // 11.8.8 data under an 11.8.9 server is the normal patch bump.
    assert.equal(
      versionLinesDisagree({ major: 11, minor: 8 }, { major: 11, minor: 8 }),
      false,
    )
  })

  it('flags a different major', () => {
    assert.equal(
      versionLinesDisagree({ major: 13, minor: 0 }, { major: 11, minor: 8 }),
      true,
    )
  })

  it('flags a different minor within the same major', () => {
    // MariaDB ships 11.4 and 11.8 as separate, non-interchangeable lines.
    assert.equal(
      versionLinesDisagree({ major: 11, minor: 4 }, { major: 11, minor: 8 }),
      true,
    )
  })

  it('compares majors only when either side has no minor', () => {
    assert.equal(
      versionLinesDisagree({ major: 11 }, { major: 11, minor: 8 }),
      false,
    )
    assert.equal(
      versionLinesDisagree({ major: 11 }, { major: 13, minor: 0 }),
      true,
    )
  })
})

describe('readDataDirVersion', () => {
  it('reads mariadb_upgrade_info (MariaDB 11+)', async () => {
    const info = await readDataDirVersion(
      join(MARIADB_FIXTURES, 'mariadb-11-8'),
    )
    assert.ok(info)
    assert.equal(info.file, 'mariadb_upgrade_info')
    assert.equal(info.raw, '11.8.9-MariaDB')
    assert.deepEqual(info.line, { major: 11, minor: 8 })
  })

  it('reads the legacy mysql_upgrade_info (MariaDB 10.x)', async () => {
    const info = await readDataDirVersion(
      join(MARIADB_FIXTURES, 'mariadb-10-11'),
    )
    assert.ok(info)
    assert.equal(info.file, 'mysql_upgrade_info')
    assert.deepEqual(info.line, { major: 10, minor: 11 })
  })

  it('reads mysql_upgrade_info for MySQL 5.7', async () => {
    const info = await readDataDirVersion(join(MYSQL_FIXTURES, 'mysql-5-7'))
    assert.ok(info)
    assert.equal(info.raw, '5.7.44')
    assert.deepEqual(info.line, { major: 5, minor: 7 })
  })

  it('prefers mariadb_upgrade_info when a 10.x dir carries both', async () => {
    // A data dir upgraded 10.x -> 11.x keeps the stale legacy file around.
    const info = await readDataDirVersion(join(MARIADB_FIXTURES, 'both-files'))
    assert.ok(info)
    assert.equal(info.file, 'mariadb_upgrade_info')
    assert.deepEqual(info.line, { major: 11, minor: 8 })
  })

  it('returns null when there is no upgrade-info file (MySQL 8+)', async () => {
    assert.equal(
      await readDataDirVersion(join(MYSQL_FIXTURES, 'mysql-8-no-file')),
      null,
    )
  })

  it('returns null for an unparsable or empty file', async () => {
    assert.equal(
      await readDataDirVersion(join(MARIADB_FIXTURES, 'unparsable')),
      null,
    )
    assert.equal(
      await readDataDirVersion(join(MARIADB_FIXTURES, 'empty')),
      null,
    )
  })
})

describe('assertDataDirVersionMatches', () => {
  it('refuses a 13.0 server over an 11.8 data directory', async () => {
    const dataDir = join(MARIADB_FIXTURES, 'mariadb-11-8')
    await assert.rejects(
      () =>
        assertDataDirVersionMatches({
          engineLabel: 'MariaDB',
          containerName: 'mydb',
          configuredVersion: '13.0.2',
          dataDir,
        }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'VERSION_MISMATCH')
        // Names both values, so the operator can see which side is wrong.
        assert.match(error.message, /pinned to version 13\.0\.2/)
        assert.match(error.message, /the 13\.0 line/)
        assert.match(error.message, /last opened by 11\.8\.9-MariaDB/)
        assert.match(error.message, /the 11\.8 line/)
        // Names the file the claim came from and the data dir at risk.
        assert.match(error.message, /mariadb_upgrade_info/)
        assert.match(error.message, new RegExp(dataDir.replace(/\./g, '\\.')))
        // States the consequence and the fix.
        assert.match(error.message, /cannot be undone/)
        assert.match(error.message, /no cross-major downgrade/)
        assert.match(error.message, /restore the backup into it/)
        return true
      },
    )
  })

  it('allows a newer patch on the same line', async () => {
    await assertDataDirVersionMatches({
      engineLabel: 'MariaDB',
      containerName: 'mydb',
      // 11.8.9 binary over a data dir last opened by 11.8.9: same line.
      configuredVersion: '11.8.9',
      dataDir: join(MARIADB_FIXTURES, 'mariadb-11-8'),
    })
  })

  it('allows a legacy shorthand version that matches the major', async () => {
    await assertDataDirVersionMatches({
      engineLabel: 'MariaDB',
      containerName: 'mydb',
      configuredVersion: '11',
      dataDir: join(MARIADB_FIXTURES, 'mariadb-11-8'),
    })
  })

  it('refuses a shorthand version on a different major', async () => {
    await assert.rejects(() =>
      assertDataDirVersionMatches({
        engineLabel: 'MariaDB',
        containerName: 'mydb',
        configuredVersion: '13',
        dataDir: join(MARIADB_FIXTURES, 'mariadb-11-8'),
      }),
    )
  })

  it('starts as before when the data directory records no version', async () => {
    await assertDataDirVersionMatches({
      engineLabel: 'MySQL',
      containerName: 'mydb',
      configuredVersion: '8.4.6',
      dataDir: join(MYSQL_FIXTURES, 'mysql-8-no-file'),
    })
  })

  it('starts as before when the data directory does not exist yet', async () => {
    await assertDataDirVersionMatches({
      engineLabel: 'MariaDB',
      containerName: 'mydb',
      configuredVersion: '13.0.2',
      dataDir: join(MARIADB_FIXTURES, 'does-not-exist'),
    })
  })

  it('starts as before for a container with an unknown version', async () => {
    await assertDataDirVersionMatches({
      engineLabel: 'MariaDB',
      containerName: 'mydb',
      configuredVersion: 'unknown',
      dataDir: join(MARIADB_FIXTURES, 'mariadb-11-8'),
    })
  })
})
