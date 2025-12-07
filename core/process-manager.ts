import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readFile, rm } from 'fs/promises'
import { paths } from '../config/paths'
import { logDebug } from './error-handler'
import type { ProcessResult, StatusResult } from '../types'

const execAsync = promisify(exec)

export type InitdbOptions = {
  superuser?: string
}

export type StartOptions = {
  port?: number
  logFile?: string
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
  /**
   * Initialize a new PostgreSQL data directory
   */
  async initdb(
    initdbPath: string,
    dataDir: string,
    options: InitdbOptions = {},
  ): Promise<ProcessResult> {
    const { superuser = 'postgres' } = options

    // Track if directory existed before initdb (to know if we should clean up)
    const dirExistedBefore = existsSync(dataDir)

    const args = [
      '-D',
      dataDir,
      '-U',
      superuser,
      '--auth=trust',
      '--encoding=UTF8',
      '--no-locale',
    ]

    // Helper to clean up data directory on failure
    const cleanupOnFailure = async () => {
      // Only clean up if initdb created the directory (it didn't exist before)
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

    return new Promise((resolve, reject) => {
      const proc = spawn(initdbPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', async (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          await cleanupOnFailure()
          reject(new Error(`initdb failed with code ${code}: ${stderr}`))
        }
      })

      proc.on('error', async (err) => {
        await cleanupOnFailure()
        reject(err)
      })
    })
  }

  /**
   * Start PostgreSQL server using pg_ctl
   */
  async start(
    pgCtlPath: string,
    dataDir: string,
    options: StartOptions = {},
  ): Promise<ProcessResult> {
    const { port, logFile } = options

    const pgOptions: string[] = []
    if (port) {
      pgOptions.push(`-p ${port}`)
    }

    const args = [
      'start',
      '-D',
      dataDir,
      '-l',
      logFile || '/dev/null',
      '-w', // Wait for startup to complete
      '-o',
      pgOptions.join(' '),
    ]

    return new Promise((resolve, reject) => {
      const proc = spawn(pgCtlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          reject(
            new Error(
              `pg_ctl start failed with code ${code}: ${stderr || stdout}`,
            ),
          )
        }
      })

      proc.on('error', reject)
    })
  }

  /**
   * Stop PostgreSQL server using pg_ctl
   */
  async stop(pgCtlPath: string, dataDir: string): Promise<ProcessResult> {
    const args = [
      'stop',
      '-D',
      dataDir,
      '-m',
      'fast',
      '-w', // Wait for shutdown to complete
    ]

    return new Promise((resolve, reject) => {
      const proc = spawn(pgCtlPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
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

      proc.on('error', reject)
    })
  }

  /**
   * Get PostgreSQL server status
   */
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

  /**
   * Check if a database server is running by looking for PID file
   */
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

      // Check if process is still running
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

  /**
   * Get the PID of a running database server
   */
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
   * Execute psql command
   */
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

  /**
   * Execute pg_restore command
   */
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

    return new Promise((resolve, reject) => {
      const proc = spawn(pgRestorePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
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
