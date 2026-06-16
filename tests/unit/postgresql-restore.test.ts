/**
 * PostgreSQL restore module unit tests
 */

import { describe, it } from 'node:test'
import { assert } from '../utils/assertions'
import { buildPgRestoreCommand } from '../../engines/postgresql/restore'

describe('PostgreSQL Restore Module', () => {
  describe('buildPgRestoreCommand', () => {
    const base = {
      restorePath: '/bin/pg_restore',
      port: 10000,
      user: 'postgres',
      database: 'mydb',
      formatFlag: '-Fc',
      backupPath: '/tmp/backup.dump',
    }

    it('targets the local engine with owner/privilege stripping and the format flag', () => {
      const cmd = buildPgRestoreCommand(base)
      assert(cmd.includes('-h 127.0.0.1'), 'connects to localhost')
      assert(cmd.includes('-p 10000'), 'uses the port')
      assert(cmd.includes('-U postgres'), 'uses the user')
      assert(cmd.includes('-d mydb'), 'targets the database')
      assert(cmd.includes('--no-owner --no-privileges'), 'strips owner/privs')
      assert(cmd.includes('-Fc'), 'passes the format flag')
      assert(cmd.includes('"/tmp/backup.dump"'), 'quotes the backup path')
    })

    it('omits --clean by default (additive into an empty, just-created DB)', () => {
      const cmd = buildPgRestoreCommand(base)
      assert(!cmd.includes('--clean'), 'no --clean without the flag')
      assert(!cmd.includes('--if-exists'), 'no --if-exists without the flag')
    })

    it('adds --clean --if-exists when clean is set (the --into-existing REPLACE)', () => {
      // For an in-place restore into a live database we must drop + recreate each
      // object so the result REPLACES the contents (not merges into them), while
      // leaving the database itself (and its open connections) untouched.
      const cmd = buildPgRestoreCommand({ ...base, clean: true })
      assert(cmd.includes('--clean --if-exists'), 'includes --clean --if-exists')
      // ordering: clean flags before the format flag and the file
      assert(
        cmd.indexOf('--clean --if-exists') < cmd.indexOf('-Fc'),
        'clean flags precede the format flag',
      )
    })
  })
})
