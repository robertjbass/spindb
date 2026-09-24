/**
 * listDatabases honors an abort signal on the engines with durable database
 * existence, and the presence probe aborts it on timeout. A client process
 * left running with piped stdio keeps Node alive, so `spindb start` would
 * never return after a successful start: the child must actually die.
 *
 * Each engine's client binary is replaced by a shell script that records its
 * PID and then sleeps, so the test proves a real process is killed without
 * needing the engine binaries.
 */

import { describe, it, before, after } from 'node:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getEngine } from '../../engines'
import { probeDatabasePresence } from '../../core/database-presence'
import { Engine, type ContainerConfig } from '../../types'
import { assert, assertEqual } from '../utils/assertions'

const isWindows = process.platform === 'win32'

// The binary getter each engine's listDatabases resolves its client through
const CLIENT_GETTERS: Record<string, string> = {
  [Engine.PostgreSQL]: 'getPsqlPath',
  [Engine.MariaDB]: 'getMariadbClientPath',
  [Engine.MySQL]: 'getMysqlClientPath',
  [Engine.CockroachDB]: 'getCockroachPath',
  [Engine.ClickHouse]: 'getClickHouseClientPath',
}

function makeConfig(engine: Engine): ContainerConfig {
  return {
    name: 'abort-test',
    engine,
    version: '1.0.0',
    port: 1,
    database: 'app',
    created: new Date().toISOString(),
    status: 'running',
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return condition()
}

describe('presence probe abort signal', () => {
  it('aborts the listing signal on timeout', async () => {
    let seen: AbortSignal | undefined
    const probe = await probeDatabasePresence({
      engine: {
        listDatabases: (_container, options) => {
          seen = options?.signal
          return new Promise<string[]>(() => {})
        },
      },
      container: makeConfig(Engine.MariaDB),
      name: 'app',
      timeoutMs: 30,
    })
    assertEqual(probe.presence, 'unknown', 'presence')
    assert(seen !== undefined, 'the listing should receive a signal')
    assertEqual(seen.aborted, true, 'signal should be aborted on timeout')
  })

  it('does not abort the signal when the listing answers in time', async () => {
    let seen: AbortSignal | undefined
    const probe = await probeDatabasePresence({
      engine: {
        async listDatabases(_container, options) {
          seen = options?.signal
          return ['app']
        },
      },
      container: makeConfig(Engine.MariaDB),
      name: 'app',
      timeoutMs: 1000,
    })
    assertEqual(probe.presence, true, 'presence')
    assert(seen !== undefined, 'the listing should receive a signal')
    assertEqual(seen.aborted, false, 'signal should not be aborted')
  })
})

describe(
  'listDatabases kills its client on abort (durable engines)',
  { skip: isWindows ? 'uses a POSIX shell script as the client' : false },
  () => {
    let dir: string

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), 'spindb-list-abort-'))
    })

    after(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    async function makeHangingClient(label: string) {
      const pidFile = join(dir, `${label}.pid`)
      const script = join(dir, `${label}.sh`)
      // exec keeps the PID, so the recorded PID is the sleeping process
      await writeFile(
        script,
        `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`,
      )
      await chmod(script, 0o755)
      return { script, pidFile }
    }

    for (const engine of Object.keys(CLIENT_GETTERS) as Engine[]) {
      it(`${engine}: an aborted listing rejects promptly and the client exits`, async () => {
        const { script, pidFile } = await makeHangingClient(engine)
        const instance = Object.create(getEngine(engine)) as Record<
          string,
          unknown
        > &
          ReturnType<typeof getEngine>
        instance[CLIENT_GETTERS[engine]] = async () => script
        instance.getLocalAdminAuth = async () => ({ user: 'root' })

        const controller = new AbortController()
        const listing = instance.listDatabases(makeConfig(engine), {
          signal: controller.signal,
        })
        const settled = listing.then(
          () => 'resolved',
          () => 'rejected',
        )

        assert(
          await waitFor(() => existsSync(pidFile), 5000),
          'client script should start',
        )
        const pid = Number((await readFile(pidFile, 'utf8')).trim())
        assert(isAlive(pid), 'client should be running before the abort')

        const abortedAt = Date.now()
        controller.abort()
        // A ref'd guard timer, cleared afterward, so the await can never
        // depend on some other handle keeping the event loop alive
        let guard: ReturnType<typeof setTimeout> | undefined
        const outcome = await Promise.race([
          settled,
          new Promise((resolve) => {
            guard = setTimeout(() => resolve('hung'), 3000)
          }),
        ])
        clearTimeout(guard)
        assertEqual(outcome, 'rejected', 'aborted listing should reject')
        assert(
          await waitFor(() => !isAlive(pid), 3000),
          `client process ${pid} should exit after the abort`,
        )
        assert(
          Date.now() - abortedAt < 3000,
          'abort should take effect promptly',
        )
      })
    }
  },
)
