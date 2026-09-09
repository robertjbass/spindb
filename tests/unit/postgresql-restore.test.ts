/**
 * PostgreSQL restore module unit tests
 */

import { describe, it } from 'node:test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert } from '../utils/assertions'
import {
  buildPgRestoreCommand,
  detectBackupFormat,
} from '../../engines/postgresql/restore'
import { isPoolerHost } from '../../engines/postgresql'

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
      assert(
        cmd.includes('--clean --if-exists'),
        'includes --clean --if-exists',
      )
      // ordering: clean flags before the format flag and the file
      assert(
        cmd.indexOf('--clean --if-exists') < cmd.indexOf('-Fc'),
        'clean flags precede the format flag',
      )
    })

    it('adds -j N for parallel restore only when jobs > 1', () => {
      const parallel = buildPgRestoreCommand({
        ...base,
        formatFlag: '-Fd',
        jobs: 4,
      })
      assert(parallel.includes(' -j 4 '), 'includes -j 4')
      assert(parallel.includes('-Fd'), 'keeps the directory format flag')
      const single = buildPgRestoreCommand({ ...base, jobs: 1 })
      assert(!single.includes(' -j '), 'jobs: 1 stays single-stream')
      const unset = buildPgRestoreCommand(base)
      assert(!unset.includes(' -j '), 'no jobs stays single-stream')
    })

    it('drops the dump privileges by default', () => {
      // Unchanged behaviour: every GRANT/REVOKE in the dump is discarded, which
      // is why a restore never fails on a role the target does not have.
      const cmd = buildPgRestoreCommand(base)
      assert(cmd.includes('--no-privileges'), 'privileges are stripped')
      assert(cmd.includes('--no-owner'), 'ownership is stripped')
    })

    it('keeps the dump privileges with withPrivileges, and still strips ownership', () => {
      // --with-privileges: pg_restore replays the GRANT/REVOKE statements, so a
      // grant to a role this server does not have surfaces as an object error
      // in the diagnostics instead of being dropped silently. Ownership stays
      // stripped either way - the owning role does not exist locally.
      const cmd = buildPgRestoreCommand({ ...base, withPrivileges: true })
      assert(!cmd.includes('--no-privileges'), 'privileges are replayed')
      assert(cmd.includes('--no-owner'), 'ownership is still stripped')
      assert(cmd.includes('-Fc'), 'still passes the format flag')
      assert(cmd.includes('"/tmp/backup.dump"'), 'still quotes the backup path')
    })

    it('combines withPrivileges with the --into-existing clean flags', () => {
      const cmd = buildPgRestoreCommand({
        ...base,
        withPrivileges: true,
        clean: true,
        jobs: 4,
      })
      assert(!cmd.includes('--no-privileges'), 'privileges are replayed')
      assert(cmd.includes('--clean --if-exists'), 'keeps the clean flags')
      assert(cmd.includes(' -j 4 '), 'keeps the parallel flag')
      assert(
        cmd.indexOf('--no-owner') < cmd.indexOf('--clean --if-exists'),
        'ownership flags precede the clean flags',
      )
    })
  })

  describe('detectBackupFormat (directory dumps)', () => {
    it('detects a pg_dump -Fd directory via toc.dat', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'spindb-fd-test-'))
      try {
        await writeFile(join(dir, 'toc.dat'), 'PGDMP-toc-placeholder')
        const format = await detectBackupFormat(dir)
        assert(format.format === 'directory', 'detects directory format')
        assert(
          format.restoreCommand === 'pg_restore',
          'restores with pg_restore',
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('rejects a directory without toc.dat', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'spindb-notdump-test-'))
      try {
        let threw = false
        try {
          await detectBackupFormat(dir)
        } catch {
          threw = true
        }
        assert(threw, 'throws on a non-dump directory')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  describe('isPoolerHost', () => {
    it('flags Neon pooler endpoints and pgbouncer hosts', () => {
      assert(
        isPoolerHost(
          'ep-damp-frost-a5b3oyxr-pooler.c-2.us-east-2.aws.neon.tech',
        ),
        'Neon -pooler host',
      )
      assert(isPoolerHost('pgbouncer.internal.example.com'), 'pgbouncer host')
    })

    it('passes direct endpoints and local hosts', () => {
      assert(
        !isPoolerHost('ep-damp-frost-a5b3oyxr.c-2.us-east-2.aws.neon.tech'),
        'Neon direct host',
      )
      assert(!isPoolerHost('127.0.0.1'), 'localhost IP')
      assert(!isPoolerHost('db.example.com'), 'plain host')
    })
  })
})
