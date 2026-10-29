import { describe, it, before, after } from 'node:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { assert, assertDeepEqual, assertEqual } from '../utils/assertions'
import {
  KV_SAVE_BYTES_PER_SECOND,
  KV_SHUTDOWN_BASE_WAIT_MS,
  KvSaveFailedError,
  KvStopRefusedError,
  isAuthRejection,
  isKvPortProvenFree,
  attributeListeners,
  configPathFromCommandLine,
  normalizeForMatch,
  parseNetstatListeners,
  classifyKvPort,
  listListenerCwds,
  kvProbeHosts,
  type ConnectProbe,
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
    portHeld?: boolean
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
        isServerGone: async () => !o.portHeld,
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

  it('without a pid, a failed shutdown is success only when the port is free', async () => {
    const free = harness()
    await free.run({
      pid: null,
      result: {
        kind: 'error',
        output: 'Connection refused',
        message: 'refused',
      },
    })
    const held = harness()
    const error = await held.runCatching({
      pid: null,
      portHeld: true,
      result: {
        kind: 'error',
        output: 'Connection refused',
        message: 'refused',
      },
    })
    assert(
      error instanceof KvStopRefusedError,
      'unreachable server on a held port',
    )
  })
})

describe('isKvPortProvenFree', () => {
  const probeWith =
    (
      answers: Record<string, Awaited<ReturnType<ConnectProbe>>>,
    ): ConnectProbe =>
    async (host) =>
      answers[host] ?? 'refused'

  it('probes every bind address plus both loopbacks', () => {
    assertDeepEqual(
      kvProbeHosts('10.0.0.5 -::1').sort(),
      ['10.0.0.5', '127.0.0.1', '::1'].sort(),
      'hosts',
    )
    assertDeepEqual(
      kvProbeHosts('0.0.0.0').sort(),
      ['127.0.0.1', '::1'].sort(),
      'wildcard',
    )
  })

  it('is free only when every address refuses', async () => {
    assert(
      await isKvPortProvenFree({ port: 1, probe: probeWith({}) }),
      'all refused',
    )
    assert(
      await isKvPortProvenFree({
        port: 1,
        probe: probeWith({ '::1': 'unusable' }),
      }),
      'no IPv6 loopback on this host',
    )
  })

  it('fails closed on a listener on ::1, a timeout, or an unusable bind address', async () => {
    assert(
      !(await isKvPortProvenFree({
        port: 1,
        probe: probeWith({ '::1': 'open' }),
      })),
      '::1 listener',
    )
    assert(
      !(await isKvPortProvenFree({
        port: 1,
        probe: probeWith({ '127.0.0.1': 'unknown' }),
      })),
      'timeout',
    )
    assert(
      !(await isKvPortProvenFree({
        port: 1,
        bindAddress: '10.0.0.5',
        probe: probeWith({ '10.0.0.5': 'unusable' }),
      })),
      'unusable configured address',
    )
  })

  it('sees a real listener on ::1 or 127.0.0.1', async () => {
    const { createServer } = await import('net')
    for (const host of ['127.0.0.1', '::1']) {
      const server = createServer()
      const bound = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false))
        server.listen(0, host, () => resolve(true))
      })
      if (!bound) continue
      const { port } = server.address() as { port: number }
      assert(!(await isKvPortProvenFree({ port })), `listener on ${host}`)
      await new Promise((resolve) => server.close(resolve))
      assert(await isKvPortProvenFree({ port }), `closed on ${host}`)
    }
  })
})

