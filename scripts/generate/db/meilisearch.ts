#!/usr/bin/env tsx
/**
 * Generate a Meilisearch database with sample data.
 *
 * Usage:
 *   pnpm generate:db meilisearch [container-name] [--port <port>]
 *
 * Note: Meilisearch uses REST API, so data is inserted via HTTP requests.
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'meilisearch'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const INDEX_NAME = 'test_users'

const TEST_DATA = [
  { id: 1, name: 'Alice Johnson', email: 'alice@example.com', city: 'NYC' },
  { id: 2, name: 'Bob Smith', email: 'bob@example.com', city: 'LA' },
  { id: 3, name: 'Charlie Brown', email: 'charlie@example.com', city: 'SF' },
  { id: 4, name: 'Diana Ross', email: 'diana@example.com', city: 'Chicago' },
  { id: 5, name: 'Eve Wilson', email: 'eve@example.com', city: 'Boston' },
]

async function meiliRequest(
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

async function waitForTask(port: number, taskUid: number): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const response = await meiliRequest(port, 'GET', `/tasks/${taskUid}`)
    const task = (await response.json()) as { status: string }

    if (task.status === 'succeeded') {
      return true
    }
    if (task.status === 'failed') {
      return false
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('Meilisearch Database Generator')
  console.log('==============================\n')

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

  console.log('Waiting for Meilisearch to be ready...')
  const isReady = await waitForHttpReady(config.port, '/health')

  if (!isReady) {
    console.error('Error: Meilisearch did not become ready in time')
    process.exit(1)
  }

  console.log('Meilisearch is ready.\n')

  console.log('Seeding database with sample data...')

  // Delete index if it exists
  await meiliRequest(config.port, 'DELETE', `/indexes/${INDEX_NAME}`)
  await new Promise((resolve) => setTimeout(resolve, 500))

  // Create index
  const createResponse = await meiliRequest(config.port, 'POST', '/indexes', {
    uid: INDEX_NAME,
    primaryKey: 'id',
  })

  if (!createResponse.ok) {
    const error = await createResponse.text()
    console.error(`Error creating index: ${error}`)
    process.exit(1)
  }

  const createTask = (await createResponse.json()) as { taskUid: number }
  const indexCreated = await waitForTask(config.port, createTask.taskUid)

  if (!indexCreated) {
    console.error(`Error: Index creation task failed for "${INDEX_NAME}"`)
    process.exit(1)
  }

  // Insert documents
  const insertResponse = await meiliRequest(
    config.port,
    'POST',
    `/indexes/${INDEX_NAME}/documents`,
    TEST_DATA,
  )

  if (!insertResponse.ok) {
    const error = await insertResponse.text()
    console.error(`Error inserting documents: ${error}`)
    process.exit(1)
  }

  const insertTask = (await insertResponse.json()) as { taskUid: number }
  const success = await waitForTask(config.port, insertTask.taskUid)

  if (!success) {
    console.error('Error: Document insertion task failed')
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  const statsResponse = await meiliRequest(
    config.port,
    'GET',
    `/indexes/${INDEX_NAME}/stats`,
  )
  const stats = (await statsResponse.json()) as { numberOfDocuments: number }
  console.log(
    `Verified: ${stats.numberOfDocuments} documents in ${INDEX_NAME} index`,
  )

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
