#!/usr/bin/env tsx
/**
 * Generate a Qdrant snapshot fixture for testing.
 *
 * Usage:
 *   pnpm generate:qdrant-snapshot [name]
 *
 * Arguments:
 *   name - Optional snapshot name (default: "test_vectors")
 *          The .snapshot extension is added automatically
 *
 * Examples:
 *   pnpm generate:qdrant-snapshot                    # Creates test_vectors.snapshot
 *   pnpm generate:qdrant-snapshot my-snapshot        # Creates my-snapshot.snapshot
 *   pnpm generate:qdrant-snapshot backup.snapshot    # Creates backup.snapshot
 *
 * This script:
 * 1. Finds a running Qdrant container (or uses the first available)
 * 2. Creates a test collection with sample data
 * 3. Generates a snapshot
 * 4. Downloads the snapshot to the appropriate location
 *
 * Output location:
 * - If run from spindb project: tests/fixtures/qdrant/snapshots/{name}.snapshot
 * - If run elsewhere: ./{name}.snapshot in the current working directory
 */

import { existsSync, mkdirSync, createWriteStream } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'

const COLLECTION_NAME = 'test_vectors'
const DEFAULT_SNAPSHOT_NAME = 'test_vectors'

// Get snapshot name from command line argument or use default
function getSnapshotName(): string {
  const arg = process.argv[2]
  if (arg && !arg.startsWith('-')) {
    // Remove .snapshot extension if provided
    return arg.replace(/\.snapshot$/, '')
  }
  return DEFAULT_SNAPSHOT_NAME
}

const SNAPSHOT_NAME = getSnapshotName()
const SNAPSHOT_FILENAME = `${SNAPSHOT_NAME}.snapshot`

const TEST_DATA = {
  vectors: { size: 4, distance: 'Cosine' },
  points: [
    {
      id: 1,
      vector: [0.1, 0.2, 0.3, 0.4],
      payload: { name: 'Alice', city: 'NYC' },
    },
    {
      id: 2,
      vector: [0.2, 0.3, 0.4, 0.5],
      payload: { name: 'Bob', city: 'LA' },
    },
    {
      id: 3,
      vector: [0.9, 0.8, 0.7, 0.6],
      payload: { name: 'Charlie', city: 'SF' },
    },
  ],
}

/**
 * URL-encode a collection name for use in REST API paths.
 * Handles special characters that could cause path issues.
 */
function encodeCollectionName(name: string): string {
  return encodeURIComponent(name)
}

async function qdrantRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `http://127.0.0.1:${port}${path}`
  const options: RequestInit = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }
  return fetch(url, options)
}

async function findQdrantContainer(): Promise<{
  name: string
  port: number
} | null> {
  try {
    // Containers are stored in ~/.spindb/containers/{engine}/{name}/container.json
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    const qdrantContainersDir = join(homeDir, '.spindb', 'containers', 'qdrant')

    if (!existsSync(qdrantContainersDir)) {
      return null
    }

    // Read all container directories
    const { readdir } = await import('fs/promises')
    const containerDirs = await readdir(qdrantContainersDir, {
      withFileTypes: true,
    })

    type ContainerConfig = {
      name: string
      engine: string
      port: number
      status: string
    }

    const containers: ContainerConfig[] = []

    for (const dir of containerDirs) {
      if (!dir.isDirectory()) continue

      const containerJsonPath = join(
        qdrantContainersDir,
        dir.name,
        'container.json',
      )
      if (!existsSync(containerJsonPath)) continue

      try {
        const content = await readFile(containerJsonPath, 'utf-8')
        const config = JSON.parse(content) as ContainerConfig
        containers.push(config)
      } catch {
        // Skip invalid container configs
      }
    }

    // Find first running Qdrant container
    const runningContainer = containers.find((c) => c.status === 'running')
    if (runningContainer) {
      return { name: runningContainer.name, port: runningContainer.port }
    }

    // If no running container, try any Qdrant container
    if (containers.length > 0) {
      return { name: containers[0].name, port: containers[0].port }
    }

    return null
  } catch {
    return null
  }
}

async function checkQdrantHealth(port: number): Promise<boolean> {
  try {
    const response = await qdrantRequest(port, 'GET', '/healthz')
    return response.ok
  } catch {
    return false
  }
}

