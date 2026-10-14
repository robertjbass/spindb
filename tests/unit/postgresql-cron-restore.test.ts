import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getEngine } from '../../engines'
import { paths } from '../../config/paths'
import { Engine, type ContainerConfig } from '../../types'

const postgresqlEngine = getEngine(Engine.PostgreSQL)

for (const restartFails of [false, true]) {
  test(`restore recovers availability when saving the scheduler pause fails (restart failure=${restartFails})`, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'cron-restore-'))
    const container: ContainerConfig = {
      name: 'cron-restore-fixture',
      engine: Engine.PostgreSQL,
      version: '18.6.0',
      port: 55442,
      database: 'app',
      created: '2026-10-14',
      status: 'running',
    }
    context.mock.method(postgresqlEngine, 'executeQuery', async () => ({
      columns: ['enabled'],
      rows: [{ enabled: 'on' }],
      rowCount: 1,
    }))
    const stopped = context.mock.method(
      postgresqlEngine,
      'stop',
      async () => {},
    )
    const started = context.mock.method(postgresqlEngine, 'start', async () => {
      if (restartFails) throw new Error('restart failed')
      return { port: 55442, connectionString: '' }
    })
    context.mock.method(paths, 'getContainerDataPath', () =>
      join(root, 'missing'),
    )
    try {
      await assert.rejects(
        postgresqlEngine.prepareRestore(container),
        restartFails ? /Restore has not begun/ : /ENOENT/,
      )
      assert.equal(stopped.mock.callCount(), 1)
      assert.equal(started.mock.callCount(), 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
