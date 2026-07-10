/**
 * Regression test for the ClickHouse PID-write race.
 *
 * Bug: spindb's ClickHouse engine.start() only wrote the daemon PID file
 * AFTER waitForReady succeeded. When the readiness probe timed out (240s on
 * low-memory cloud containers) or when findProcessByPort hiccupped, the
 * daemon was left running but PID-fileless. spindb then reports the
 * container as "stopped" (no PID file → process-manager.isRunning returns
 * false), and the cloud's health reconciler flips the DB row to Stopped
 * despite the daemon being alive.
 *
 * Fix: writePidFromPort() is now called BEFORE waitForReady, and again
 * after, so the PID file is written iff the daemon ever managed to bind
 * the port — independent of readiness handshake.
 *
 * These tests verify the helper itself without spawning a real ClickHouse
 * server. They use a bare TCP listener as a stand-in for the daemon's
 * port-bound state, since findProcessByPort just looks at who owns the
 * TCP socket via `lsof -ti`.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'net'
import { existsSync } from 'fs'
import { mkdir, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { ClickHouseEngine } from '../../engines/clickhouse/index'

const engine = new ClickHouseEngine()

let testDir: string

function listenOnEphemeralPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address) {
        resolve({ port: address.port, server })
      } else {
        reject(new Error('No address bound'))
      }
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

describe('ClickHouse writePidFromPort (BUG-2 regression)', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-ch-pidwrite-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it('writes the listening process PID to the file when a process is bound to the port', async () => {
    const { port, server } = await listenOnEphemeralPort()
    const pidFile = join(testDir, `bound-${port}.pid`)
    try {
      const wrote = await engine.writePidFromPort(port, pidFile, {
        maxAttempts: 3,
        intervalMs: 50,
      })
      assert.equal(wrote, true, 'should report PID file was written')
      assert.equal(existsSync(pidFile), true, 'PID file should exist on disk')
      const contents = (await readFile(pidFile, 'utf8')).trim()
      assert.match(contents, /^\d+$/, 'PID file should contain a numeric PID')
      // The lsof scrape may return any process holding the port — at minimum
      // it should be a valid PID we can signal-zero. (On macOS lsof reports
      // the Node test process; on Linux CI same.) Just sanity-check it's not
      // zero or negative.
      assert.ok(
        Number(contents) > 0,
        `PID should be positive, got: ${contents}`,
      )
    } finally {
      await closeServer(server)
    }
  })

  it('returns false and does not create the file when nothing is listening on the port', async () => {
    // Pick an ephemeral port and immediately close so we know nothing is on it.
    const { port, server } = await listenOnEphemeralPort()
    await closeServer(server)

    const pidFile = join(testDir, `unbound-${port}.pid`)
    const wrote = await engine.writePidFromPort(port, pidFile, {
      maxAttempts: 2,
      intervalMs: 25,
    })
    assert.equal(wrote, false, 'should report PID file was not written')
    assert.equal(
      existsSync(pidFile),
      false,
      'PID file should not be created when no process holds the port',
    )
  })

  it('respects maxAttempts and intervalMs (bounded retry, no hang)', async () => {
    const { port, server } = await listenOnEphemeralPort()
    await closeServer(server)

    const pidFile = join(testDir, `bounded-${port}.pid`)
    const started = Date.now()
    const wrote = await engine.writePidFromPort(port, pidFile, {
      maxAttempts: 4,
      intervalMs: 50,
    })
    const elapsed = Date.now() - started

    assert.equal(wrote, false)
    // 4 attempts with 50ms between = up to ~3 sleeps of 50ms = ~150ms minimum
    // plus per-attempt lsof exec overhead. Cap at 5s to catch infinite-loop regressions.
    assert.ok(
      elapsed < 5000,
      `writePidFromPort should be bounded; took ${elapsed}ms`,
    )
  })
})
