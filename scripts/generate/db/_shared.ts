/**
 * Shared utilities for database generation scripts.
 */

import { spawn, spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = join(__dirname, '..', '..', '..')

export type ContainerConfig = {
  name: string
  engine: string
  port: number
  status: string
  database: string
}

export type ParsedArgs = {
  containerName: string
  port: number | null
}

export function parseArgs(defaultName: string): ParsedArgs {
  const args = process.argv.slice(2)
  let containerName = defaultName
  let port: number | null = null

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--port') {
      const portValue = args[i + 1]
      if (!portValue || portValue.startsWith('-')) {
        console.error('Error: --port requires a value')
        process.exit(1)
      }
      port = parseInt(portValue, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(
          `Error: Invalid port "${portValue}". Must be a number between 1 and 65535.`,
        )
        process.exit(1)
      }
      i++ // Skip the port value
    } else if (!arg.startsWith('-')) {
      containerName = arg
    }
  }

  return { containerName, port }
}

export function runSpindb(args: string[]): {
  success: boolean
  output: string
} {
  const result = spawnSync('pnpm', ['start', ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true, // Required for Windows where pnpm is a .cmd shim
  })

  return {
    success: result.status === 0,
    output: result.stdout + result.stderr,
  }
}

export function runSpindbStreaming(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['start', ...args], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      shell: true, // Required for Windows where pnpm is a .cmd shim
    })

    child.on('close', (code) => {
      resolve(code ?? 1)
    })

    child.on('error', () => {
      resolve(1)
    })
  })
}

export type CommandResult = {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Run a command inside a container via `spindb run`.
 * Uses shell: true for Windows compatibility where pnpm is a .cmd shim.
 */
export function runContainerCommand(
  containerName: string,
  args: string[],
): CommandResult {
  const result = spawnSync(
    'pnpm',
    ['start', 'run', containerName, '--', ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    },
  )

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

export async function getContainerConfig(
  engine: string,
  name: string,
): Promise<ContainerConfig | null> {
  const homeDir = process.env.HOME || process.env.USERPROFILE
  if (!homeDir) {
    throw new Error(
      'Could not determine home directory. Set HOME or USERPROFILE environment variable.',
    )
  }

  const containerJsonPath = join(
    homeDir,
    '.spindb',
    'containers',
    engine,
    name,
    'container.json',
  )

  if (!existsSync(containerJsonPath)) {
    return null
  }

  try {
    const content = await readFile(containerJsonPath, 'utf-8')
    return JSON.parse(content) as ContainerConfig
  } catch {
    return null
  }
}

export async function waitForReady(
  containerName: string,
  checkCommand: string[],
  maxAttempts = 30,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = spawnSync(
      'pnpm',
      ['start', 'run', containerName, ...checkCommand],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true, // Required for Windows where pnpm is a .cmd shim
        timeout: 5000, // Prevent hanging on unresponsive commands
      },
    )

    // Check for timeout or termination signal
    if (result.error || result.signal) {
      // Timed out or killed - treat as failed attempt, continue to retry
      await new Promise((resolve) => setTimeout(resolve, 500))
      continue
    }

    if (result.status === 0) {
      return true
    }

    // Wait 500ms before retry
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return false
}

export async function waitForHttpReady(
  port: number,
  path: string = '/',
  maxAttempts = 30,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: controller.signal,
      })
      if (response.ok) {
        return true
      }
    } catch {
      // Server not ready yet or request timed out
    } finally {
      clearTimeout(timeout)
    }

    // Wait 500ms before retry
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return false
}

export function getSeedFile(engine: string, filename: string): string {
  return join(PROJECT_ROOT, 'tests', 'fixtures', engine, 'seeds', filename)
}

/**
 * Parse a command string into arguments, respecting single and double quotes.
 * Used for Redis/Valkey commands that contain JSON with spaces.
 *
 * Note: Does not handle escaped quotes within quoted strings (e.g., 'it\'s').
 *
 * Example: `SET user:1 '{"name":"Alice Johnson"}'` becomes
 *          ['SET', 'user:1', '{"name":"Alice Johnson"}']
 */
export function parseQuotedCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuote = false
  let quoteChar = ''

  for (let i = 0; i < command.length; i++) {
    const char = command[i]

    if (!inQuote && (char === "'" || char === '"')) {
      inQuote = true
      quoteChar = char
    } else if (inQuote && char === quoteChar) {
      inQuote = false
      quoteChar = ''
    } else if (!inQuote && char === ' ') {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}
