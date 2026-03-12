#!/usr/bin/env tsx
/**
 * Generate a libSQL database with sample data.
 *
 * Usage:
 *   pnpm generate:db libsql [container-name] [--port <port>]
 *
 * Note: libSQL uses REST API (Hrana over HTTP), so data is inserted via HTTP requests.
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
} from './_shared.js'

const ENGINE = 'libsql'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`

const SEED_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS test_user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Alice Johnson', 'alice@example.com')`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Bob Smith', 'bob@example.com')`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Charlie Brown', 'charlie@example.com')`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Diana Ross', 'diana@example.com')`,
  `INSERT OR IGNORE INTO test_user (name, email) VALUES ('Eve Wilson', 'eve@example.com')`,
]

async function libsqlQuery(port: number, sql: string): Promise<unknown> {
  const url = `http://127.0.0.1:${port}/v2/pipeline`
  const body = {
    requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }],
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`libSQL API request failed (${response.status}): ${text}`)
  }

  const data = (await response.json()) as {
    results: Array<{
      type: string
      response?: { type: string; result?: unknown }
      error?: { message: string }
    }>
  }

  const firstResult = data.results[0]
  if (firstResult?.type === 'error') {
    throw new Error(
      `libSQL query error: ${firstResult.error?.message ?? 'Unknown error'}`,
    )
  }

  return firstResult?.response?.result
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('libSQL Database Generator')
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

  console.log('Waiting for libSQL to be ready...')
  const isReady = await waitForHttpReady(config.port, '/health')

  if (!isReady) {
    console.error('Error: libSQL did not become ready in time')
    process.exit(1)
  }

  console.log('libSQL is ready.\n')

  console.log('Seeding database with sample data...')

  for (const sql of SEED_STATEMENTS) {
    try {
      await libsqlQuery(config.port, sql)
    } catch (error) {
      console.error(
        `Error executing SQL: ${error instanceof Error ? error.message : error}`,
      )
      process.exit(1)
    }
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  try {
    const result = await libsqlQuery(
      config.port,
      'SELECT COUNT(*) as count FROM test_user',
    )

    const typedResult = result as {
      cols?: Array<{ name: string }>
      rows?: Array<Array<{ type: string; value?: string | number }>>
    }

    if (
      !Array.isArray(typedResult?.rows) ||
      !Array.isArray(typedResult.rows[0]) ||
      typedResult.rows[0][0] == null
    ) {
      console.warn(
        'Warning: Unexpected result shape from COUNT query:',
        JSON.stringify(result),
      )
    } else {
      const cell = typedResult.rows[0][0]
      const count =
        cell.value !== undefined ? Number(cell.value) : undefined
      if (count !== undefined && !isNaN(count)) {
        console.log(`Verified: ${count} users in test_user table`)
      } else {
        console.warn(
          'Warning: Could not parse row count from:',
          JSON.stringify(cell),
        )
      }
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
  console.log(`  pnpm start connect ${containerName}  # Shows HTTP API info`)
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
