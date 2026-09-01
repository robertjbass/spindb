import { describe, it } from 'node:test'
import {
  getDumpToolName,
  pickDumpToolName,
  NEUTRAL_DUMP_TOOL_NAME,
} from '../../config/engines-registry'
import { Engine } from '../../types'
import { assertEqual } from '../utils/assertions'

describe('Dump tool naming', () => {
  it('picks the dump utility out of an engine client tool list', () => {
    assertEqual(
      pickDumpToolName(['psql', 'pg_dump', 'pg_restore']),
      'pg_dump',
      'PostgreSQL dumps run pg_dump',
    )
    assertEqual(
      pickDumpToolName(['mysql', 'mysqldump', 'mysqladmin']),
      'mysqldump',
      'MySQL dumps run mysqldump',
    )
    assertEqual(
      pickDumpToolName(['mariadb', 'mariadb-dump', 'mariadb-admin']),
      'mariadb-dump',
      'MariaDB ships its own dump tool name',
    )
  })

  it('ignores restore tools that are not dump tools', () => {
    assertEqual(
      pickDumpToolName(['mongod', 'mongosh', 'mongodump', 'mongorestore']),
      'mongodump',
      'mongorestore must not be mistaken for the dump tool',
    )
  })

  it('falls back to a neutral label when an engine has no dump tool', () => {
    assertEqual(
      pickDumpToolName([]),
      NEUTRAL_DUMP_TOOL_NAME,
      'REST-API engines ship no dump utility',
    )
    assertEqual(
      pickDumpToolName(['redis-server', 'redis-cli']),
      NEUTRAL_DUMP_TOOL_NAME,
      'a client tool list without a dump tool reads neutrally',
    )
  })

  it('resolves the dump tool for a real engine', async () => {
    assertEqual(
      await getDumpToolName(Engine.MariaDB),
      'mariadb-dump',
      'a MariaDB create must not report a pg_dump failure',
    )
    assertEqual(
      await getDumpToolName(Engine.PostgreSQL),
      'pg_dump',
      'PostgreSQL keeps the name it always had',
    )
    assertEqual(
      await getDumpToolName(Engine.MySQL),
      'mysqldump',
      'MySQL dumps run mysqldump',
    )
  })
})
