import { exec, spawn, type SpawnOptions } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { open, readFile, rm, stat } from 'fs/promises'
import { paths } from '../config/paths'
import { logDebug } from './error-handler'
import {
  platformService,
  isWindows,
  getWindowsSpawnOptions,
} from './platform-service'
import type { ProcessResult, StatusResult } from '../types'

const execAsync = promisify(exec)

const LOG_TAIL_BYTES = 64 * 1024

/**
 * Pull the most recent FATAL or PANIC entry (plus its DETAIL/HINT/CONTEXT
 * continuation lines) out of a chunk of PostgreSQL server log text.
 */
export function extractPostgresFatal(logText: string): string | null {
  const lines = logText.split(/\r?\n/)
  let start = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\b(FATAL|PANIC):/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return null
  const entry = [lines[start].trim()]
  for (let i = start + 1; i < lines.length; i++) {
    if (/\b(DETAIL|HINT|CONTEXT):/.test(lines[i])) {
      entry.push(lines[i].trim())
    } else {
      break
    }
  }
  return entry.join('\n')
}

/** Current size of a log file, or 0 if it cannot be read. Never throws. */
export async function getLogFileSize(logFile: string): Promise<number> {
  try {
    return (await stat(logFile)).size
  } catch {
    return 0
  }
}

/**
 * Best-effort: read the log written since `fromOffset` (bounded to the last
 * LOG_TAIL_BYTES) and return the latest FATAL/PANIC entry. Falls back to the
 * whole bounded tail if nothing new was written. Never throws.
 */
export async function readPostgresStartFailure(
  logFile: string,
  fromOffset = 0,
): Promise<string | null> {
  try {
    const { size } = await stat(logFile)
    const readTail = async (from: number): Promise<string> => {
      const begin = Math.max(from, size - LOG_TAIL_BYTES, 0)
      const length = size - begin
      if (length <= 0) return ''
      const handle = await open(logFile, 'r')
      try {
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, begin)
        return buffer.toString('utf8')
      } finally {
        await handle.close()
      }
    }
    const offset = fromOffset <= size ? fromOffset : 0
    const fresh = extractPostgresFatal(await readTail(offset))
    if (fresh || offset === 0) return fresh
    return extractPostgresFatal(await readTail(0))
  } catch {
    return null
  }
}

async function withPostgresLogReason(
  message: string,
  logFile: string | undefined,
  fromOffset: number,
): Promise<string> {
  if (!logFile) return message
  const fatal = await readPostgresStartFailure(logFile, fromOffset)
  return fatal ? `${message.trimEnd()}\nPostgreSQL log: ${fatal}` : message
}

export type InitdbOptions = {
  superuser?: string
}

export type StartOptions = {
  port?: number
  logFile?: string
  bindAddress?: string
}

export type PsqlOptions = {
  port: number
  database?: string
  user?: string
  command?: string
}

export type PgRestoreOptions = {
  port: number
  database: string
  user?: string
  format?: string
}

