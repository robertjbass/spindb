#!/usr/bin/env tsx
/**
 * Generate a CouchDB database with sample data.
 *
 * Usage:
 *   pnpm generate:db couchdb [container-name] [--port <port>]
 *
 * Note: CouchDB uses REST API, so data is inserted via HTTP requests.
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'couchdb'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const DB_NAME = 'testdb'
const AUTH = 'admin:admin' // Default CouchDB credentials

const TEST_DATA = [
  {
    _id: 'user:1',
    type: 'user',
    name: 'Alice Johnson',
    email: 'alice@example.com',
  },
  { _id: 'user:2', type: 'user', name: 'Bob Smith', email: 'bob@example.com' },
  {
    _id: 'user:3',
    type: 'user',
    name: 'Charlie Brown',
    email: 'charlie@example.com',
  },
  {
    _id: 'user:4',
    type: 'user',
    name: 'Diana Ross',
    email: 'diana@example.com',
  },
  { _id: 'user:5', type: 'user', name: 'Eve Wilson', email: 'eve@example.com' },
]

async function couchRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `http://${AUTH}@127.0.0.1:${port}${path}`
  const options: RequestInit = {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }
  return fetch(url, options)
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('CouchDB Database Generator')
  console.log('==========================\n')

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

  console.log('Waiting for CouchDB to be ready...')
  const isReady = await waitForHttpReady(config.port, '/')

  if (!isReady) {
    console.error('Error: CouchDB did not become ready in time')
    process.exit(1)
  }

  console.log('CouchDB is ready.\n')

  console.log('Seeding database with sample data...')

  // Delete database if it exists
  await couchRequest(config.port, 'DELETE', `/${DB_NAME}`)

  // Create database
  const createResponse = await couchRequest(config.port, 'PUT', `/${DB_NAME}`)

  if (!createResponse.ok && createResponse.status !== 412) {
    const error = await createResponse.text()
    console.error(`Error creating database: ${error}`)
    process.exit(1)
  }

  // Insert documents using bulk docs
  const bulkResponse = await couchRequest(
    config.port,
    'POST',
    `/${DB_NAME}/_bulk_docs`,
    { docs: TEST_DATA },
  )

  if (!bulkResponse.ok) {
    const error = await bulkResponse.text()
    console.error(`Error inserting documents: ${error}`)
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  try {
    const infoResponse = await couchRequest(config.port, 'GET', `/${DB_NAME}`)
    if (!infoResponse.ok) {
      const error = await infoResponse.text()
      console.error(`Error fetching database info: ${error}`)
      process.exit(1)
    }
    const info = (await infoResponse.json()) as { doc_count?: number }
    if (typeof info.doc_count !== 'number') {
      console.warn('Warning: Could not verify document count from response')
    } else {
      console.log(
        `Verified: ${info.doc_count} documents in ${DB_NAME} database`,
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
  console.log(
    `  pnpm start connect ${containerName}  # Opens Fauxton dashboard`,
  )
  console.log(`\nDefault credentials: admin / admin`)
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
