import type { ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { logDebug } from './error-handler'

/**
 * Removal of the temp dump a `--from-url` restore writes, on termination.
 *
 * A remote dump can run for a long time (a slow cross-continent source pulls
 * hundreds of megabytes through `mariadb-dump`), and Layerbase Cloud runs the
 * restore under a supervisor that SIGTERMs it at a deadline. Nothing used to
 * remove the half-written `/tmp/spindb-dump-<timestamp>.dump` in that case:
 * the `finally` blocks in the restore commands only run when the command
 * itself returns or throws, and a signal skips them entirely. A killed import
 * therefore left its partial dump behind inside the customer's container, once
 * at 450 MB.
 *
 * The registry is process-wide and engine-agnostic: any path handed to
 * `registerTempDump` is removed when the process is terminated, whichever
 * engine wrote it. Removal is synchronous because a signal handler has no
 * chance to await anything before the process goes away.
 */

// SIGHUP is included because a restore driven over SSH or from a detached
// shell is terminated that way rather than with SIGTERM.
const TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const

type TerminationSignal = (typeof TERMINATION_SIGNALS)[number]

// Conventional shell exit codes for a process killed by a signal: 128 plus the
// signal number. 143 for SIGTERM, 130 for SIGINT, 129 for SIGHUP.
const SIGNAL_EXIT_CODES: Record<TerminationSignal, number> = {
  SIGTERM: 143,
  SIGINT: 130,
  SIGHUP: 129,
}

const pendingDumps = new Set<string>()
const pendingChildren = new Set<ChildProcess>()

let handlersInstalled = false
let terminating = false

function removePendingDumps(): void {
  for (const path of pendingDumps) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (error) {
      // Nothing useful can be done about a temp file that will not delete, and
      // the process is on its way out.
      logDebug(`Failed to remove temp dump ${path}: ${String(error)}`)
    }
  }
  pendingDumps.clear()
}

function killPendingChildren(signal: TerminationSignal): void {
  for (const child of pendingChildren) {
    try {
      child.kill(signal)
    } catch (error) {
      logDebug(`Failed to signal dump process: ${String(error)}`)
    }
  }
  pendingChildren.clear()
}

function installHandlers(): void {
  if (handlersInstalled) return
  handlersInstalled = true

  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => {
      // A supervisor that sends SIGTERM and then SIGKILL can land a second
      // signal while the first is still being handled.
      if (terminating) return
      terminating = true

      killPendingChildren(signal)
      removePendingDumps()
      process.exit(SIGNAL_EXIT_CODES[signal])
    })
  }
}

/**
 * Track a temp dump path so it is removed if the process is terminated.
 * Returns the release callback, which the caller runs once it has cleaned the
 * file up itself (its own `finally` still owns the normal paths).
 */
export function registerTempDump(path: string): () => void {
  pendingDumps.add(path)
  installHandlers()
  return () => releaseTempDump(path)
}

/** Stop tracking a temp dump the caller has already removed. */
export function releaseTempDump(path: string): void {
  pendingDumps.delete(path)
}

/**
 * Track the dump child so a termination kills it instead of orphaning a client
 * that keeps writing. Node puts a non-detached child in our own process group,
 * so a group-wide kill already reaches it; this covers a signal aimed at the
 * spindb pid alone.
 */
export function trackDumpProcess(child: ChildProcess): () => void {
  pendingChildren.add(child)
  installHandlers()
  return () => {
    pendingChildren.delete(child)
  }
}

/** Test-only view of what would be removed on termination. */
export function getPendingTempDumps(): string[] {
  return [...pendingDumps]
}
