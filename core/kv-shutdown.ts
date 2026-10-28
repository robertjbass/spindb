import { stat } from 'fs/promises'
import { connect } from 'net'
import { join } from 'path'
import { platformService } from './platform-service'
import { logDebug } from './error-handler'

/**
 * Stops a Redis-compatible server (Redis, Valkey) without ever killing it
 * while it is writing its RDB snapshot.
 *
 * A foreground SHUTDOWN SAVE of a large dataset takes far longer than a fixed
 * few seconds (a 1.4 GB Valkey takes ~25 s). Killing the process mid-save
 * discards the temp RDB, and with appendonly off every write since the last
 * background save is lost. So the wait budget scales with the dataset size,
 * and a save that is still writing its temp file always gets more time.
 */

// Conservative floor for snapshot write speed; a measured large save ran at
// ~56 MB/s, so this leaves headroom for slower disks and busy hosts.
export const KV_SAVE_BYTES_PER_SECOND = 10 * 1024 * 1024
export const KV_SHUTDOWN_BASE_WAIT_MS = 30_000
// How long a temp RDB may go without growing before the save counts as stuck.
export const KV_SAVE_STALL_MS = 30_000
const POLL_INTERVAL_MS = 250

export function kvShutdownBudgetMs(datasetBytes: number): number {
  const bytes =
    Number.isFinite(datasetBytes) && datasetBytes > 0 ? datasetBytes : 0
  return (
    KV_SHUTDOWN_BASE_WAIT_MS +
    Math.ceil(bytes / KV_SAVE_BYTES_PER_SECOND) * 1000
  )
}

export function parseUsedMemoryBytes(infoOutput: string): number | null {
  const match = infoOutput.match(/^used_memory:(\d+)\s*$/m)
  return match ? Number(match[1]) : null
}

export function isShutdownRefusal(output: string): boolean {
  return /Errors trying to (SHUTDOWN|shut down)/i.test(output)
}

export type SaveProgress = { size: number; mtimeMs: number } | null

/**
 * Size and mtime of the temp RDB the server process itself is writing
 * (`temp-<pid>.rdb`: the foreground save SHUTDOWN SAVE and SIGTERM run), or
 * null when it is not writing one. Background-save children write under their
 * own pid and are deliberately not counted: shutdown kills them and does its
 * own foreground save.
 */
export async function readTempRdbProgress(
  dataDir: string,
  pid: number,
): Promise<SaveProgress> {
  try {
    const info = await stat(join(dataDir, `temp-${pid}.rdb`))
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export type ConnectProbe = (
  host: string,
  port: number,
) => Promise<'open' | 'refused' | 'unusable' | 'unknown'>

const CONNECT_PROBE_TIMEOUT_MS = 2_000

/** One TCP connect attempt: did anything accept on host:port? */
export const tcpConnectProbe: ConnectProbe = (host, port) =>
  new Promise((resolve) => {
    const socket = connect({ host, port })
    const finish = (answer: 'open' | 'refused' | 'unusable' | 'unknown') => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(CONNECT_PROBE_TIMEOUT_MS, () => finish('unknown'))
    socket.once('connect', () => finish('open'))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED') finish('refused')
      else if (
        ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH'].includes(
          error.code ?? '',
        )
      )
        finish('unusable')
      else finish('unknown')
    })
  })

/**
 * The addresses a Redis/Valkey `bind` line can make it reachable on, as
 * connectable hosts: every configured address (wildcards mapped to their
 * loopback), plus both loopbacks.
 */
export function kvProbeHosts(bindAddress: string | undefined): string[] {
  const hosts = new Set<string>(['127.0.0.1', '::1'])
  for (const raw of (bindAddress ?? '').split(/\s+/)) {
    const address = raw.replace(/^-/, '').trim()
    if (!address) continue
    if (address === '0.0.0.0' || address === '*') hosts.add('127.0.0.1')
    else if (address === '::' || address === '::*') hosts.add('::1')
    else hosts.add(address)
  }
  return [...hosts]
}

/**
 * True only when a connect to the port is definitively refused on every
 * address the server could be bound to (an IPv6 loopback the host cannot use
 * counts as refused). Anything that accepts, times out or errors otherwise
 * means "not proven free": fail closed. Independent of lsof, which is missing
 * on some Linux hosts and also lists clients.
 */
