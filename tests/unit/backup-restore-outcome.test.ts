/**
 * `performRestore` (the library/menu restore path) must reach the same verdict
 * as the `restore` CLI, including the one the CLI throws on.
 *
 * An engine's `restore()` RESOLVES on a failed restore rather than throwing -
 * `engines/postgresql/restore.ts` catches `pg_restore`'s non-zero exit and
 * returns `{ code: 1, stderr }` so a partial restore can be told apart from a
 * dead one. So the `catch` below the call never runs for a real failure: if
 * this path only asks `hadObjectErrors`, a `FATAL` (a killed connection, a
 * server that went away) is reported to the caller as `success: true` with a
 * warning, which is exactly the swallow `classifyRestoreOutcome` exists to end.
 */

import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { containerManager } from '../../core/container-manager'
import { postgresqlEngine } from '../../engines/postgresql'
import { performRestore } from '../../core/backup-restore'
import { Engine, type ContainerConfig, type RestoreResult } from '../../types'

const CONFIG: ContainerConfig = {
  name: 'pg',
  engine: Engine.PostgreSQL,
  version: '17.0.0',
  port: 5432,
  database: 'app',
  databases: ['app'],
  created: '2026-01-01T00:00:00.000Z',
  status: 'running',
}

function stubEngineRestore(result: RestoreResult) {
  mock.method(containerManager, 'getConfig', async () => CONFIG)
  mock.method(postgresqlEngine, 'restore', async () => result)
  mock.method(
    postgresqlEngine,
    'getConnectionString',
    () => 'postgresql://postgres@127.0.0.1:5432/app',
  )
}

const OPTIONS = {
  containerName: 'pg',
  databaseName: 'app',
  backupPath: '/tmp/backup.dump',
  createDatabase: false,
  interactive: false,
}

describe('performRestore verdict', () => {
  afterEach(() => mock.restoreAll())

  it('reports a FATAL restore as a failure, not a warning', async () => {
    stubEngineRestore({
      format: 'custom',
      stderr:
        'pg_restore: error: connection to server was lost\nFATAL:  terminating connection due to administrator command',
      code: 1,
    })

    const result = await performRestore(OPTIONS)

    assert.equal(result.success, false, 'a FATAL restore did not succeed')
    assert.match(
      result.error ?? '',
      /FATAL/,
      "the caller is told what the tool said, not 'completed with warnings'",
    )
  })

  it('reports an unexplained non-zero exit as a failure', async () => {
    // Nothing here looks like an object-level failure, so there is no partial
    // restore to preserve: the exit code is all there is to go on.
    stubEngineRestore({
      format: 'custom',
      stderr: 'could not connect to server: Connection refused',
      code: 1,
    })

    const result = await performRestore(OPTIONS)

    assert.equal(result.success, false, 'nothing explains the non-zero exit')
    assert.ok(result.error, 'the failure carries a message')
  })

  it('still reports a partial restore as a success with warnings', async () => {
    stubEngineRestore({
      format: 'custom',
      stderr: [
        'pg_restore: error: could not execute query: ERROR:  extension "uuid-ossp" is not available',
        'pg_restore: warning: errors ignored on restore: 819',
      ].join('\n'),
      code: 1,
    })

    const result = await performRestore(OPTIONS)

    assert.equal(
      result.success,
      true,
      'the database exists and holds what landed',
    )
    assert.ok(
      result.warnings?.some((w) => w.includes('uuid-ossp')),
      'the failing objects are reported to the caller',
    )
  })

  it('reports a clean restore as a success with no warnings', async () => {
    stubEngineRestore({ format: 'custom', stderr: '', code: 0 })

    const result = await performRestore(OPTIONS)

    assert.equal(result.success, true, 'a clean restore succeeds')
    assert.equal(result.warnings, undefined, 'and says nothing went wrong')
  })
})
