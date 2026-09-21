import { describe, it } from 'node:test'
import { buildMariaDbRemoteDumpArgs } from '../../engines/mariadb/index'
import { assert, assertDeepEqual, assertEqual } from '../utils/assertions'

const baseOptions = {
  host: 'mariadb.example.com',
  port: '3306',
  user: 'appuser',
  database: 'appdb',
  outputPath: '/tmp/appdb.sql',
}

describe('MariaDB remote dump args', () => {
  it('takes the dump in a single transaction', () => {
    const args = buildMariaDbRemoteDumpArgs(baseOptions)

    assert(
      args.includes('--single-transaction'),
      'remote dumps must read one consistent snapshot instead of reading each table at a different point in time',
    )
  })

  it('never passes the MySQL-only flags mariadb-dump rejects', () => {
    const args = buildMariaDbRemoteDumpArgs(baseOptions)

    assert(
      !args.some((arg) => arg.startsWith('--set-gtid-purged')),
      'mariadb-dump rejects --set-gtid-purged',
    )
    assert(
      !args.some((arg) => arg.startsWith('--column-statistics')),
      'mariadb-dump rejects --column-statistics',
    )
  })

  it('compresses the dump on the wire when asked to', () => {
    const args = buildMariaDbRemoteDumpArgs({ ...baseOptions, compress: true })

    assert(
      args.includes('--compress'),
      'a remote dump crosses the internet, so a MariaDB source must be compressed on the wire',
    )
    assert(
      !args.some((arg) => arg.startsWith('--compression-algorithms')),
      'mariadb-dump has no --compression-algorithms; only --compress exists',
    )
  })

  it('leaves the connection uncompressed by default', () => {
    // A non-MariaDB source must not be compressed: measured against a MySQL
    // 8.4 server whose auth plugin this client cannot load, --compress turns a
    // fast, explained failure into a process that never returns.
    const args = buildMariaDbRemoteDumpArgs(baseOptions)

    assert(
      !args.includes('--compress') && !args.includes('-C'),
      'compression must be opt-in per source flavor, not the default',
    )
  })

  it('builds the full argument list in order', () => {
    assertDeepEqual(
      buildMariaDbRemoteDumpArgs(baseOptions),
      [
        '-h',
        'mariadb.example.com',
        '-P',
        '3306',
        '-u',
        'appuser',
        '--single-transaction',
        '--result-file',
        '/tmp/appdb.sql',
        'appdb',
      ],
      'remote dump args should match the expected mariadb-dump invocation',
    )
  })

  it('qualifies bare excluded table names with the dumped database', () => {
    const args = buildMariaDbRemoteDumpArgs({
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
