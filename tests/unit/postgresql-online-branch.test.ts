import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { branchManager } from '../../core/branch-manager'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { postgresqlEngine } from '../../engines/postgresql'
import {
  branchConfigOverrides,
  validateBranchArchive,
} from '../../engines/postgresql/online-branch'
import { Engine, type ContainerConfig } from '../../types'

const source: ContainerConfig = {
  name: 'source',
  engine: Engine.PostgreSQL,
  version: '18.6.0',
  port: 5454,
  database: 'postgres',
  created: '2026-10-08',
  status: 'running',
}

for (const fails of [false, true]) {
  test(`live PostgreSQL branch never stops or restarts its source (backup failure=${fails})`, async (context) => {
    context.mock.method(containerManager, 'getConfig', async () => source)
    context.mock.method(containerManager, 'exists', async () => false)
    context.mock.method(processManager, 'isRunning', async () => true)
    const stop = context.mock.method(postgresqlEngine, 'stop', async () => {
      throw new Error('must not stop')
    })
    const start = context.mock.method(postgresqlEngine, 'start', async () => {
      throw new Error('must not restart')
    })
    context.mock.method(
      containerManager,
      'copyContainerData',
      async (
        options: Parameters<typeof containerManager.copyContainerData>[0],
      ) => {
        assert.equal(options.online, true)
        assert.equal(options.port, 5455)
        if (fails) throw new Error('backup unavailable')
        return {
          config: { ...source, name: 'child', port: 5455 },
          method: 'copy' as const,
        }
      },
    )
    const result = branchManager.createBranch({
      source: 'source',
      name: 'child',
      start: false,
      port: 5455,
    })
    if (fails) await assert.rejects(result, /backup unavailable/)
    else assert.equal((await result).method, 'copy')
    assert.equal(stop.mock.callCount(), 0)
    assert.equal(start.mock.callCount(), 0)
  })
}

test('stopped PostgreSQL sources retain filesystem copy support', async (context) => {
  context.mock.method(containerManager, 'getConfig', async () => source)
  context.mock.method(containerManager, 'exists', async () => false)
  context.mock.method(processManager, 'isRunning', async () => false)
  context.mock.method(
    containerManager,
    'copyContainerData',
    async (
      options: Parameters<typeof containerManager.copyContainerData>[0],
    ) => {
      assert.equal(options.online, false)
      return {
        config: { ...source, name: 'child' },
        method: 'reflink' as const,
      }
    },
  )
  assert.equal(
    (
      await branchManager.createBranch({
        source: 'source',
        name: 'child',
        start: false,
      })
    ).method,
    'reflink',
  )
})

for (const [name, type, valid] of [
  ['base/5/123', '0', true],
  ['base/', '5', true],
  ['../parent/data', '0', false],
  ['/parent/data', '0', false],
  ['C:/parent/data', '0', false],
  ['base/link', '2', false],
  ['base/hardlink', '1', false],
] as const) {
  test(`archive guard ${valid ? 'accepts' : 'refuses'} ${name} (${type})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pg-archive-guard-'))
    try {
      const archive = join(dir, 'backup.tar')
      const header = Buffer.alloc(512)
      header.write(name)
      header.write('00000000000', 124)
      header.write(type, 156)
      await writeFile(archive, Buffer.concat([header, Buffer.alloc(1024)]))
      if (valid) await validateBranchArchive(archive)
      else
        await assert.rejects(
          validateBranchArchive(archive),
          /unsupported archive entry/,
        )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
}

test('branch overrides isolate writes and background consumers from the source', () => {
  const config = branchConfigOverrides("/tmp/child's/data", 18)
  assert.match(config, /data_directory = '\/tmp\/child''s\/data'/)
  assert.match(config, /archive_mode = off/)
  assert.match(config, /max_logical_replication_workers = 0/)
  assert.match(config, /shared_preload_libraries = ''/)
  assert.match(config, /primary_conninfo = ''/)
  assert.match(config, /external_pid_file = ''/)
  assert.doesNotMatch(
    branchConfigOverrides('/tmp/child/data', 14),
    /archive_library/,
  )
})
