#!/usr/bin/env tsx
/**
 * Generate a Weaviate backup fixture for testing.
 *
 * Usage:
 *   pnpm generate:backup weaviate [name]
 *
 * Arguments:
 *   name - Optional backup name (default: "test_vectors")
 *
 * Examples:
 *   pnpm generate:backup weaviate                    # Creates test_vectors/ backup dir
 *   pnpm generate:backup weaviate my-backup          # Creates my-backup/ backup dir
 *
 * This script:
 * 1. Finds a running Weaviate container (or uses the first available)
 * 2. Creates a test class with sample data
 * 3. Generates a filesystem backup (directory, not a single file)
 * 4. Copies the backup directory to the appropriate location
 *
 * Output location:
 * - If run from spindb project: tests/fixtures/weaviate/snapshots/{name}/
 * - If run elsewhere: ./{name}/ in the current working directory
 *
 * Note: Weaviate backups are directories (not single files like Qdrant .snapshot).
 * The directory name must match the internal backup ID in backup_config.json.
 */

import { existsSync, mkdirSync } from 'fs'
import { readFile, cp } from 'fs/promises'
import { join } from 'path'

const CLASS_NAME = 'TestVectors'
const DEFAULT_SNAPSHOT_NAME = 'test_vectors'

// Get backup name from command line argument or use default
function getBackupName(): string {
  const arg = process.argv[2]
  if (arg && !arg.startsWith('-')) {
    return arg
  }
  return DEFAULT_SNAPSHOT_NAME
}

const BACKUP_NAME = getBackupName()

const TEST_DATA = {
  classConfig: {
    class: CLASS_NAME,
    vectorizer: 'none',
    properties: [
      { name: 'name', dataType: ['text'] },
      { name: 'city', dataType: ['text'] },
    ],
  },
  objects: [
    {
      class: CLASS_NAME,
      properties: { name: 'Alice', city: 'NYC' },
      vector: [0.1, 0.2, 0.3, 0.4],
    },
    {
      class: CLASS_NAME,
      properties: { name: 'Bob', city: 'LA' },
      vector: [0.2, 0.3, 0.4, 0.5],
    },
    {
      class: CLASS_NAME,
      properties: { name: 'Charlie', city: 'SF' },
      vector: [0.9, 0.8, 0.7, 0.6],
    },
  ],
}

async function weaviateRequest(
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

async function findWeaviateContainer(): Promise<{
  name: string
  port: number
} | null> {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    const weaviateContainersDir = join(
      homeDir,
      '.spindb',
      'containers',
      'weaviate',
    )

    if (!existsSync(weaviateContainersDir)) {
      return null
    }

    const { readdir } = await import('fs/promises')
    const containerDirs = await readdir(weaviateContainersDir, {
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
        weaviateContainersDir,
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

    // Find first running Weaviate container
    const runningContainer = containers.find((c) => c.status === 'running')
    if (runningContainer) {
      return { name: runningContainer.name, port: runningContainer.port }
    }

    // If no running container, try any Weaviate container
    if (containers.length > 0) {
      return { name: containers[0].name, port: containers[0].port }
    }

    return null
  } catch {
    return null
  }
}

async function checkWeaviateHealth(port: number): Promise<boolean> {
  try {
    const response = await weaviateRequest(port, 'GET', '/v1/.well-known/ready')
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
          'weaviate',
          'snapshots',
        )
        if (!existsSync(fixturesDir)) {
          mkdirSync(fixturesDir, { recursive: true })
        }
        return join(fixturesDir, BACKUP_NAME)
      }
    }
  } catch (error) {
    console.warn('Warning: Could not read package.json:', error)
  }

  // Default: save to current directory
  return join(cwd, BACKUP_NAME)
}

