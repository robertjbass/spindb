/**
 * Test helpers for system integration tests
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { containerManager } from '../../core/container-manager'
import { portManager } from '../../core/port-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { paths } from '../../config/paths'
import { Engine } from '../../types'

const execAsync = promisify(exec)

/**
 * Default test port configuration
 */
export const TEST_PORTS = {
  postgresql: { base: 5454, clone: 5456, renamed: 5455 },
  mysql: { base: 3333, clone: 3335, renamed: 3334 },
}

/**
 * Generate a unique test container name
 * Container names must start with a letter, so we put the suffix first
 */
export function generateTestName(prefix = 'test'): string {
  const uuid = randomUUID().slice(0, 8)
  return `${prefix}-${uuid}`
}

/**
 * Find N consecutive free ports starting from a base port
 */
export async function findConsecutiveFreePorts(
  count: number,
  startPort: number,
): Promise<number[]> {
  const ports: number[] = []
  let currentPort = startPort

  while (ports.length < count) {
    const available = await portManager.isPortAvailable(currentPort)
    if (available) {
      // Check if we can get consecutive ports from here
      let consecutiveAvailable = true
      for (let i = 1; i < count - ports.length; i++) {
        if (!(await portManager.isPortAvailable(currentPort + i))) {
          consecutiveAvailable = false
          break
        }
      }

      if (consecutiveAvailable || ports.length === count - 1) {
        ports.push(currentPort)
        currentPort++
      } else {
        // Skip to next port and try again
        currentPort++
        ports.length = 0 // Reset and start over
      }
    } else {
      currentPort++
      ports.length = 0 // Reset if we hit a busy port
    }

    // Safety valve to prevent infinite loop
    if (currentPort > startPort + 100) {
      throw new Error(
        `Could not find ${count} consecutive free ports starting from ${startPort}`,
      )
    }
  }

  return ports
}

/**
 * Clean up all test containers (matching *-test* pattern)
 */
export async function cleanupTestContainers(): Promise<string[]> {
  const containers = await containerManager.list()
  const testContainers = containers.filter((c) => c.name.includes('-test'))

  const deleted: string[] = []
  for (const container of testContainers) {
    try {
      // Stop if running
      const running = await processManager.isRunning(container.name, {
        engine: container.engine,
      })
      if (running) {
        const engine = getEngine(container.engine)
        const config = await containerManager.getConfig(container.name)
        if (config) {
          await engine.stop(config)
        }
      }

      // Delete container
      await containerManager.delete(container.name, { force: true })
      deleted.push(container.name)
    } catch {
      // Ignore errors during cleanup
    }
  }

  return deleted
}

/**
 * Execute SQL against a database and return the result
 */
export async function executeSQL(
  engine: Engine,
  port: number,
  database: string,
  sql: string,
): Promise<{ stdout: string; stderr: string }> {
  if (engine === Engine.MySQL) {
    const cmd = `mysql -h 127.0.0.1 -P ${port} -u root ${database} -e "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  } else {
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/${database}`
    const cmd = `psql "${connectionString}" -c "${sql.replace(/"/g, '\\"')}"`
    return execAsync(cmd)
  }
}

/**
 * Execute a SQL file against a database
 */
export async function executeSQLFile(
  engine: Engine,
  port: number,
  database: string,
  filePath: string,
): Promise<{ stdout: string; stderr: string }> {
  if (engine === Engine.MySQL) {
    const cmd = `mysql -h 127.0.0.1 -P ${port} -u root ${database} < "${filePath}"`
    return execAsync(cmd)
  } else {
    const connectionString = `postgresql://postgres@127.0.0.1:${port}/${database}`
    const cmd = `psql "${connectionString}" -f "${filePath}"`
    return execAsync(cmd)
  }
}

/**
 * Query row count from a table
 */
export async function getRowCount(
  engine: Engine,
  port: number,
  database: string,
  table: string,
): Promise<number> {
  const { stdout } = await executeSQL(
    engine,
    port,
    database,
    `SELECT COUNT(*) as count FROM ${table}`,
  )

  // Parse the count from output
  // PostgreSQL: " count \n-------\n     5\n(1 row)\n"
  // MySQL: "count\n5\n"
  const lines = stdout.trim().split('\n')
  for (const line of lines) {
    const num = parseInt(line.trim(), 10)
    if (!isNaN(num)) {
      return num
    }
  }

  throw new Error(`Could not parse row count from: ${stdout}`)
}

/**
 * Wait for a database to be ready to accept connections
 */
export async function waitForReady(
  engine: Engine,
  port: number,
  timeoutMs = 30000,
): Promise<boolean> {
  const startTime = Date.now()
  const checkInterval = 500

  while (Date.now() - startTime < timeoutMs) {
    try {
      if (engine === Engine.MySQL) {
        await execAsync(`mysqladmin -h 127.0.0.1 -P ${port} -u root ping`)
      } else {
        await execAsync(
          `psql "postgresql://postgres@127.0.0.1:${port}/postgres" -c "SELECT 1"`,
        )
      }
      return true
    } catch {
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }
  }

  return false
}

/**
 * Check if a container's data directory exists on the filesystem
 */
export function containerDataExists(
  containerName: string,
  engine: Engine,
): boolean {
  const containerPath = paths.getContainerPath(containerName, { engine })
  return existsSync(containerPath)
}

/**
 * Get connection string for a container
 */
export function getConnectionString(
  engine: Engine,
  port: number,
  database: string,
): string {
  if (engine === Engine.MySQL) {
    return `mysql://root@127.0.0.1:${port}/${database}`
  }
  return `postgresql://postgres@127.0.0.1:${port}/${database}`
}

/**
 * Assert helper that throws with descriptive message
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

/**
 * Assert two values are equal
 */
export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}\n  Expected: ${expected}\n  Actual: ${actual}`)
  }
}

/**
 * Execute SQL file using engine.runScript (tests the run command functionality)
 */
export async function runScriptFile(
  containerName: string,
  filePath: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    throw new Error(`Container "${containerName}" not found`)
  }

  const engine = getEngine(config.engine)
  await engine.runScript(config, {
    file: filePath,
    database,
  })
}

/**
 * Execute inline SQL using engine.runScript (tests the run command functionality)
 */
export async function runScriptSQL(
  containerName: string,
  sql: string,
  database?: string,
): Promise<void> {
  const config = await containerManager.getConfig(containerName)
  if (!config) {
    throw new Error(`Container "${containerName}" not found`)
  }

  const engine = getEngine(config.engine)
  await engine.runScript(config, {
    sql,
    database,
  })
}