async function getOutputPath(): Promise<string> {
  const cwd = process.cwd()
  const packageJsonPath = join(cwd, 'package.json')

  try {
    if (existsSync(packageJsonPath)) {
      const packageJsonContent = await readFile(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(packageJsonContent) as { name: string }

      if (packageJson.name === 'spindb') {
        // Running from spindb project - save to fixtures
        const fixturesDir = join(
          cwd,
          'tests',
          'fixtures',
          'qdrant',
          'snapshots',
        )
        if (!existsSync(fixturesDir)) {
          mkdirSync(fixturesDir, { recursive: true })
        }
        return join(fixturesDir, SNAPSHOT_FILENAME)
      }
    }
  } catch (error) {
    console.warn('Warning: Could not read package.json:', error)
  }

  // Default: save to current directory
  return join(cwd, SNAPSHOT_FILENAME)
}

async function main() {
  console.log('Qdrant Snapshot Generator')
  console.log('=========================\n')

  // Find Qdrant container
  console.log('Looking for Qdrant container...')
  const container = await findQdrantContainer()

  if (!container) {
    console.error(
      'Error: No Qdrant container found.\n' +
        'Please create and start a Qdrant container first:\n' +
        '  spindb create my-qdrant --engine qdrant\n' +
        '  spindb start my-qdrant',
    )
    process.exit(1)
  }

  console.log(`Found container: ${container.name} (port ${container.port})`)

  // Check if Qdrant is responding
  console.log('Checking Qdrant health...')
  const isHealthy = await checkQdrantHealth(container.port)

  if (!isHealthy) {
    console.error(
      `Error: Qdrant is not responding on port ${container.port}.\n` +
        'Please ensure the container is running:\n' +
        `  spindb start ${container.name}`,
    )
    process.exit(1)
  }

  console.log('Qdrant is healthy\n')

  const port = container.port

  // Delete collection if it exists
  console.log(`Cleaning up existing ${COLLECTION_NAME} collection...`)
  const encodedName = encodeCollectionName(COLLECTION_NAME)
  await qdrantRequest(port, 'DELETE', `/collections/${encodedName}`)

  // Create collection
  console.log(`Creating ${COLLECTION_NAME} collection...`)
  const createResponse = await qdrantRequest(
    port,
    'PUT',
    `/collections/${encodedName}`,
    { vectors: TEST_DATA.vectors },
  )

  if (!createResponse.ok) {
    const error = await createResponse.text()
    console.error(`Error creating collection: ${error}`)
    process.exit(1)
  }

  // Insert test points
  console.log(`Inserting ${TEST_DATA.points.length} test points...`)
  const insertResponse = await qdrantRequest(
    port,
    'PUT',
    `/collections/${encodedName}/points`,
    { points: TEST_DATA.points },
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`Error inserting points: ${error}`)
    process.exit(1)
  }

  // Verify data
  const infoResponse = await qdrantRequest(
    port,
    'GET',
    `/collections/${encodedName}`,
  )
  const info = (await infoResponse.json()) as {
    result: { points_count: number }
  }
  console.log(`Verified: ${info.result.points_count} points in collection\n`)

  // Create snapshot
  console.log('Creating snapshot (this may take a moment)...')
  const snapshotResponse = await qdrantRequest(
    port,
    'POST',
    `/collections/${encodedName}/snapshots`,
  )

  if (!snapshotResponse.ok) {
    const error = await snapshotResponse.text()
    console.error(`Error creating snapshot: ${error}`)
    process.exit(1)
  }

  const snapshotResult = (await snapshotResponse.json()) as {
    result: { name: string; size: number }
  }
  const snapshotName = snapshotResult.result.name
  const snapshotSize = snapshotResult.result.size

  console.log(`Snapshot created: ${snapshotName}`)
  console.log(`Size: ${(snapshotSize / 1024 / 1024).toFixed(1)} MB\n`)

  // Download snapshot
  const outputPath = await getOutputPath()
  console.log(`Downloading snapshot to: ${outputPath}`)

  const downloadResponse = await fetch(
    `http://127.0.0.1:${port}/collections/${encodedName}/snapshots/${encodeURIComponent(snapshotName)}`,
  )

  if (!downloadResponse.ok || !downloadResponse.body) {
    console.error('Error downloading snapshot')
    process.exit(1)
  }

  // Use pipeline to stream the download to file
  const fileStream = createWriteStream(outputPath)
  // @ts-expect-error - Node.js ReadableStream compatibility
  await pipeline(downloadResponse.body, fileStream)

  console.log('Download complete!\n')

  // Clean up - delete the collection
  console.log(`Cleaning up ${COLLECTION_NAME} collection...`)
  await qdrantRequest(port, 'DELETE', `/collections/${encodedName}`)

  // Delete the snapshot from Qdrant (we have our local copy)
  await qdrantRequest(
    port,
    'DELETE',
    `/collections/${encodedName}/snapshots/${encodeURIComponent(snapshotName)}`,
  ).catch(() => {
    // Collection already deleted, snapshot goes with it
  })

  console.log('\nDone!')
  console.log(`Snapshot saved to: ${outputPath}`)
  console.log(
    '\nYou can use this snapshot to test Qdrant restore functionality:',
  )
  console.log(`  spindb restore <container-name> "${outputPath}"`)

  if (SNAPSHOT_NAME !== DEFAULT_SNAPSHOT_NAME) {
    console.log(`\nNote: Custom snapshot name "${SNAPSHOT_NAME}" was used.`)
  }
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
