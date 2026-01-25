/**
 * Test container cleanup utilities
 *
 * Provides functions to detect and remove orphaned test containers.
 * Can be used by the doctor command or called directly after tests.
 */

import { existsSync } from 'fs'
import { readdir, rm } from 'fs/promises'
import { join } from 'path'
import { paths } from '../config/paths'
import { getSupportedEngines } from '../config/engine-defaults'

// Test container detection patterns
// These match the naming conventions used by integration tests
const TEST_CONTAINER_PATTERNS = [
  // Pattern: name-test_<8-char-hex> (e.g., duckdb-test_04b0613f)
  /^.+-test_[0-9a-f]{6,}$/i,
  // Pattern: name-test-suffix_<8-char-hex> (e.g., ferretdb-test-conflict_21e4d447)
  /^.+-test-.+_[0-9a-f]{6,}$/i,
  // Pattern: name-test-renamed_<8-char-hex> (e.g., mysql-test-renamed-1862f018)
  /^.+-test-renamed[-_][0-9a-f]{6,}$/i,
]

export type OrphanedTestContainer = {
  engine: string
  name: string
  path: string
}

/**
 * Check if a container name matches test container patterns.
 */
export function isTestContainer(name: string): boolean {
  return TEST_CONTAINER_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Find all orphaned test container directories.
 * Scans the filesystem directly since these may not have valid container.json files.
 *
 * @returns Array of orphaned test container info
 */
export async function findOrphanedTestContainers(): Promise<
  OrphanedTestContainer[]
> {
  const containersDir = paths.containers
  if (!existsSync(containersDir)) {
    return []
  }

  const engines = getSupportedEngines()
  const testDirs: OrphanedTestContainer[] = []

  for (const engine of engines) {
    const engineDir = paths.getEngineContainersPath(engine)
    if (!existsSync(engineDir)) {
      continue
    }

    try {
      const entries = await readdir(engineDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && isTestContainer(entry.name)) {
          testDirs.push({
            engine,
            name: entry.name,
            path: join(engineDir, entry.name),
          })
        }
      }
    } catch {
      // Ignore errors reading directories
    }
  }

  return testDirs
}

/**
 * Delete a single orphaned test container directory.
 *
 * @param container - The container to delete
 */
export async function deleteTestContainer(
  container: OrphanedTestContainer,
): Promise<void> {
  await rm(container.path, { recursive: true, force: true })
}

/**
 * Delete all orphaned test containers.
 * Useful for cleanup after integration tests.
 *
 * @returns Number of containers deleted
 */
export async function cleanupTestContainers(): Promise<number> {
  const orphaned = await findOrphanedTestContainers()

  for (const container of orphaned) {
    await deleteTestContainer(container)
  }

  return orphaned.length
}
