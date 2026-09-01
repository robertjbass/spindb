import { describe, it } from 'node:test'
import { buildMysqlRemoteDumpArgs } from '../../engines/mysql/index'
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
