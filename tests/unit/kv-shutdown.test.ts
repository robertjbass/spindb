import { describe, it, before, after } from 'node:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, assertEqual } from '../utils/assertions'
import {
  KV_SAVE_BYTES_PER_SECOND,
  KV_SHUTDOWN_BASE_WAIT_MS,
  KvSaveFailedError,
  isShutdownRefusal,
  kvShutdownBudgetMs,
  parseUsedMemoryBytes,
  readTempRdbProgress,
  stopKvServer,
  waitForKvExit,
  type KvWaitDeps,
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
    assertEqual(await readTempRdbProgress(dir), null, 'no temp file')
  })

  it('reports the temp RDB being written', async () => {
    await writeFile(join(dir, 'temp-4242.rdb'), 'abcdef')
    const progress = await readTempRdbProgress(dir)
    assertEqual(progress?.size, 6, 'size')
  })

  it('returns null for a missing dir', async () => {
    assertEqual(
      await readTempRdbProgress(join(dir, 'nope')),
      null,
      'missing dir',
    )
  })
})

describe('waitForKvExit', () => {
  it('keeps waiting past the budget while the temp RDB grows', async () => {
    const clock = fakeClock()
    let size = 0
    const deps: Partial<KvWaitDeps> = {
      now: clock.now,
      sleep: clock.sleep,
      // The save grows for 200 s, far past the 10 s budget, then exits.
      isRunning: () => clock.now() < 200_000,
      readProgress: async (): Promise<SaveProgress> => {
        size += 1
        return { size, mtimeMs: clock.now() }
      },
    }
    const result = await waitForKvExit({
      pid: 1,
      dataDir: '/x',
      budgetMs: 10_000,
      stallMs: 5_000,
      deps,
    })
    assertEqual(result, 'exited', 'never gives up on a progressing save')
  })

  it('gives up only after the budget AND a stall', async () => {
    const clock = fakeClock()
    const deps: Partial<KvWaitDeps> = {
      now: clock.now,
      sleep: clock.sleep,
      isRunning: () => true,
      readProgress: async () => ({ size: 10, mtimeMs: 1 }),
    }
    const result = await waitForKvExit({
      pid: 1,
      dataDir: '/x',
      budgetMs: 10_000,
      stallMs: 5_000,
      deps,
    })
    assertEqual(result, 'stalled', 'stuck temp file')
    assert(clock.now() >= 10_000, 'waited the full budget')
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
  type Harness = {
    signals: string[]
    clock: ReturnType<typeof fakeClock>
    run: (options: {
      result: ShutdownSaveResult
      exitAt?: number
      exitOnSignal?: 'SIGTERM'
      saving?: (now: number) => boolean
    }) => Promise<void>
  }

  function harness(): Harness {
    const signals: string[] = []
    const clock = fakeClock()
    return {
      signals,
      clock,
      run: async ({ result, exitAt, exitOnSignal, saving }) => {
        let exited = false
        await stopKvServer({
          engineLabel: 'Valkey',
          pid: 99,
          dataDir: '/nonexistent-kv-dir',
          readUsedMemory: async () => 1024 * 1024 * 1024,
          sendShutdownSave: async () => result,
          terminate: async (_pid, force) => {
            signals.push(force ? 'SIGKILL' : 'SIGTERM')
            if (force || exitOnSignal === 'SIGTERM') exited = true
          },
          stallMs: 5_000,
          deps: {
            now: clock.now,
            sleep: clock.sleep,
            isRunning: () =>
              !exited && (exitAt === undefined || clock.now() < exitAt),
            readProgress: async () =>
              saving?.(clock.now())
                ? { size: clock.now(), mtimeMs: clock.now() }
                : null,
          },
        })
      },
    }
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
      saving: (now) => now < 600_000,
    })
    assertEqual(h.signals.length, 0, 'a progressing save is never signalled')
  })

  it('throws and leaves the server running when the save is refused', async () => {
    const h = harness()
    let threw: unknown = null
    try {
      await h.run({
        result: {
          kind: 'ok',
          output: 'ERR Errors trying to SHUTDOWN. Check logs.',
        },
      })
    } catch (error) {
      threw = error
    }
    assert(threw instanceof KvSaveFailedError, 'KvSaveFailedError')
    assertEqual(h.signals.length, 0, 'no signal after a refused save')
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

  it('force kills only a hung server with no save progress', async () => {
    const h = harness()
    await h.run({ result: { kind: 'ok', output: '' } })
    assertEqual(h.signals.join(','), 'SIGTERM,SIGKILL', 'escalation order')
  })
})
