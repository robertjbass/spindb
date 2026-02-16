#!/usr/bin/env tsx
/**
 * Generate a Weaviate database with sample data.
 *
 * Usage:
 *   pnpm generate:db weaviate [container-name] [--port <port>]
 *
 * Note: Weaviate uses REST API, so data is inserted via HTTP requests.
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'weaviate'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const CLASS_NAME = 'TestVectors'

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

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('Weaviate Database Generator')
  console.log('===========================\n')

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

  console.log('Waiting for Weaviate to be ready...')
  const isReady = await waitForHttpReady(config.port, '/v1/.well-known/ready')

  if (!isReady) {
    console.error('Error: Weaviate did not become ready in time')
    process.exit(1)
  }

  console.log('Weaviate is ready.\n')

  console.log('Seeding database with sample data...')

  // Delete class if it exists (404 is expected if class doesn't exist)
  try {
    const deleteResponse = await weaviateRequest(
      config.port,
      'DELETE',
      `/v1/schema/${CLASS_NAME}`,
    )
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      const error = await deleteResponse.text()
      throw new Error(`Failed to delete class "${CLASS_NAME}": ${error}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Failed to delete')) {
      throw error
    }
    // Network error - rethrow with context
    throw new Error(
      `Network error deleting class "${CLASS_NAME}": ${error instanceof Error ? error.message : error}`,
    )
  }

  // Create class
  const createResponse = await weaviateRequest(
    config.port,
    'POST',
    '/v1/schema',
    TEST_DATA.classConfig,
  )

  if (!createResponse.ok) {
    const error = await createResponse.text()
    console.error(`Error creating class: ${error}`)
    process.exit(1)
  }

  // Insert test objects via batch API
  const insertResponse = await weaviateRequest(
    config.port,
    'POST',
    '/v1/batch/objects',
    { objects: TEST_DATA.objects },
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`Error inserting objects: ${error}`)
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  try {
    const schemaResponse = await weaviateRequest(
      config.port,
      'GET',
      '/v1/schema',
    )
    if (!schemaResponse.ok) {
      const error = await schemaResponse.text()
      console.error(`Error fetching schema: ${error}`)
      process.exit(1)
    }
    const schema = (await schemaResponse.json()) as {
      classes?: Array<{ class?: string }>
    }
    const classCount = schema.classes?.length || 0
    console.log(`Verified: ${classCount} class(es) in schema`)

    const classInfo = schema.classes?.find((c) => c.class === CLASS_NAME)
    if (classInfo) {
      console.log(`  - ${CLASS_NAME} class found`)
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
