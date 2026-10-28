import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { platformService } from './platform-service'
import { logDebug, logWarning } from './error-handler'

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
 * Size and mtime of the newest temp RDB (`temp-<pid>.rdb`) the server is
 * writing in its data dir, or null when no save is in progress on disk.
 */
export async function readTempRdbProgress(
  dataDir: string,
): Promise<SaveProgress> {
  let entries: string[]
  try {
    entries = await readdir(dataDir)
  } catch {
    return null
  }
  let newest: SaveProgress = null
  for (const entry of entries) {
    if (!/^temp-.*\.rdb$/.test(entry)) continue
    try {
      const info = await stat(join(dataDir, entry))
      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = { size: info.size, mtimeMs: info.mtimeMs }
      }
    } catch {
      // The file was renamed into place between readdir and stat.
    }
  }
  return newest
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export type KvWaitDeps = {
  isRunning: (pid: number) => boolean
  readProgress: (dataDir: string) => Promise<SaveProgress>
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
 * Waits for the server process to exit. Past the budget it keeps waiting as
 * long as the temp RDB is still changing, and gives up ('stalled') only when
 * the budget is spent AND no save has made progress for KV_SAVE_STALL_MS.
 */
export async function waitForKvExit(options: {
  pid: number
  dataDir: string
  budgetMs: number
  stallMs?: number
  deps?: Partial<KvWaitDeps>
}): Promise<'exited' | 'stalled'> {
  const deps = { ...defaultWaitDeps, ...options.deps }
  const stallMs = options.stallMs ?? KV_SAVE_STALL_MS
  const start = deps.now()
  const deadline = start + options.budgetMs
  let lastProgress: SaveProgress = null
  let lastChangeAt = start

  while (deps.isRunning(options.pid)) {
    const progress = await deps.readProgress(options.dataDir)
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
    if (now >= deadline && now - lastChangeAt >= stallMs) {
      return 'stalled'
    }
    await deps.sleep(POLL_INTERVAL_MS)
  }
  return 'exited'
}

export type ShutdownSaveResult =
  | { kind: 'ok'; output: string }
  | { kind: 'timeout' }
  | { kind: 'error'; output: string; message: string }

export class KvSaveFailedError extends Error {
  constructor(engineLabel: string, detail: string) {
    super(
      `${engineLabel} refused to shut down because its snapshot save failed: ${detail.trim()}. ` +
        'The server is still running and its data is intact. Check the server log for the save error (often disk space or permissions), fix it, then stop again.',
    )
    this.name = 'KvSaveFailedError'
  }
}

export async function stopKvServer(options: {
  engineLabel: string
  pid: number | null
  dataDir: string
  readUsedMemory: () => Promise<number | null>
  sendShutdownSave: (timeoutMs: number) => Promise<ShutdownSaveResult>
  terminate?: (pid: number, force: boolean) => Promise<void>
  deps?: Partial<KvWaitDeps>
  stallMs?: number
}): Promise<void> {
  const { engineLabel, pid, dataDir } = options
  const deps = { ...defaultWaitDeps, ...options.deps }
  const terminate =
    options.terminate ??
    ((target: number, force: boolean) =>
      platformService.terminateProcess(target, force))

  const usedMemory = (await options.readUsedMemory().catch(() => null)) ?? 0
  const rdbSize = await fileSize(join(dataDir, 'dump.rdb'))
  const budgetMs = kvShutdownBudgetMs(Math.max(usedMemory, rdbSize))
  logDebug(`${engineLabel} shutdown budget ${budgetMs}ms`)

  const result = await options.sendShutdownSave(budgetMs)
  const isAlive = () => pid !== null && deps.isRunning(pid)

  if (result.kind !== 'timeout') {
    const output = result.output
    if (isShutdownRefusal(output) && isAlive()) {
      throw new KvSaveFailedError(engineLabel, output)
    }
  }
  if (pid === null || !isAlive()) return

  const wait = () =>
    waitForKvExit({ pid, dataDir, budgetMs, stallMs: options.stallMs, deps })

  // A timed-out CLI means the save may still be running: wait first. A CLI
  // that failed outright (unreachable, auth) never started a shutdown, so ask
  // the process directly; SIGTERM also saves under the configured save rules.
  if (result.kind === 'timeout' || result.kind === 'ok') {
    if ((await wait()) === 'exited') return
  }
  if (result.kind === 'error') {
    logDebug(`${engineLabel} shutdown command failed: ${result.message}`)
  }

  logDebug(`Sending SIGTERM to ${engineLabel} process ${pid}`)
  try {
    await terminate(pid, false)
  } catch (error) {
    logDebug(`${engineLabel} SIGTERM failed: ${error}`)
  }
  if ((await wait()) === 'exited') return

  logWarning(
    `${engineLabel} process ${pid} did not exit and no snapshot save made progress for ${Math.round(
      (options.stallMs ?? KV_SAVE_STALL_MS) / 1000,
    )}s; force killing`,
  )
  try {
    await terminate(pid, true)
  } catch (error) {
    logDebug(`${engineLabel} SIGKILL failed: ${error}`)
  }
}
