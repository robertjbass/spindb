#!/usr/bin/env tsx
/**
 * Generate a Qdrant database with sample data.
 *
 * Usage:
 *   pnpm generate:db qdrant [container-name] [--port <port>]
 *
 * Note: Qdrant uses REST API, so data is inserted via HTTP requests.
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'qdrant'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const COLLECTION_NAME = 'test_vectors'

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

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('Qdrant Database Generator')
  console.log('=========================\n')

  console.log(`Checking for container "${containerName}"...`)
  let config = await getContainerConfig(ENGINE, containerName)

  if (!config) {
    console.log(`Container not found. Creating "${containerName}"...`)
    const createArgs = ['create', containerName, '--engine', ENGINE]
    if (port) {
      createArgs.push('--port', port.toString())
    }
    const createResult = runSpindb(createArgs)

    if (!createResult.success) {
      console.error('Error creating container:')
      console.error(createResult.output)
      process.exit(1)
    }

    console.log('Container created successfully.')
    config = await getContainerConfig(ENGINE, containerName)

    if (!config) {
      console.error('Error: Could not read container config after creation')
      process.exit(1)
    }
  } else {
    console.log(`Found existing container on port ${config.port}`)
  }

  if (config.status !== 'running') {
    console.log(`Starting "${containerName}"...`)
    const startCode = await runSpindbStreaming(['start', containerName])

    if (startCode !== 0) {
      console.error('Error starting container')
      process.exit(1)
    }

    config = await getContainerConfig(ENGINE, containerName)
    if (!config) {
      console.error('Error: Could not read container config after start')
      process.exit(1)
    }
  }

  console.log(`Container running on port ${config.port}\n`)

  console.log('Waiting for Qdrant to be ready...')
  const isReady = await waitForHttpReady(config.port, '/healthz')

  if (!isReady) {
    console.error('Error: Qdrant did not become ready in time')
    process.exit(1)
  }

  console.log('Qdrant is ready.\n')

  console.log('Seeding database with sample data...')

  // Delete collection if it exists (404 is expected if collection doesn't exist)
  const encodedName = encodeURIComponent(COLLECTION_NAME)
  try {
    const deleteResponse = await qdrantRequest(
      config.port,
      'DELETE',
      `/collections/${encodedName}`,
    )
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const error = await deleteResponse.text()
      throw new Error(
        `Failed to delete collection "${COLLECTION_NAME}": ${error}`,
      )
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Failed to delete')) {
      throw error
    }
    // Network error - rethrow with context
    throw new Error(
      `Network error deleting collection "${COLLECTION_NAME}": ${error instanceof Error ? error.message : error}`,
    )
  }

  // Create collection
  const createResponse = await qdrantRequest(
    config.port,
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
  const insertResponse = await qdrantRequest(
    config.port,
    'PUT',
    `/collections/${encodedName}/points`,
    { points: TEST_DATA.points },
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`Error inserting points: ${error}`)
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  try {
    const infoResponse = await qdrantRequest(
      config.port,
      'GET',
      `/collections/${encodedName}`,
    )
    if (!infoResponse.ok) {
      const error = await infoResponse.text()
      console.error(
        `Error fetching collection "${COLLECTION_NAME}" info: ${error}`,
      )
      process.exit(1)
    }
    const info = (await infoResponse.json()) as {
      result?: { points_count?: number }
    }
    if (typeof info.result?.points_count !== 'number') {
      console.warn(
        `Warning: Could not verify points count for "${COLLECTION_NAME}"`,
      )
    } else {
      console.log(
        `Verified: ${info.result.points_count} points in ${COLLECTION_NAME} collection`,
      )
    }
  } catch (error) {
    console.error(
      `Error verifying data: ${error instanceof Error ? error.message : error}`,
    )
    process.exit(1)
  }

  console.log('\nDone!')
  console.log(`\nContainer "${containerName}" is ready with sample data.`)
  console.log(`\nConnection info:`)
  console.log(`  pnpm start url ${containerName}`)
  console.log(`  pnpm start connect ${containerName}  # Opens dashboard`)
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