export async function isKvPortProvenFree(options: {
  port: number
  bindAddress?: string
  probe?: ConnectProbe
}): Promise<boolean> {
  const probe = options.probe ?? tcpConnectProbe
  const answers = await Promise.all(
    kvProbeHosts(options.bindAddress).map((host) =>
      probe(host, options.port).then((answer) => ({ host, answer })),
    ),
  )
  return answers.every(
    ({ host, answer }) =>
      answer === 'refused' || (answer === 'unusable' && host === '::1'),
  )
}

export type KvWaitDeps = {
  isRunning: (pid: number) => boolean
  readProgress: (dataDir: string, pid: number) => Promise<SaveProgress>
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const defaultWaitDeps: KvWaitDeps = {
  isRunning: (pid) => platformService.isProcessRunning(pid),
  readProgress: readTempRdbProgress,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Waits for the server process to exit.
 *   'exited' - it is gone.
 *   'idle'   - the budget is spent and the server is not writing a snapshot.
 *   'stuck'  - the budget is spent and its snapshot has not changed for
 *              stallMs. A save can sit in fsync with an unchanged file, so this
 *              is reported, never treated as permission to kill.
 * A snapshot that is still changing is always waited out, budget or not.
 */
export async function waitForKvExit(options: {
  pid: number
  dataDir: string
  budgetMs: number
  stallMs?: number
  deps?: Partial<KvWaitDeps>
}): Promise<'exited' | 'idle' | 'stuck'> {
  const deps = { ...defaultWaitDeps, ...options.deps }
  const stallMs = options.stallMs ?? KV_SAVE_STALL_MS
  const start = deps.now()
  const deadline = start + options.budgetMs
  let lastProgress: SaveProgress = null
  let lastChangeAt = start

  while (deps.isRunning(options.pid)) {
    const progress = await deps.readProgress(options.dataDir, options.pid)
    const now = deps.now()
    if (
      progress &&
      (!lastProgress ||
        progress.size !== lastProgress.size ||
        progress.mtimeMs !== lastProgress.mtimeMs)
    ) {
      lastChangeAt = now
    }
    lastProgress = progress
    if (now >= deadline) {
      if (!progress) return 'idle'
      if (now - lastChangeAt >= stallMs) return 'stuck'
    }
    await deps.sleep(POLL_INTERVAL_MS)
  }
  return 'exited'
}

export type ShutdownSaveResult =
  | { kind: 'ok'; output: string }
  | { kind: 'timeout' }
  | { kind: 'error'; output: string; message: string }

/**
 * `stop` could not shut the server down without risking its data, so it left
 * the server running. Callers must not treat the container as stopped or
 * delete its data on the strength of this stop.
 */
export class KvStopRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KvStopRefusedError'
  }
}

export class KvSaveFailedError extends KvStopRefusedError {
  constructor(engineLabel: string, detail: string) {
    super(
      `${engineLabel} refused to shut down because its snapshot save failed: ${detail.trim().replace(/\.+$/, '')}. ` +
        'The server is still running and its data is intact. Check the server log for the save error (often disk space or permissions), fix it, then stop again.',
    )
    this.name = 'KvSaveFailedError'
  }
}

export function isAuthRejection(output: string): boolean {
  return /\b(NOAUTH|WRONGPASS|NOPERM)\b|invalid username-password/i.test(output)
}

