import { existsSync } from 'fs'
import { readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { platformService } from './platform-service'
import { paths } from '../config/paths'

/** Pinned pgweb version — single source of truth for download URL */
export const PGWEB_VERSION = '0.17.0'

/**
 * Check if pgweb is running for a container.
 * Reads pgweb.pid/pgweb.port files and verifies the process is alive.
 * Cleans up stale PID/port files if the process is dead.
 */
export async function getPgwebStatus(
  containerName: string,
  engine: string,
): Promise<{ running: boolean; port?: number; pid?: number }> {
  const containerDir = paths.getContainerPath(containerName, { engine })
  const pidFile = join(containerDir, 'pgweb.pid')
  const portFile = join(containerDir, 'pgweb.port')

  if (!existsSync(pidFile)) return { running: false }

  try {
    const pid = parseInt(await readFile(pidFile, 'utf8'), 10)
    if (platformService.isProcessRunning(pid)) {
      const port = parseInt(await readFile(portFile, 'utf8'), 10)
      return { running: true, port, pid }
    }
  } catch {
    // PID file invalid or process dead
  }

  // Clean up stale files
  await unlink(pidFile).catch(() => {})
  await unlink(portFile).catch(() => {})
  return { running: false }
}

/**
 * Stop a running pgweb process for a container (no UI output).
 * Returns true if a process was stopped, false if nothing was running.
 */
export async function stopPgweb(
  containerName: string,
  engine: string,
): Promise<boolean> {
  const status = await getPgwebStatus(containerName, engine)
  if (!status.running || !status.pid) return false

  try {
    await platformService.terminateProcess(status.pid, false)
  } catch {
    // Already gone
  }

  const containerDir = paths.getContainerPath(containerName, { engine })
  await unlink(join(containerDir, 'pgweb.pid')).catch(() => {})
  await unlink(join(containerDir, 'pgweb.port')).catch(() => {})
  return true
}
