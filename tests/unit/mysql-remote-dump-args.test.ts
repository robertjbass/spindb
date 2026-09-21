import { describe, it } from 'node:test'
import { buildMysqlRemoteDumpArgs } from '../../engines/mysql/index'
import { MYSQL_VERSION_MAP } from '../../engines/mysql/version-maps'
import { assert, assertDeepEqual, assertEqual } from '../utils/assertions'

const baseOptions = {
  host: 'mysql.example.com',
  port: '3306',
  user: 'avnadmin',
  database: 'appdb',
  outputPath: '/tmp/appdb.sql',
}

describe('MySQL remote dump args', () => {
  it('disables GTID_PURGED so a managed source restores elsewhere', () => {
    const args = buildMysqlRemoteDumpArgs(baseOptions)

    assert(
      args.includes('--set-gtid-purged=OFF'),
      'remote dumps must suppress SET @@GLOBAL.GTID_PURGED, which only a superuser can replay',
    )
  })

  it('takes the dump in a single transaction', () => {
    const args = buildMysqlRemoteDumpArgs(baseOptions)

    assert(
      args.includes('--single-transaction'),
      'remote dumps must use a consistent snapshot instead of locking the source',
    )
  })

  it('turns off column statistics so a MariaDB source can be dumped', () => {
    const args = buildMysqlRemoteDumpArgs(baseOptions)

    assert(
      args.includes('--column-statistics=0'),
      'mysqldump must not read information_schema.COLUMN_STATISTICS, which a MariaDB source does not have',
    )
  })

  it('compresses the dump on the wire with the non-deprecated flag', () => {
    const args = buildMysqlRemoteDumpArgs(baseOptions)

    assert(
      args.includes('--compression-algorithms=zlib'),
      'a remote dump crosses the internet, so it must be compressed on the wire',
    )
    assert(
      !args.includes('--compress') && !args.includes('-C'),
      'the short --compress form is deprecated since MySQL 8.0.18 and warns on stderr',
    )
  })

  it('builds the full argument list in order', () => {
    assertDeepEqual(
      buildMysqlRemoteDumpArgs(baseOptions),
      [
        '-h',
        'mysql.example.com',
        '-P',
        '3306',
        '-u',
        'avnadmin',
        '--single-transaction',
        '--set-gtid-purged=OFF',
        '--column-statistics=0',
        '--compression-algorithms=zlib',
        '--result-file',
        '/tmp/appdb.sql',
        'appdb',
      ],
      'remote dump args should match the expected mysqldump invocation',
    )
  })

  it('qualifies bare excluded table names with the dumped database', () => {
    const args = buildMysqlRemoteDumpArgs({
      ...baseOptions,
      excludeTables: ['sessions', 'other.audit_log'],
    })

    assert(
      args.includes('--ignore-table=appdb.sessions'),
      'bare table names should be qualified with the database being dumped',
    )
    assert(
      args.includes('--ignore-table=other.audit_log'),
      'already-qualified table names should be passed through unchanged',
    )
    assertEqual(
      args[args.length - 1],
      'appdb',
      'the database must stay the final positional argument',
    )
  })
})

describe('MySQL dump flag support', () => {
  it('ships no mysqldump older than the 8.0.18 that added --compression-algorithms', () => {
    // The remote dump passes --compression-algorithms=zlib unconditionally.
    // Before 8.0.18 the only form was the now-deprecated --compress, so a
    // client older than that would reject the flag outright.
    for (const version of Object.values(MYSQL_VERSION_MAP)) {
      const [major, minor, patch] = version.split('.').map(Number)
      const isSupported =
        major > 8 ||
        (major === 8 && (minor > 0 || (minor === 0 && patch >= 18)))

      assert(
        isSupported,
        `MySQL ${version} predates --compression-algorithms (8.0.18); the remote dump builder needs a version guard`,
      )
    }
  })

  it('ships no mysqldump older than the 8.0.2 that added --column-statistics', () => {
    // The remote dump passes --column-statistics=0 unconditionally, with no
    // version guard. That is only safe while every mysqldump spindb can
    // install understands the flag.
    for (const version of Object.values(MYSQL_VERSION_MAP)) {
      const [major, minor, patch] = version.split('.').map(Number)
      const isSupported =
        major > 8 || (major === 8 && (minor > 0 || (minor === 0 && patch >= 2)))

      assert(
        isSupported,
        `MySQL ${version} predates --column-statistics (8.0.2); the remote dump builder needs a version guard`,
      )
    }
  })
})