export async function stopKvServer(options: {
  engineLabel: string
  pid: number | null
  dataDir: string
  readUsedMemory: () => Promise<number | null>
  sendShutdownSave: (timeoutMs: number) => Promise<ShutdownSaveResult>
  /** True when the server answers a command, i.e. is up and serving. */
  isServing: () => Promise<boolean>
  /**
   * True only when nothing at all holds the server's port. Used when there is
   * no pid to wait on, to tell "already gone" from "unreachable".
   */
  isPortFree: () => Promise<boolean>
  terminate?: (pid: number, force: boolean) => Promise<void>
  deps?: Partial<KvWaitDeps>
  stallMs?: number
}): Promise<void> {
  const { engineLabel, dataDir } = options
  const deps = { ...defaultWaitDeps, ...options.deps }
  const terminate =
    options.terminate ??
    ((target: number, force: boolean) =>
      platformService.terminateProcess(target, force))
  const stallSeconds = Math.round((options.stallMs ?? KV_SAVE_STALL_MS) / 1000)

  const pid = options.pid

  const usedMemory = (await options.readUsedMemory().catch(() => null)) ?? 0
  const rdbSize = await fileSize(join(dataDir, 'dump.rdb'))
  const budgetMs = kvShutdownBudgetMs(Math.max(usedMemory, rdbSize))
  logDebug(`${engineLabel} shutdown budget ${budgetMs}ms`)

  const result = await options.sendShutdownSave(budgetMs)
  if (result.kind !== 'timeout') {
    if (isShutdownRefusal(result.output)) {
      throw new KvSaveFailedError(engineLabel, result.output)
    }
    if (isAuthRejection(result.output)) {
      throw new KvStopRefusedError(
        `${engineLabel} rejected SHUTDOWN SAVE: ${result.output.trim()}. ` +
          'The server is still running and was not signalled, because a stop without that save can lose data. Check the stored credentials for this container, then stop again.',
      )
    }
  }

  const stillServing = async (detail: string) => {
    if (await options.isServing().catch(() => false)) {
      throw new KvSaveFailedError(engineLabel, detail)
    }
  }

  if (pid === null || !deps.isRunning(pid)) {
    if (result.kind === 'timeout') {
      // A server busy writing its snapshot answers nothing, so without a pid
      // there is no way to tell "still saving" from "gone".
      throw new KvStopRefusedError(
        `${engineLabel} did not confirm its shutdown and its process could not be found to wait on. ` +
          'It may still be writing its snapshot; check that it has exited before stopping again or deleting it.',
      )
    }
    await stillServing('the server is still serving after SHUTDOWN SAVE')
    if (result.kind === 'ok') return
    // The shutdown never reached a server (connection refused, no cli). With
    // no pid, the only proof it is gone is a port nothing holds; a server bound
    // to another address is otherwise indistinguishable.
    if (await options.isPortFree().catch(() => false)) return
    throw new KvStopRefusedError(
      `${engineLabel} could not be reached to shut it down (${result.message}) and its process could not be found, but something still holds its port. ` +
        'It was left alone rather than reported stopped. Check what is listening on the port before stopping again or deleting it.',
    )
  }

  const livePid = pid
  const wait = () =>
    waitForKvExit({
      pid: livePid,
      dataDir,
      budgetMs,
      stallMs: options.stallMs,
      deps,
    })
  const stuck = () =>
    new KvStopRefusedError(
      `${engineLabel} process ${livePid} is still writing its snapshot but it has not changed for ${stallSeconds}s. ` +
        'It was left running rather than killed mid-save. Check disk health and the server log, then stop again.',
    )

  if (result.kind === 'timeout' || result.kind === 'ok') {
    const outcome = await wait()
    if (outcome === 'exited') return
    if (outcome === 'stuck') throw stuck()
    await stillServing('the server is still serving after SHUTDOWN SAVE')
  } else {
    logDebug(`${engineLabel} shutdown command failed: ${result.message}`)
    await stillServing(`SHUTDOWN SAVE failed (${result.message})`)
  }

  // Not answering and not writing a snapshot. SIGTERM makes the server save
  // under its save rules and refuse to exit if that save fails, so it is safe.
  // SIGKILL is never sent: whether the data reached disk cannot be confirmed.
  logDebug(`Sending SIGTERM to ${engineLabel} process ${livePid}`)
  try {
    await terminate(livePid, false)
  } catch (error) {
    logDebug(`${engineLabel} SIGTERM failed: ${error}`)
  }
  const afterTerm = await wait()
  if (afterTerm === 'exited') return
  if (afterTerm === 'stuck') throw stuck()
  await stillServing('the server is still serving after SIGTERM')
  throw new KvStopRefusedError(
    `${engineLabel} process ${livePid} did not exit after SHUTDOWN SAVE or SIGTERM and is not answering. ` +
      'It was left running because killing it could lose data that has not reached disk. Check the server log; if the data is expendable, kill the process yourself.',
  )
}
