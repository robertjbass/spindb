import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { containerManager } from '../../core/container-manager'
import { branchManager } from '../../core/branch-manager'
import { duckdbRegistry } from '../../engines/duckdb/registry'
import { DuckDBEngine } from '../../engines/duckdb'
import { getEngine } from '../../engines'
import { Engine, type DuckDBRegistryEntry } from '../../types'

describe('DuckDB database version pins', () => {
  let root: string
  let entries: Map<string, DuckDBRegistryEntry>

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spindb-duckdb-pins-'))
    const source = {
      name: 'pinned-source',
      filePath: join(root, 'source.duckdb'),
      created: '2026-01-01T00:00:00.000Z',
      version: '1.4.3',
    }
    await writeFile(source.filePath, 'disposable fixture')
    entries = new Map([[source.name, source]])
    mock.method(
      duckdbRegistry,
      'get',
      async (name: string) => entries.get(name) ?? null,
    )
    mock.method(duckdbRegistry, 'add', async (entry: DuckDBRegistryEntry) => {
      entries.set(entry.name, entry)
    })
    mock.method(
      duckdbRegistry,
      'update',
      async (name: string, updates: Partial<DuckDBRegistryEntry>) => {
        const entry = entries.get(name)
        assert.ok(entry)
        Object.assign(entry, updates)
        return true
      },
    )
  })

  afterEach(async () => {
    mock.restoreAll()
    await rm(root, { recursive: true, force: true })
  })

  it('reports the saved exact version rather than the current default', async () => {
    const config = await containerManager.getConfig('pinned-source', {
      engine: Engine.DuckDB,
    })
    assert.equal(config?.version, '1.4.3')
  })

  it('inherits the exact version when branching the backing file', async () => {
    const branch = await branchManager.createBranch({
      source: 'pinned-source',
      name: 'pinned-branch',
      path: join(root, 'branch.duckdb'),
    })
    assert.equal(entries.get('pinned-branch')?.version, '1.4.3')
    assert.equal(branch.config.version, '1.4.3')
  })

  for (const operation of ['query', 'script', 'backup', 'restore', 'connect']) {
    it(`uses the saved version for ${operation}`, async () => {
      const engine = new DuckDBEngine()
      const config = await containerManager.getConfig('pinned-source', {
        engine: Engine.DuckDB,
      })
      assert.ok(config)
      const lookup = mock.method(engine, 'getDuckDBPath', async () => {
        throw new Error('binary lookup reached')
      })
      mock.method(engine, 'detectBackupFormat', async () => ({
        format: 'sql',
        description: 'SQL dump',
      }))
      await assert.rejects(async () => {
        switch (operation) {
          case 'query':
            return engine.executeQuery(config, 'SELECT 1')
          case 'script':
            return engine.runScript(config, { sql: 'SELECT 1' })
          case 'backup':
            return engine.backup(config, join(root, 'backup.sql'), {
              format: 'sql',
              database: config.database,
            })
          case 'restore':
            return engine.restore(config, join(root, 'backup.sql'))
          case 'connect':
            return engine.connect(config)
        }
      }, /binary lookup reached/)
      assert.deepEqual(lookup.mock.calls[0].arguments, ['1.4.3'])
    })
  }

  it('does not invent a pin for a legacy registry entry', async () => {
    delete entries.get('pinned-source')!.version
    await branchManager.createBranch({
      source: 'pinned-source',
      name: 'legacy-branch',
      path: join(root, 'legacy.duckdb'),
    })
    assert.equal(entries.get('legacy-branch')?.version, undefined)
  })

  it('uses the source pin for a WAL checkpoint before branching', async () => {
    await writeFile(
      `${entries.get('pinned-source')!.filePath}.wal`,
      'pending WAL',
    )
    const lookup = mock.method(
      getEngine(Engine.DuckDB),
      'getDuckDBPath',
      async () => null,
    )
    await branchManager.createBranch({
      source: 'pinned-source',
      name: 'wal-branch',
      path: join(root, 'wal-branch.duckdb'),
    })
    assert.deepEqual(lookup.mock.calls[0].arguments, ['1.4.3'])
    assert.equal(entries.get('wal-branch')?.version, '1.4.3')
  })

  it('resets the branch to the parent data and exact version together', async () => {
    await branchManager.createBranch({
      source: 'pinned-source',
      name: 'reset-branch',
      path: join(root, 'reset-branch.duckdb'),
    })
    entries.get('reset-branch')!.version = '1.5.5'
    const reset = await branchManager.resetBranch('reset-branch')
    assert.equal(reset.config.version, '1.4.3')
    assert.equal(entries.get('reset-branch')?.version, '1.4.3')
  })
})
