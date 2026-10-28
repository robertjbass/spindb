import { describe, it, before, after } from 'node:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  KV_SAVE_BYTES_PER_SECOND,
  KV_SHUTDOWN_BASE_WAIT_MS,
  KvSaveFailedError,
  KvStopRefusedError,
  isAuthRejection,
  isShutdownRefusal,
  kvShutdownBudgetMs,
  parseUsedMemoryBytes,
  readTempRdbProgress,
  stopKvServer,
  waitForKvExit,
  type SaveProgress,
  type ShutdownSaveResult,
} from '../../core/kv-shutdown'

// A fake clock: sleep advances time, so long waits run instantly.
function fakeClock() {
  let now = 0
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('kvShutdownBudgetMs', () => {
  it('scales with the dataset size', () => {
    assertEqual(
      kvShutdownBudgetMs(0),
      KV_SHUTDOWN_BASE_WAIT_MS,
      'empty dataset',
    )
    const big = 1.4 * 1024 * 1024 * 1024
    const budget = kvShutdownBudgetMs(big)
    assertEqual(
      budget,
      KV_SHUTDOWN_BASE_WAIT_MS +
        Math.ceil(big / KV_SAVE_BYTES_PER_SECOND) * 1000,
      'formula',
    )
    // A measured 1.4 GB save took ~25 s; the budget must cover it with room.
    assert(budget > 100_000, `1.4 GB budget ${budget}ms covers a 25 s save`)
  })

  it('treats garbage as an empty dataset', () => {
    assertEqual(kvShutdownBudgetMs(Number.NaN), KV_SHUTDOWN_BASE_WAIT_MS, 'NaN')
    assertEqual(kvShutdownBudgetMs(-5), KV_SHUTDOWN_BASE_WAIT_MS, 'negative')
  })
})

describe('INFO and reply parsing', () => {
  it('reads used_memory from INFO memory', () => {
    const info =
      '# Memory\r\nused_memory:1503238553\r\nused_memory_human:1.40G\r\n'
    assertEqual(parseUsedMemoryBytes(info), 1503238553, 'used_memory')
    assertEqual(parseUsedMemoryBytes('nothing'), null, 'missing')
  })

  it('recognizes a refused shutdown', () => {
    assert(
      isShutdownRefusal('ERR Errors trying to SHUTDOWN. Check logs.'),
      'redis/valkey',
    )
    assert(!isShutdownRefusal(''), 'empty')
  })
})

describe('readTempRdbProgress', () => {
  let dir: string
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kv-shutdown-'))
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns null with no temp RDB and ignores dump.rdb', async () => {
    await writeFile(join(dir, 'dump.rdb'), 'x')
    assertEqual(await readTempRdbProgress(dir, 4242), null, 'no temp file')
  })

  it("reports only the server's own temp RDB, not a BGSAVE child's", async () => {
    await writeFile(join(dir, 'temp-4242.rdb'), 'abcdef')
    await writeFile(join(dir, 'temp-5555.rdb'), 'child')
    assertEqual((await readTempRdbProgress(dir, 4242))?.size, 6, 'own save')
    assertEqual(await readTempRdbProgress(dir, 1), null, 'other pids ignored')
  })

  it('returns null for a missing dir', async () => {
    assertEqual(await readTempRdbProgress(join(dir, 'nope'), 1), null, 'dir')
  })
})

describe('reply classification', () => {
  it('recognizes auth and permission rejections', () => {
    assert(isAuthRejection('NOAUTH Authentication required.'), 'NOAUTH')
    assert(
      isAuthRejection('WRONGPASS invalid username-password pair'),
      'WRONGPASS',
    )
    assert(
      isAuthRejection(
        "NOPERM User x has no permissions to run the 'shutdown' command",
      ),
      'NOPERM',
    )
    assert(!isAuthRejection(''), 'empty')
  })
})

describe('waitForKvExit', () => {
  it('keeps waiting past the budget while the snapshot grows', async () => {
    const clock = fakeClock()
    let size = 0
    const result = await waitForKvExit({
      pid: 1,
      dataDir: '/x',
      budgetMs: 10_000,
      stallMs: 5_000,
      deps: {
        now: clock.now,
        sleep: clock.sleep,
        isRunning: () => clock.now() < 200_000,
        readProgress: async (): Promise<SaveProgress> => {
          size += 1
          return { size, mtimeMs: clock.now() }
        },
      },
    })
    assertEqual(result, 'exited', 'never gives up on a progressing save')
  })

  it('reports a snapshot that stopped changing as stuck, after the budget', async () => {
    const clock = fakeClock()
    const result = await waitForKvExit({
      pid: 1,
      dataDir: '/x',
      budgetMs: 10_000,
      stallMs: 5_000,
      deps: {
        now: clock.now,
        sleep: clock.sleep,
        isRunning: () => true,
        readProgress: async () => ({ size: 10, mtimeMs: 1 }),
      },
    })
    assertEqual(result, 'stuck', 'unchanged temp file')
    assert(clock.now() >= 10_000, 'waited the full budget')
  })

  it('reports idle once the budget is spent with no snapshot', async () => {
    const clock = fakeClock()
    const result = await waitForKvExit({
      pid: 1,
      dataDir: '/x',
      budgetMs: 10_000,
      deps: {
        now: clock.now,
        sleep: clock.sleep,
        isRunning: () => true,
        readProgress: async () => null,
      },
    })
    assertEqual(result, 'idle', 'idle')
  })

  it('returns exited as soon as the process is gone', async () => {
    const clock = fakeClock()
    const result = await waitForKvExit({
      pid: 1,
      dataDir: '/x',
      budgetMs: 10_000,
      deps: {
        now: clock.now,
        sleep: clock.sleep,
        isRunning: () => clock.now() < 1_000,
        readProgress: async () => null,
      },
    })
    assertEqual(result, 'exited', 'exit')
    assert(clock.now() < 2_000, 'did not wait the budget')
  })
})