export class ProcessManager {
  async initdb(
    initdbPath: string,
    dataDir: string,
    options: InitdbOptions = {},
  ): Promise<ProcessResult> {
    const { superuser = 'postgres' } = options
    const dirExistedBefore = existsSync(dataDir)

    const cleanupOnFailure = async () => {
      if (!dirExistedBefore && existsSync(dataDir)) {
        try {
          await rm(dataDir, { recursive: true, force: true })
          logDebug(`Cleaned up data directory after initdb failure: ${dataDir}`)
        } catch (cleanupErr) {
          logDebug(
            `Failed to clean up data directory: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
          )
        }
      }
    }

    if (isWindows()) {
      // On Windows, build the entire command as a single string
      const cmd = `"${initdbPath}" -D "${dataDir}" -U ${superuser} --auth=trust --encoding=UTF8 --no-locale`

      logDebug('initdb command (Windows)', { cmd })

      return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 120000 }, async (error, stdout, stderr) => {
          logDebug('initdb completed', {
            error: error?.message,
            stdout,
            stderr,
          })
          if (error) {
            await cleanupOnFailure()
            reject(
              new Error(
                `initdb failed with code ${error.code}: ${stderr || stdout || error.message}`,
              ),
            )
          } else {
            resolve({ stdout, stderr })
          }
        })
      })
    }

    // Unix path - use spawn without shell
    const args = [
      '-D',
      dataDir,
      '-U',
      superuser,
      '--auth=trust',
      '--encoding=UTF8',
      '--no-locale',
    ]

    logDebug('initdb command', { initdbPath, args })

    return new Promise((resolve, reject) => {
      const proc = spawn(initdbPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', async (code) => {
        logDebug('initdb completed', { code, stdout, stderr })
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          await cleanupOnFailure()
          reject(new Error(`initdb failed with code ${code}: ${stderr}`))
        }
      })

      proc.on('error', async (err) => {
        logDebug('initdb error', { error: err.message })
        await cleanupOnFailure()
        reject(err)
      })
    })
  }

  async start(
    pgCtlPath: string,
    dataDir: string,
    options: StartOptions = {},
  ): Promise<ProcessResult> {
    const { port, logFile, bindAddress } = options
    const logDest = logFile || platformService.getNullDevice()
    const logOffset = logFile ? await getLogFileSize(logFile) : 0

    if (isWindows()) {
      // On Windows, start without -w (wait) flag and poll for readiness
      // The -w flag can hang indefinitely on Windows
      let cmd = `"${pgCtlPath}" start -D "${dataDir}" -l "${logDest}"`
      const pgOpts: string[] = []
      if (port) pgOpts.push(`-p ${port}`)
      if (bindAddress) pgOpts.push(`-h ${bindAddress}`)
      if (pgOpts.length > 0) {
        cmd += ` -o "${pgOpts.join(' ')}"`
      }

      logDebug('pg_ctl start command (Windows)', { cmd })

      return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 30000 }, async (error, stdout, stderr) => {
          logDebug('pg_ctl start initiated', {
            error: error?.message,
            stdout,
            stderr,
          })

          if (error) {
            reject(
              new Error(
                await withPostgresLogReason(
                  `pg_ctl start failed with code ${error.code}: ${stderr || stdout || error.message}`,
                  logFile,
                  logOffset,
                ),
              ),
            )
            return
          }

          // Poll for PostgreSQL to be ready using pg_isready or status check
          const statusCmd = `"${pgCtlPath}" status -D "${dataDir}"`
          let attempts = 0
          const maxAttempts = 30
          const pollInterval = 1000

          const checkReady = () => {
            attempts++
            exec(statusCmd, (statusError, statusStdout) => {
              if (!statusError && statusStdout.includes('server is running')) {
                logDebug('pg_ctl start completed (Windows)', { attempts })
                resolve({ stdout, stderr })
              } else if (attempts >= maxAttempts) {
                void withPostgresLogReason(
                  `PostgreSQL failed to start within ${maxAttempts} seconds`,
                  logFile,
                  logOffset,
                ).then((message) => reject(new Error(message)))
              } else {
                setTimeout(checkReady, pollInterval)
              }
            })
          }

          // Give it a moment before starting to poll
          setTimeout(checkReady, 500)
        })
      })
    }

    // Unix path - use spawn without shell
    const pgOptions: string[] = []
    if (port) {
      pgOptions.push(`-p ${port}`)
    }
    if (bindAddress) {
      pgOptions.push(`-h ${bindAddress}`)
    }

    const args = [
      'start',
      '-D',
      dataDir,
      '-l',
      logDest,
      '-w', // Wait for startup to complete
      '-t',
      '30', // Timeout after 30 seconds
    ]

    if (pgOptions.length > 0) {
      args.push('-o', pgOptions.join(' '))
    }

    logDebug('pg_ctl start command', { pgCtlPath, args })

    return new Promise((resolve, reject) => {
      const proc = spawn(pgCtlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', async (code) => {
        logDebug('pg_ctl start completed', { code, stdout, stderr })
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(
            new Error(
              await withPostgresLogReason(
                `pg_ctl start failed with code ${code}: ${stderr || stdout}`,
                logFile,
                logOffset,
              ),
            ),
          )
        }
      })

      proc.on('error', (err) => {
        logDebug('pg_ctl start error', { error: err.message })
        reject(err)
      })
    })
  }

  async stop(pgCtlPath: string, dataDir: string): Promise<ProcessResult> {
    if (isWindows()) {
      // On Windows, build the entire command as a single string
      const cmd = `"${pgCtlPath}" stop -D "${dataDir}" -m fast -w -t 30`

      logDebug('pg_ctl stop command (Windows)', { cmd })

      return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 60000 }, (error, stdout, stderr) => {
          logDebug('pg_ctl stop completed', {
            error: error?.message,
            stdout,
            stderr,
          })
          if (error) {
            reject(
              new Error(
                `pg_ctl stop failed with code ${error.code}: ${stderr || stdout || error.message}`,
              ),
            )
          } else {
            resolve({ stdout, stderr })
          }
        })
      })
    }

    // Unix path - use spawn without shell
    const args = [
      'stop',
      '-D',
      dataDir,
      '-m',
      'fast',
      '-w', // Wait for shutdown to complete
      '-t',
      '30', // Timeout after 30 seconds
    ]

    logDebug('pg_ctl stop command', { pgCtlPath, args })

    return new Promise((resolve, reject) => {
      const proc = spawn(pgCtlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        logDebug('pg_ctl stop completed', { code, stdout, stderr })
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(
            new Error(
              `pg_ctl stop failed with code ${code}: ${stderr || stdout}`,
            ),
          )
        }
      })

      proc.on('error', (err) => {
        logDebug('pg_ctl stop error', { error: err.message })
        reject(err)
      })
    })
  }

  async status(pgCtlPath: string, dataDir: string): Promise<StatusResult> {
    const args = ['status', '-D', dataDir]

    try {
      const { stdout } = await execAsync(`"${pgCtlPath}" ${args.join(' ')}`)
      return {
        running: true,
        message: stdout.trim(),
      }
    } catch (error) {
      // pg_ctl status returns non-zero if server is not running
      const err = error as { stderr?: string; message: string }
      return {
        running: false,
        message: err.stderr?.trim() || err.message,
      }
    }
  }

  async isRunning(
    containerName: string,
    options: { engine: string },
  ): Promise<boolean> {
    const { engine } = options
    const pidFile = paths.getContainerPidPath(containerName, { engine })
    if (!existsSync(pidFile)) {
      return false
    }

    try {
      const content = await readFile(pidFile, 'utf8')
      const pid = parseInt(content.split('\n')[0], 10)
      process.kill(pid, 0)
      return true
    } catch (error) {
      logDebug('PID file check failed', {
        containerName,
        engine: options.engine,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async getPid(
    containerName: string,
    options: { engine: string },
  ): Promise<number | null> {
    const { engine } = options
    const pidFile = paths.getContainerPidPath(containerName, { engine })
    if (!existsSync(pidFile)) {
      return null
    }

    try {
      const content = await readFile(pidFile, 'utf8')
      return parseInt(content.split('\n')[0], 10)
    } catch (error) {
      logDebug('Failed to read PID file', {
        pidFile,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * Kill a process directly by PID (fallback when pg_ctl is unavailable)
   * Sends SIGTERM first, then SIGKILL if process doesn't stop
   */
  async killProcess(
    containerName: string,
    options: { engine: string },
  ): Promise<boolean> {
    const pid = await this.getPid(containerName, options)
    if (!pid) {
      // No PID means the process isn't running - goal achieved
      logDebug('No PID found for container (already stopped)', {
        containerName,
      })
      return true
    }

    try {
      // Check if process is running
      process.kill(pid, 0)
    } catch {
      // Process not running
      logDebug('Process not running', { containerName, pid })
      return true
    }

    try {
      // Send SIGTERM for graceful shutdown
      logDebug('Sending SIGTERM to process', { containerName, pid })
      process.kill(pid, 'SIGTERM')

      // Wait for process to stop (up to 10 seconds)
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        try {
          process.kill(pid, 0)
        } catch {
          // Process stopped
          logDebug('Process stopped gracefully', { containerName, pid })
          return true
        }
      }

      // Process didn't stop, send SIGKILL
      logDebug('Sending SIGKILL to process', { containerName, pid })
      process.kill(pid, 'SIGKILL')

      // Wait a bit more and verify process is dead
      await new Promise((resolve) => setTimeout(resolve, 1000))
      try {
        process.kill(pid, 0)
        // Process still running after SIGKILL (rare: zombie or uninterruptible sleep)
        logDebug('Process still running after SIGKILL', { containerName, pid })
        return false
      } catch {
        logDebug('Process killed with SIGKILL', { containerName, pid })
        return true
      }
    } catch (error) {
      logDebug('Failed to kill process', {
        containerName,
        pid,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async psql(
    psqlPath: string,
    options: PsqlOptions,
  ): Promise<ProcessResult & { code?: number }> {
    const { port, database = 'postgres', user = 'postgres', command } = options

    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      user,
      '-d',
      database,
    ]

    if (command) {
      args.push('-c', command)
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(psqlPath, args, {
        stdio: command ? ['ignore', 'pipe', 'pipe'] : 'inherit',
        ...getWindowsSpawnOptions(),
      })

      if (command) {
        let stdout = ''
        let stderr = ''

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString()
        })
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString()
        })

        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ stdout, stderr, code: code ?? undefined })
          } else {
            reject(new Error(`psql failed with code ${code}: ${stderr}`))
          }
        })
      } else {
        proc.on('close', (code) => {
          resolve({ stdout: '', stderr: '', code: code ?? undefined })
        })
      }

      proc.on('error', reject)
    })
  }

  async pgRestore(
    pgRestorePath: string,
    backupFile: string,
    options: PgRestoreOptions,
  ): Promise<ProcessResult & { code?: number }> {
    const { port, database, user = 'postgres', format } = options

    const args = [
      '-h',
      '127.0.0.1',
      '-p',
      String(port),
      '-U',
      user,
      '-d',
      database,
      '--no-owner',
      '--no-privileges',
    ]

    if (format) {
      args.push('-F', format)
    }

    args.push(backupFile)

    const spawnOptions: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...getWindowsSpawnOptions(),
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(pgRestorePath, args, spawnOptions)

      let stdout = ''
      let stderr = ''

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        // pg_restore may return non-zero even on partial success
        resolve({ stdout, stderr, code: code ?? undefined })
      })

      proc.on('error', reject)
    })
  }
}

export const processManager = new ProcessManager()