async function main() {
  console.log('Weaviate Snapshot Generator')
  console.log('===========================\n')

  // Find Weaviate container
  console.log('Looking for Weaviate container...')
  const container = await findWeaviateContainer()

  if (!container) {
    console.error(
      'Error: No Weaviate container found.\n' +
        'Please create and start a Weaviate container first:\n' +
        '  spindb create my-weaviate --engine weaviate\n' +
        '  spindb start my-weaviate',
    )
    process.exit(1)
  }

  console.log(`Found container: ${container.name} (port ${container.port})`)

  // Check if Weaviate is responding
  console.log('Checking Weaviate health...')
  const isHealthy = await checkWeaviateHealth(container.port)

  if (!isHealthy) {
    console.error(
      `Error: Weaviate is not responding on port ${container.port}.\n` +
        'Please ensure the container is running:\n' +
        `  spindb start ${container.name}`,
    )
    process.exit(1)
  }

  console.log('Weaviate is healthy\n')

  const port = container.port

  // Delete class if it exists
  console.log(`Cleaning up existing ${CLASS_NAME} class...`)
  await weaviateRequest(port, 'DELETE', `/v1/schema/${CLASS_NAME}`)

  // Create class
  console.log(`Creating ${CLASS_NAME} class...`)
  const createResponse = await weaviateRequest(
    port,
    'POST',
    '/v1/schema',
    TEST_DATA.classConfig,
  )

  if (!createResponse.ok) {
    const error = await createResponse.text()
    console.error(`Error creating class: ${error}`)
    process.exit(1)
  }

  // Insert test objects
  console.log(`Inserting ${TEST_DATA.objects.length} test objects...`)
  const insertResponse = await weaviateRequest(
    port,
    'POST',
    '/v1/batch/objects',
    { objects: TEST_DATA.objects },
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`Error inserting objects: ${error}`)
    process.exit(1)
  }

  // Verify data
  const schemaResponse = await weaviateRequest(port, 'GET', '/v1/schema')
  const schema = (await schemaResponse.json()) as {
    classes?: Array<{ class?: string }>
  }
  const classCount = schema.classes?.length || 0
  console.log(`Verified: ${classCount} class(es) in schema\n`)

  // Create backup via filesystem API
  const backupId = `backup-${Date.now()}`
  console.log('Creating backup (this may take a moment)...')

  // The backup path is configured via BACKUP_FILESYSTEM_PATH env var on the server
  // We need to use the container's data directory
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  const containerDir = join(
    homeDir,
    '.spindb',
    'containers',
    'weaviate',
    container.name,
  )
  const backupDir = join(containerDir, 'backups')
  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true })
  }

  const backupResponse = await weaviateRequest(
    port,
    'POST',
    '/v1/backups/filesystem',
    {
      id: backupId,
      include: [CLASS_NAME],
    },
  )

  if (!backupResponse.ok) {
    const error = await backupResponse.text()
    console.error(`Error creating backup: ${error}`)
    process.exit(1)
  }

  // Poll for backup completion
  console.log('Waiting for backup to complete...')
  let backupComplete = false
  for (let i = 0; i < 60; i++) {
    const statusResponse = await weaviateRequest(
      port,
      'GET',
      `/v1/backups/filesystem/${backupId}`,
    )

    if (statusResponse.ok) {
      const status = (await statusResponse.json()) as { status: string }
      if (status.status === 'SUCCESS') {
        backupComplete = true
        break
      } else if (status.status === 'FAILED') {
        console.error('Backup failed')
        process.exit(1)
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  if (!backupComplete) {
    console.error('Backup timed out')
    process.exit(1)
  }

  console.log('Backup complete!\n')

  // Copy backup to output path
  const outputPath = await getOutputPath()
  const backupSourceDir = join(backupDir, backupId)

  if (!existsSync(backupSourceDir)) {
    console.error(
      `Error: Backup directory not found at ${backupSourceDir}\n` +
        `The Weaviate backup API reported SUCCESS but the directory does not exist.\n` +
        `Check that BACKUP_FILESYSTEM_PATH is set to: ${backupDir}`,
    )
    process.exit(1)
  }

  console.log(`Copying backup to: ${outputPath}`)
  await cp(backupSourceDir, outputPath, { recursive: true })
  console.log('Copy complete!\n')

  // Clean up - delete the class
  console.log(`Cleaning up ${CLASS_NAME} class...`)
  await weaviateRequest(port, 'DELETE', `/v1/schema/${CLASS_NAME}`)

  console.log('\nDone!')
  console.log(`Backup saved to: ${outputPath}`)
  console.log(
    '\nYou can use this backup to test Weaviate restore functionality:',
  )
  console.log(`  spindb restore <container-name> "${outputPath}"`)

  if (BACKUP_NAME !== DEFAULT_SNAPSHOT_NAME) {
    console.log(`\nNote: Custom backup name "${BACKUP_NAME}" was used.`)
  }
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
