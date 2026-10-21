import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import inquirer from 'inquirer'
import { connectCommand } from '../../cli/commands/connect'
import { handleOpenShell } from '../../cli/commands/menu/shell-handlers'
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
    syncBuiltinESMExports()
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

  it('refuses a WAL branch when the exact pinned binary is missing', async () => {
    const sourceFile = entries.get('pinned-source')!.filePath
    const target = join(root, 'wal-branch.duckdb')
    await writeFile(`${sourceFile}.wal`, 'pending WAL')
    const lookup = mock.method(
      getEngine(Engine.DuckDB),
      'getDuckDBPath',
      async () => null,
    )
    await assert.rejects(
      () =>
        branchManager.createBranch({
          source: 'pinned-source',
          name: 'wal-branch',
          path: target,
        }),
      /spindb engines download duckdb 1\.4\.3/,
    )
    assert.deepEqual(lookup.mock.calls[0].arguments, ['1.4.3'])
    assert.equal(entries.has('wal-branch'), false)
    assert.equal(existsSync(target), false)
    assert.equal(existsSync(`${target}.wal`), false)
    assert.equal(await readFile(`${sourceFile}.wal`, 'utf8'), 'pending WAL')
  })

  it('keeps the legacy WAL-copy fallback without inventing a pin', async () => {
    const source = entries.get('pinned-source')!
    delete source.version
    await writeFile(`${source.filePath}.wal`, 'pending WAL')
    mock.method(getEngine(Engine.DuckDB), 'getDuckDBPath', async () => null)
    const target = join(root, 'legacy-wal.duckdb')
    const result = await branchManager.createBranch({
      source: source.name,
      name: 'legacy-wal',
      path: target,
    })
    assert.match(result.warning!, /write-ahead log was copied/)
    assert.equal(await readFile(`${target}.wal`, 'utf8'), 'pending WAL')
    assert.equal(entries.get('legacy-wal')?.version, undefined)
  })

  it('leaves a reset target intact when the parent WAL needs a missing pinned binary', async () => {
    const target = join(root, 'reset-wal.duckdb')
    await branchManager.createBranch({
      source: 'pinned-source',
      name: 'reset-wal',
      path: target,
    })
    await writeFile(target, 'branch data to preserve')
    await writeFile(`${target}.wal`, 'branch WAL to preserve')
    entries.get('reset-wal')!.version = '1.5.5'
    await writeFile(
      `${entries.get('pinned-source')!.filePath}.wal`,
      'parent WAL',
    )
    mock.method(getEngine(Engine.DuckDB), 'getDuckDBPath', async () => null)
    await assert.rejects(
      () => branchManager.resetBranch('reset-wal'),
      /spindb engines download duckdb 1\.4\.3/,
    )
    assert.equal(await readFile(target, 'utf8'), 'branch data to preserve')
    assert.equal(
      await readFile(`${target}.wal`, 'utf8'),
      'branch WAL to preserve',
    )
    assert.equal(entries.get('reset-wal')?.version, '1.5.5')
  })

  it('resolves UI and menu shell binaries from the registry pin', async () => {
    const engine = new DuckDBEngine()
    const lookup = mock.method(
      engine,
      'getDuckDBPath',
      async () => '/exact/duckdb',
    )
    assert.equal(
      await engine.getRegisteredBinaryPath('pinned-source'),
      '/exact/duckdb',
    )
    assert.deepEqual(lookup.mock.calls[0].arguments, ['1.4.3'])
  })

  it('refuses a missing pinned UI or menu shell binary with the exact recovery command', async () => {
    const engine = new DuckDBEngine()
    mock.method(engine, 'getDuckDBPath', async () => null)
    await assert.rejects(
      () => engine.getRegisteredBinaryPath('pinned-source'),
      /spindb engines download duckdb 1\.4\.3/,
    )
  })

  it('retains global lookup and missing-binary fallback for unpinned UI and shells', async () => {
    delete entries.get('pinned-source')!.version
    const engine = new DuckDBEngine()
    const lookup = mock.method(engine, 'getDuckDBPath', async () => null)
    assert.equal(await engine.getRegisteredBinaryPath('pinned-source'), null)
    assert.deepEqual(lookup.mock.calls[0].arguments, [])
  })

  it('refuses UI and shell lookup for an unregistered database', async () => {
    await assert.rejects(
      () => new DuckDBEngine().getRegisteredBinaryPath('missing'),
      /not found in registry/,
    )
  })

  for (const launch of ['connect-ui', 'menu-ui', 'menu-shell']) {
    for (const missing of [false, true]) {
      it(`${launch} ${missing ? 'refuses a missing pin before spawning' : 'spawns the pinned executable'}`, async () => {
        const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
        Object.defineProperty(process.stdin, 'isTTY', {
          value: true,
          configurable: true,
        })
        const engine = getEngine(Engine.DuckDB)
        const lookup = mock.method(engine, 'getDuckDBPath', async () =>
          missing ? null : '/exact/duckdb',
        )
        const spawned: { command: string; args: string[] }[] = []
        mock.method(
          childProcess,
          'spawn',
          (command: string, args: string[]) => {
            spawned.push({ command, args })
            const child = new EventEmitter()
            queueMicrotask(() => child.emit('close', 0))
            return child as childProcess.ChildProcess
          },
        )
        syncBuiltinESMExports()
        mock.method(inquirer, 'prompt', async () => ({
          shellChoice: launch === 'menu-ui' ? 'duckdb-ui' : 'default',
        }))
        const errors: string[] = []
        mock.method(console, 'error', (...args: unknown[]) => {
          errors.push(args.join(' '))
        })
        mock.method(process, 'exit', () => {
          throw new Error('test exit')
        })
        try {
          if (launch === 'connect-ui') {
            const run = () =>
              connectCommand.parseAsync([
                'node',
                'spindb',
                'pinned-source',
                '--ui',
              ])
            if (missing) await assert.rejects(run, /test exit/)
            else await run()
          } else {
            await handleOpenShell('pinned-source')
          }
          assert.deepEqual(lookup.mock.calls[0].arguments, ['1.4.3'])
          if (missing) {
            assert.deepEqual(spawned, [])
            assert.match(
              errors.join(' '),
              /spindb engines download duckdb 1\.4\.3/,
            )
          } else {
            assert.deepEqual(spawned, [
              {
                command: '/exact/duckdb',
                args: [
                  entries.get('pinned-source')!.filePath,
                  ...(launch.endsWith('ui') ? ['-ui'] : []),
                ],
              },
            ])
          }
        } finally {
          if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty)
          else Reflect.deleteProperty(process.stdin, 'isTTY')
        }
      })
    }
  }

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
