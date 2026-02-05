#!/usr/bin/env tsx
/**
 * Generate a ClickHouse database with sample data.
 *
 * Usage:
 *   pnpm generate:db clickhouse [container-name] [--port <port>]
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForReady,
  getSeedFile,
  runContainerCommand,
} from './_shared.js'

const ENGINE = 'clickhouse'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const SEED_FILE = getSeedFile(ENGINE, 'sample-db.sql')

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('ClickHouse Database Generator')
  console.log('=============================\n')

  if (!existsSync(SEED_FILE)) {
    console.error(`Error: Seed file not found: ${SEED_FILE}`)
    process.exit(1)
  }

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

  console.log('Waiting for ClickHouse to be ready...')
  const isReady = await waitForReady(containerName, ['--', '-q', 'SELECT 1'])

  if (!isReady) {
    console.error('Error: ClickHouse did not become ready in time')
    process.exit(1)
  }

  console.log('ClickHouse is ready.\n')

  console.log('Seeding database with sample data...')
  const seedContent = await readFile(SEED_FILE, 'utf-8')

  // ClickHouse needs multiquery for multiple statements
  const seedResult = runContainerCommand(containerName, [
    '--multiquery',
    '-q',
    seedContent,
  ])

  if (seedResult.status !== 0) {
    console.error('Error seeding database:')
    console.error(seedResult.stderr)
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  const verifyResult = runContainerCommand(containerName, [
    '-q',
    'SELECT COUNT(*) FROM test_user',
  ])

  if (verifyResult.status === 0) {
    const match = verifyResult.stdout.trim()
    if (match) {
      console.log(`Verified: ${match} users in test_user table`)
    }
  }

  console.log('\nDone!')
  console.log(`\nContainer "${containerName}" is ready with sample data.`)
  console.log(`\nConnection info:`)
  console.log(`  pnpm start url ${containerName}`)
  console.log(`  pnpm start connect ${containerName}`)
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