describe('stopKvServer', () => {
  type RunOptions = {
    result: ShutdownSaveResult
    pid?: number | null
    exitAt?: number
    exitOnSignal?: 'SIGTERM'
    serving?: boolean
    saving?: (now: number) => SaveProgress
  }

  function harness() {
    const signals: string[] = []
    const clock = fakeClock()
    const run = async (o: RunOptions) => {
      let exited = false
      await stopKvServer({
        engineLabel: 'Valkey',
        pid: o.pid === undefined ? 99 : o.pid,
        dataDir: '/nonexistent-kv-dir',
        readUsedMemory: async () => 1024 * 1024 * 1024,
        sendShutdownSave: async () => o.result,
        isServing: async () => Boolean(o.serving),
        terminate: async (_pid, force) => {
          signals.push(force ? 'SIGKILL' : 'SIGTERM')
          if (force || o.exitOnSignal === 'SIGTERM') {
            exited = true
          }
        },
        stallMs: 5_000,
        deps: {
          now: clock.now,
          sleep: clock.sleep,
          isRunning: () =>
            !exited && (o.exitAt === undefined || clock.now() < o.exitAt),
          readProgress: async () => o.saving?.(clock.now()) ?? null,
        },
      })
    }
    const runCatching = async (o: RunOptions) => {
      try {
        await run(o)
        return null
      } catch (error) {
        return error
      }
    }
    return { signals, clock, run, runCatching }
  }

  it('never signals a server that exits after a long save', async () => {
    const h = harness()
    // Exits 90 s after SHUTDOWN SAVE returned (old code killed at ~4 s).
    await h.run({ result: { kind: 'ok', output: '' }, exitAt: 90_000 })
    assertEqual(h.signals.length, 0, `no signals, got ${h.signals.join(',')}`)
  })

  it('keeps waiting when the CLI times out mid-save', async () => {
    const h = harness()
    await h.run({
      result: { kind: 'timeout' },
      exitAt: 600_000,
      saving: (now) => (now < 600_000 ? { size: now, mtimeMs: now } : null),
    })
    assertEqual(h.signals.length, 0, 'a progressing save is never signalled')
  })

  it('leaves a stuck save running and throws instead of killing it', async () => {
    const h = harness()
    const error = await h.runCatching({
      result: { kind: 'timeout' },
      saving: () => ({ size: 10, mtimeMs: 1 }),
    })
    assert(error instanceof KvStopRefusedError, 'KvStopRefusedError')
    assertEqual(h.signals.length, 0, 'no signal during a save')
  })

  it('throws on a refused save, even without a pid', async () => {
    for (const pid of [99, null]) {
      const h = harness()
      const error = await h.runCatching({
        pid,
        result: {
          kind: 'ok',
          output: 'ERR Errors trying to SHUTDOWN. Check logs.',
        },
      })
      assert(
        error instanceof KvSaveFailedError,
        `KvSaveFailedError (pid ${pid})`,
      )
      assertEqual(h.signals.length, 0, 'no signal after a refused save')
    }
  })

  it('throws on an auth rejection instead of signalling', async () => {
    const h = harness()
    const error = await h.runCatching({
      result: { kind: 'ok', output: 'NOPERM no permissions' },
    })
    assert(error instanceof KvStopRefusedError, 'KvStopRefusedError')
    assertEqual(h.signals.length, 0, 'no signal')
  })

  it('throws when the server is still serving after a timed-out shutdown', async () => {
    const h = harness()
    const error = await h.runCatching({
      result: { kind: 'timeout' },
      serving: true,
    })
    assert(error instanceof KvSaveFailedError, 'still serving = save failed')
    assertEqual(h.signals.length, 0, 'no signal to a serving server')
  })

  it('sends SIGTERM straight away when the CLI could not connect', async () => {
    const h = harness()
    await h.run({
      result: {
        kind: 'error',
        output: 'Connection refused',
        message: 'refused',
      },
      exitOnSignal: 'SIGTERM',
    })
    assertEqual(h.signals.join(','), 'SIGTERM', 'SIGTERM only')
    assert(h.clock.now() < 1_000, 'did not wait a budget first')
  })

  it('never sends SIGKILL: a hung server is left running with an error', async () => {
    const h = harness()
    const error = await h.runCatching({ result: { kind: 'ok', output: '' } })
    assert(error instanceof KvStopRefusedError, 'refused, not killed')
    assertEqual(h.signals.join(','), 'SIGTERM', 'SIGTERM only')
  })

  it('refuses when the pid is unknown and the shutdown timed out', async () => {
    const h = harness()
    const error = await h.runCatching({
      pid: null,
      result: { kind: 'timeout' },
    })
    assert(error instanceof KvStopRefusedError, 'cannot confirm the exit')
  })
})
