#!/usr/bin/env tsx
/**
 * Generate an InfluxDB database with sample data.
 *
 * Usage:
 *   pnpm generate:db influxdb [container-name] [--port <port>]
 *
 * Note: InfluxDB uses REST API, so data is inserted via HTTP requests.
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'influxdb'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const DB_NAME = 'testdb'

const TEST_DATA_LINE_PROTOCOL = [
  'test_user,id=1 name="Alice Johnson",email="alice@example.com"',
  'test_user,id=2 name="Bob Smith",email="bob@example.com"',
  'test_user,id=3 name="Charlie Brown",email="charlie@example.com"',
  'test_user,id=4 name="Diana Ross",email="diana@example.com"',
  'test_user,id=5 name="Eve Wilson",email="eve@example.com"',
].join('\n')

async function influxRequest(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
): Promise<Response> {
  const url = `http://127.0.0.1:${port}${path}`
  const headers: Record<string, string> = {}
  if (contentType) {
    headers['Content-Type'] = contentType
  } else if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json'
  }
  const options: RequestInit = {
    method,
    headers,
    body:
      typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined,
  }
  return fetch(url, options)
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('InfluxDB Database Generator')
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

  console.log('Waiting for InfluxDB to be ready...')
  const isReady = await waitForHttpReady(config.port, '/health')

  if (!isReady) {
    console.error('Error: InfluxDB did not become ready in time')
    process.exit(1)
  }

  console.log('InfluxDB is ready.\n')

  console.log('Seeding database with sample data...')

  // Write test data using line protocol (creates database implicitly)
  const writeResponse = await influxRequest(
    config.port,
    'POST',
    `/api/v3/write_lp?db=${encodeURIComponent(DB_NAME)}`,
    TEST_DATA_LINE_PROTOCOL,
    'text/plain',
  )

  if (!writeResponse.ok) {
    const error = await writeResponse.text()
    console.error(`Error writing data: ${error}`)
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  try {
    const queryResponse = await influxRequest(
      config.port,
      'POST',
      '/api/v3/query_sql',
      {
        db: DB_NAME,
        q: 'SELECT COUNT(*) as count FROM test_user',
        format: 'json',
      },
    )
    if (!queryResponse.ok) {
      const error = await queryResponse.text()
      console.error(`Error querying data: ${error}`)
      process.exit(1)
    }
    const data = (await queryResponse.json()) as Array<{ count?: number }>
    const count = data?.[0]?.count
    if (typeof count !== 'number') {
      console.warn('Warning: Could not verify record count from response')
    } else {
      console.log(`Verified: ${count} records in ${DB_NAME} database`)
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
    `  pnpm start connect ${containerName}  # Shows REST API endpoints`,
  )
  console.log(`\nREST API: http://127.0.0.1:${config.port}`)
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
