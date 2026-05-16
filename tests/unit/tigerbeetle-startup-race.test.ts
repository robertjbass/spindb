/**
 * Regression test for the TigerBeetle startup race (BUG-7).
 *
 * Symptoms before the fix:
 *   - `tigerbeetle.test.ts` integration suite flaked ~25% of CI runs across
 *     macOS arm64, macOS x64, and Windows x64.
 *   - Failure modes:
 *       (a) "Failed to format TigerBeetle data file: ETIMEDOUT" — the
 *           `tigerbeetle format` subprocess took longer than the previous
 *           30 s budget to allocate the 1.06 GiB data file on a cold/busy
 *           CI disk.
 *       (b) "TigerBeetle failed to start within timeout" — the readiness
 *           probe used `portManager.isPortAvailable` which can fire before
 *           the daemon accepts connections; a follow-on connect then races
 *           and observes ECONNREFUSED.
 *       (c) After format succeeded but before its metadata flushed, the
 *           subsequent `start()` saw a missing/empty data file and bailed.
 *
 * The fix lives in `engines/tigerbeetle/index.ts`:
 *   - `initDataDir` runs format async with a 120 s budget and waits for the
 *     data file to be visible + non-empty before returning.
 *   - `start()` retries the data-file existence check, uses a TCP connect
 *     for readiness (with a port-bound fallback), and treats "port has a
 *     listener" as ready even when the readiness probe times out — mirroring
 *     the ClickHouse PID-race fix.
 *
 * These tests exercise the two pure helpers that the race fix introduced
 * (`waitForDataFileReady` and `waitForReady`) without spawning a real
 * TigerBeetle daemon. They protect against future regressions that revert
 * the timeouts or the polling semantics.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'net'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TigerBeetleEngine } from '../../engines/tigerbeetle/index'

const engine = new TigerBeetleEngine()

let testDir: string

function listenOnEphemeralPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      // Echo nothing; just accept the connection so TCP handshake completes.
      socket.destroy()
    })
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

describe('TigerBeetle waitForDataFileReady (BUG-7 regression)', () => {
  before(async () => {
    testDir = join(tmpdir(), `spindb-tb-startup-race-${Date.now()}`)
    await mkdir(testDir, { recursive: true })
  })

  after(async () => {
    await rm(testDir, { recursive: true, force: true }).catch(() => {})
  })

  it('returns true once the data file exists and is non-empty', async () => {
    const dataFile = join(testDir, 'visible.tigerbeetle')
    // Simulate the "format finished and flushed" state by writing a byte
    // before the probe starts.
    await writeFile(dataFile, Buffer.from([0]))

    const ready = await engine.waitForDataFileReady(dataFile, {
      maxAttempts: 5,
      intervalMs: 25,
    })
    assert.equal(ready, true, 'should observe the data file as ready')
  })

  it('returns true when the file appears mid-poll (delayed flush)', async () => {
    const dataFile = join(testDir, 'delayed.tigerbeetle')

    // Schedule the file to appear after a couple of poll cycles.
    setTimeout(() => {
      writeFile(dataFile, Buffer.alloc(64)).catch(() => {})
    }, 80)

    const ready = await engine.waitForDataFileReady(dataFile, {
      maxAttempts: 20,
      intervalMs: 25,
    })
    assert.equal(
      ready,
      true,
      'should pick up the data file once the flush completes',
    )
  })

  it('returns false when the data file never materialises (bounded retry)', async () => {
    const dataFile = join(testDir, 'missing.tigerbeetle')

    const started = Date.now()
    const ready = await engine.waitForDataFileReady(dataFile, {
      maxAttempts: 4,
      intervalMs: 25,
    })
    const elapsed = Date.now() - started

    assert.equal(ready, false, 'should report not-ready after maxAttempts')
    // 4 attempts × 25 ms inter-attempt sleep = ~75 ms; cap at 2 s to catch
    // infinite-loop regressions on slow CI runners.
    assert.ok(
      elapsed < 2000,
      `waitForDataFileReady should be bounded; took ${elapsed}ms`,
    )
  })

  it('returns false when the data file exists but is empty (partial format)', async () => {
    const dataFile = join(testDir, 'empty.tigerbeetle')
    await writeFile(dataFile, Buffer.alloc(0))

    const ready = await engine.waitForDataFileReady(dataFile, {
      maxAttempts: 3,
      intervalMs: 25,
    })
    assert.equal(
      ready,
      false,
      'an empty data file is not "ready" — TigerBeetle would refuse to start',
    )
  })
})

describe('TigerBeetle waitForReady (BUG-7 regression)', () => {
  const servers: Server[] = []

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()
      if (server) await closeServer(server)
    }
  })

  it('returns true via TCP connect when a real listener is on the port', async () => {
    const { port, server } = await listenOnEphemeralPort()
    servers.push(server)

    const ready = await engine.waitForReady(port, 5_000)
    assert.equal(
      ready,
      true,
      'should complete the TCP handshake against the stub listener',
    )
  })

  it('returns false (with bounded budget) when nothing is on the port', async () => {
    const { port, server } = await listenOnEphemeralPort()
    // Close immediately so nothing is on the port.
    await closeServer(server)

    const started = Date.now()
    const ready = await engine.waitForReady(port, 800)
    const elapsed = Date.now() - started

    assert.equal(ready, false)
    // Should give up after ~800 ms, not hang. Allow generous slack for
    // slow CI runners (Windows lsof/connect cost).
    assert.ok(
      elapsed < 5000,
      `waitForReady should respect its timeout budget; took ${elapsed}ms`,
    )
  })

  it('returns true once a listener binds mid-poll (initial probe fails, retry succeeds)', async () => {
    const { port, server: stub } = await listenOnEphemeralPort()
    await closeServer(stub)

    let realServer: Server | null = null
    setTimeout(async () => {
      try {
        realServer = createServer((socket) => socket.destroy())
        await new Promise<void>((resolve, reject) => {
          realServer!.once('error', reject)
          realServer!.listen(port, '127.0.0.1', () => resolve())
        })
        servers.push(realServer)
      } catch {
        // If port is unavailable on this CI runner, the assertion below
        // will just fail naturally — not an infinite hang.
      }
    }, 200)

    const ready = await engine.waitForReady(port, 5_000)
    assert.equal(
      ready,
      true,
      'should accept the listener that binds after the first probe',
    )
  })
})
