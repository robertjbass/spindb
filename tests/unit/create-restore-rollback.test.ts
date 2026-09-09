/**
 * `spindb create --from <dump>` must not leave a container behind when the
 * restore fails outright.
 *
 * The create flow is transactional: every failure between "container created"
 * and "commit" rolls the TransactionManager back, so the container, its data
 * directory and its running server are cleaned up. The restore verdict added
 * in 0.69.0 threw from inside that try without rolling back first, and the
 * outer catch only reports the error (`tx` is scoped to the try block), so a
 * FATAL restore orphaned a running container holding a half-imported database.
 *
 * A PARTIAL restore is deliberately not rolled back: the objects that landed
 * are usable, and the diagnostics say what did not.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createCommand } from '../../cli/commands/create'
import { containerManager } from '../../core/container-manager'
import { portManager } from '../../core/port-manager'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { postgresqlEngine } from '../../engines/postgresql'
import { Engine, type ContainerConfig, type RestoreResult } from '../../types'

const CONTAINER = 'rollbacktest'
const PORT = 55432

const CONFIG: ContainerConfig = {
  name: CONTAINER,
  engine: Engine.PostgreSQL,
  version: '17.0.0',
  port: PORT,
  database: CONTAINER,
  databases: [CONTAINER],
  created: '2026-01-01T00:00:00.000Z',
  status: 'running',
}

class ProcessExited extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

type Calls = {
  created: string[]
  deleted: string[]
  stopped: string[]
  restoreOptions: Record<string, unknown>[]
  stdout: string[]
  exitCode: number | null
}

let dumpPath: string
let calls: Calls

function stubCreateFlow(restoreResult: RestoreResult): void {
  // Dependency probing: pretend every client tool is already installed so the
  // create does not stop at the tool check on a machine without psql.
  mock.method(configManager, 'getBinaryPath', async () => '/fake/bin/psql')
  mock.method(platformService, 'findToolPath', async () => '/fake/bin/psql')
  mock.method(platformService, 'getToolVersion', async () => '17.0')

  mock.method(portManager, 'findAvailablePort', async () => ({
    port: PORT,
    isDefault: true,
  }))

  mock.method(containerManager, 'exists', async () => false)
  mock.method(containerManager, 'create', async (name: string) => {
    calls.created.push(name)
    return CONFIG
  })
  mock.method(containerManager, 'delete', async (name: string) => {
    calls.deleted.push(name)
  })
  mock.method(containerManager, 'getConfig', async () => ({ ...CONFIG }))
  mock.method(containerManager, 'updateConfig', async () => ({ ...CONFIG }))

  mock.method(postgresqlEngine, 'ensureBinaries', async () => '/fake/bin')
  mock.method(postgresqlEngine, 'initDataDir', async () => {})
  mock.method(postgresqlEngine, 'start', async () => {})
  mock.method(postgresqlEngine, 'stop', async (config: ContainerConfig) => {
    calls.stopped.push(config.name)
  })
  mock.method(postgresqlEngine, 'createDatabase', async () => {})
  mock.method(postgresqlEngine, 'detectBackupFormat', async () => ({
    format: 'custom',
    description: 'PostgreSQL custom-format dump',
    restoreCommand: 'pg_restore',
  }))
  mock.method(
    postgresqlEngine,
    'restore',
    async (
      _config: ContainerConfig,
      _backupPath: string,
      restoreOptions: Record<string, unknown> = {},
    ) => {
      calls.restoreOptions.push(restoreOptions)
      return restoreResult
    },
  )
  mock.method(
    postgresqlEngine,
    'getConnectionString',
    () => `postgresql://postgres@127.0.0.1:${PORT}/${CONTAINER}`,
  )

  mock.method(console, 'log', (...args: unknown[]) => {
    calls.stdout.push(args.map(String).join(' '))
  })
  mock.method(process, 'exit', (code?: number): never => {
    calls.exitCode = code ?? 0
    throw new ProcessExited(code ?? 0)
  })
}

async function runCreate(extraArgs: string[] = []): Promise<void> {
  try {
    await createCommand.parseAsync(
      [
        CONTAINER,
        '--engine',
        'postgresql',
        '--from',
        dumpPath,
        '--json',
        ...extraArgs,
      ],
      { from: 'user' },
    )
  } catch (error) {
    if (!(error instanceof ProcessExited)) throw error
  }
}

function jsonOutput(): Record<string, unknown> {
  const line = calls.stdout.find((l) => l.trim().startsWith('{'))
  assert.ok(line, `no JSON on stdout, got: ${JSON.stringify(calls.stdout)}`)
  return JSON.parse(line) as Record<string, unknown>
}

describe('create --from rollback', () => {
  beforeEach(() => {
    dumpPath = join(tmpdir(), `spindb-create-rollback-${process.pid}.dump`)
    writeFileSync(dumpPath, 'PGDMP fake dump')
    calls = {
      created: [],
      deleted: [],
      stopped: [],
      restoreOptions: [],
      stdout: [],
      exitCode: null,
    }
  })

  afterEach(() => {
    mock.restoreAll()
    rmSync(dumpPath, { force: true })
  })

  it('rolls the container back when the restore fails', async () => {
    stubCreateFlow({
      format: 'custom',
      code: 1,
      stderr:
        'pg_restore: error: connection to server was lost\nFATAL:  terminating connection due to administrator command',
    })

    await runCreate()

    assert.deepEqual(calls.created, [CONTAINER], 'the container was created')
    assert.deepEqual(
      calls.deleted,
      [CONTAINER],
      'the failed restore rolled the container back exactly once',
    )
    assert.deepEqual(
      calls.stopped,
      [CONTAINER],
      'and stopped the server it had started',
    )
    assert.equal(calls.exitCode, 1, 'the create exits non-zero')

    const output = jsonOutput()
    assert.match(
      String(output.error),
      /FATAL/,
      '--json reports what the restore tool said',
    )
  })

  it('keeps the container when the restore only lost objects', async () => {
    stubCreateFlow({
      format: 'custom',
      code: 1,
      stderr: [
        'pg_restore: error: could not execute query: ERROR:  extension "uuid-ossp" is not available',
        'pg_restore: warning: errors ignored on restore: 19',
      ].join('\n'),
    })

    await runCreate()

    assert.deepEqual(calls.created, [CONTAINER], 'the container was created')
    assert.deepEqual(
      calls.deleted,
      [],
      'a partial restore keeps the data that did land',
    )
    assert.equal(calls.exitCode, null, 'and the create succeeds')

    const output = jsonOutput()
    assert.equal(output.success, true)
    assert.equal(output.restoreStatus, 'completed_with_errors')
  })

  it('drops the dump privileges unless --with-privileges is passed', async () => {
    stubCreateFlow({ format: 'custom', code: 0, stderr: '' })

    await runCreate()

    assert.equal(
      calls.restoreOptions[0]?.withPrivileges,
      undefined,
      'the default restore keeps pg_restore --no-privileges',
    )
    assert.equal(jsonOutput().privilegesRestored, undefined)
  })

  it('passes --with-privileges through to the restore', async () => {
    stubCreateFlow({ format: 'custom', code: 0, stderr: '' })

    await runCreate(['--with-privileges'])

    assert.equal(
      calls.restoreOptions[0]?.withPrivileges,
      true,
      'the engine is told to replay the dump GRANTs',
    )
    assert.equal(
      jsonOutput().privilegesRestored,
      true,
      '--json says the privileges were restored',
    )
  })

  it('refuses --with-privileges on an engine whose restore never drops them', async () => {
    stubCreateFlow({ format: 'custom', code: 0, stderr: '' })

    try {
      await createCommand.parseAsync(
        [
          CONTAINER,
          '--engine',
          'mysql',
          '--from',
          dumpPath,
          '--json',
          '--with-privileges',
        ],
        { from: 'user' },
      )
    } catch (error) {
      if (!(error instanceof ProcessExited)) throw error
    }

    assert.equal(calls.exitCode, 1, 'the create refuses to run')
    assert.deepEqual(calls.created, [], 'nothing was created')
    assert.match(String(jsonOutput().error), /--with-privileges/)
  })
})