describe('classifyKvPort', () => {
  const open: ConnectProbe = async () => 'open'
  it('is free when nothing listens', async () => {
    assertEqual(
      await classifyKvPort({
        port: 1,
        dataDir: '/a',
        probe: async () => 'refused',
      }),
      'free',
      'free',
    )
  })
  it('lets a different server reusing the port through', async () => {
    assertEqual(
      await classifyKvPort({
        port: 1,
        dataDir: '/a/data',
        probe: open,
        listListeners: async () => ['/b/data'],
        resolvePath: async (path: string) => path,
      }),
      'other',
      'port reused by another server',
    )
  })
  it('fails closed on its own server or an unidentified listener', async () => {
    assertEqual(
      await classifyKvPort({
        port: 1,
        dataDir: '/a/data',
        probe: open,
        listListeners: async () => ['/b/data', '/a/data'],
      }),
      'maybe',
      'own server',
    )
    assertEqual(
      await classifyKvPort({
        port: 1,
        dataDir: '/a/data',
        probe: open,
        listListeners: async () => null,
      }),
      'maybe',
      'cannot tell',
    )
  })

  it('identifies a real listener by its working directory', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return
    const { spawn } = await import('child_process')
    // The real layout: containers/<engine>/<name>/data, one dir per container.
    const root = await mkdtemp(join(tmpdir(), 'kv-containers-'))
    const mine = join(root, 'a', 'data')
    const other = join(root, 'b', 'data')
    const { mkdir } = await import('fs/promises')
    await mkdir(mine, { recursive: true })
    await mkdir(other, { recursive: true })
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const s=require('net').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))",
      ],
      { cwd: other, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    try {
      const port = await new Promise<number>((resolve) =>
        child.stdout!.once('data', (data) =>
          resolve(Number(String(data).trim())),
        ),
      )
      const cwds = await listListenerCwds(port)
      if (cwds === null) return // listener discovery unavailable here
      assertEqual(
        await classifyKvPort({ port, dataDir: mine }),
        'other',
        'stopped container whose port another server reuses',
      )
      assertEqual(
        await classifyKvPort({ port, dataDir: other }),
        'maybe',
        'its own listener',
      )
    } finally {
      child.kill()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('attributeListeners', () => {
  it('fails closed when one of two listeners cannot be attributed', () => {
    // The unrelated process on 127.0.0.1 is readable; the real server, another
    // user's process on ::1, is not.
    const result = attributeListeners({
      listeners: [
        { id: '111', host: '127.0.0.1' },
        { id: '222', host: '::1' },
      ],
      cwdById: new Map([['111', '/srv/unrelated']]),
    })
    assertEqual(result, null, 'partial attribution is unknown')
  })

  it('fails closed when an answering address has no visible listener', () => {
    const result = attributeListeners({
      listeners: [{ id: '111', host: '127.0.0.1' }],
      cwdById: new Map([['111', '/srv/unrelated']]),
      answeringHosts: ['127.0.0.1', '::1'],
    })
    assertEqual(result, null, '::1 answered but nothing visible listens there')
  })

  it('returns every cwd when the answer is complete', () => {
    const result = attributeListeners({
      listeners: [
        { id: '111', host: '127.0.0.1' },
        { id: '222', host: '*' },
      ],
      cwdById: new Map([
        ['111', '/a'],
        ['222', '/b'],
      ]),
      answeringHosts: ['127.0.0.1', '::1'],
    })
    assertDeepEqual(result, ['/a', '/b'], 'complete')
  })
})

describe('Windows listener identification', () => {
  it('parses netstat LISTENING rows for the port', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:6379           0.0.0.0:0              LISTENING       4120',
      '  TCP    127.0.0.1:6380         0.0.0.0:0              LISTENING       999',
      '  TCP    127.0.0.1:6379         127.0.0.1:51000        ESTABLISHED     77',
      '  TCP    [::1]:6379             [::]:0                 LISTENING       5000',
      '  TCP    [::]:6379              [::]:0                 LISTENING       4120',
    ].join('\r\n')
    assertDeepEqual(
      parseNetstatListeners(out, 6379),
      [
        { pid: '4120', host: '*' },
        { pid: '5000', host: '::1' },
        { pid: '4120', host: '*' },
      ],
      'listeners on 6379 only, LISTENING only',
    )
  })

  it('extracts the config path from a command line', () => {
    assertEqual(
      configPathFromCommandLine(
        '"C:\\Program Files\\redis\\redis-server.exe" /cygdrive/c/Users/Me/.spindb/containers/redis/a/redis.conf',
      ),
      'C:/Users/Me/.spindb/containers/redis/a/redis.conf',
      'cygdrive argument',
    )
    assertEqual(
      configPathFromCommandLine(
        'valkey-server.exe "D:\\spin db\\containers\\valkey\\b\\valkey.conf"',
      ),
      'D:\\spin db\\containers\\valkey\\b\\valkey.conf',
      'quoted path with a space',
    )
    assertEqual(
      configPathFromCommandLine('redis-server.exe --port 6379'),
      null,
      'no config',
    )
  })

  it('normalizes paths, case-folding only where the filesystem does', () => {
    assertEqual(
      normalizeForMatch('C:\\Users\\Me\\.spindb\\', 'win32'),
      'c:/users/me/.spindb',
      'windows',
    )
    assertEqual(
      normalizeForMatch('/cygdrive/c/Users/Me', 'win32'),
      'c:/users/me',
      'cygdrive',
    )
    assertEqual(
      normalizeForMatch('/srv/Data', 'linux'),
      '/srv/Data',
      'linux keeps case',
    )
  })

  // A stubbed realpath: the .spindb directory is a junction to D:\spindb.
  const junction = async (path: string) => {
    const p = path.replace(/\\/g, '/')
    if (/^C:\/Users\/Me\/\.spindb/i.test(p))
      return p.replace(/^C:\/Users\/Me\/\.spindb/i, 'D:/spindb')
    if (/^D:\/spindb/i.test(p)) return p
    if (/^D:\/other/i.test(p)) return p
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  const open: ConnectProbe = async () => 'open'

  it('treats its own server behind a junction as its own (never "other")', async () => {
    // Our dataDir arrives through the junction-resolved home; the server's
    // command line still names the C: path.
    assertEqual(
      await classifyKvPort({
        port: 1,
        dataDir: 'D:/spindb/containers/redis/a/data',
        probe: open,
        platform: 'win32',
        resolvePath: junction,
        listListeners: async () => [
          'C:/Users/Me/.spindb/containers/redis/a/redis.conf',
        ],
      }),
      'maybe',
      'raw paths differ, resolved paths match',
    )
  })

  it('never infers "other" from a listener path that cannot be resolved', async () => {
    assertEqual(
      await classifyKvPort({
        port: 1,
        dataDir: 'D:/spindb/containers/redis/a/data',
        probe: open,
        platform: 'win32',
        resolvePath: junction,
        listListeners: async () => ['E:/gone/containers/redis/z/redis.conf'],
      }),
      'maybe',
      'unresolvable listener',
    )
  })

  it('classifies a provably different server as other', async () => {
    assertEqual(
      await classifyKvPort({
        port: 1,
        dataDir: 'D:/spindb/containers/redis/a/data',
        probe: open,
        platform: 'win32',
        resolvePath: junction,
        listListeners: async () => ['D:/other/containers/redis/b/redis.conf'],
      }),
      'other',
      'resolved and different',
    )
    assertEqual(
      await classifyKvPort({
        port: 1,
        dataDir: 'D:/spindb/containers/redis/a/data',
        probe: open,
        platform: 'win32',
        resolvePath: junction,
        listListeners: async () => ['D:/spindb/containers/redis/ab/redis.conf'],
      }),
      'other',
      'a container whose name shares a prefix',
    )
  })
})
