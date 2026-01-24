/**
 * Shared spawn utilities for executing commands safely
 *
 * This module provides a Promise-based wrapper around child_process.spawn
 * with proper timeout handling and error messages.
 */

import { spawn } from 'child_process'

export type SpawnOptions = {
  cwd?: string
  timeout?: number
  env?: Record<string, string>
}

export type SpawnResult = {
  stdout: string
  stderr: string
}

/**
 * Execute a command using spawn with argument array (safer than shell interpolation)
 *
 * @param command - The command to execute
 * @param args - Array of arguments to pass to the command
 * @param options - Optional configuration (cwd, timeout)
 * @returns Promise resolving to { stdout, stderr }
 * @throws Error if command fails, times out, or cannot be executed
 */
export function spawnAsync(
  command: string,
  args: string[],
  options?: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    // Set up timeout if specified
    if (options?.timeout && options.timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGKILL')
        reject(
          new Error(
            `Command "${command} ${args.join(' ')}" timed out after ${options.timeout}ms`,
          ),
        )
      }, options.timeout)
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer)
    }

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      cleanup()
      if (timedOut) return // Already rejected by timeout
      if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(
          new Error(
            `Command "${command} ${args.join(' ')}" failed with code ${code}: ${stderr || stdout}`,
          ),
        )
      }
    })

    proc.on('error', (err) => {
      cleanup()
      if (timedOut) return // Already rejected by timeout
      reject(new Error(`Failed to execute "${command}": ${err.message}`))
    })
  })
}

/**
 * Escape a string for use in a PowerShell single-quoted string.
 * PowerShell escapes single quotes by doubling them: ' becomes ''
 */
function escapeForPowerShell(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Extract a ZIP archive using PowerShell Expand-Archive (Windows)
 *
 * @param zipFile - Path to the ZIP file
 * @param destDir - Destination directory for extraction
 * @throws Error if extraction fails
 */
export async function extractWindowsArchive(
  zipFile: string,
  destDir: string,
): Promise<void> {
  // Escape paths to prevent command injection via single quotes
  // Use -LiteralPath to treat the path literally (no wildcard expansion)
  const safeZipFile = escapeForPowerShell(zipFile)
  const safeDestDir = escapeForPowerShell(destDir)

  await spawnAsync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${safeZipFile}' -DestinationPath '${safeDestDir}' -Force`,
  ])
}
