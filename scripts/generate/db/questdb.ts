#!/usr/bin/env tsx
/**
 * Generate a QuestDB database with sample data.
 *
 * Usage:
 *   pnpm generate:db questdb [container-name] [--port <port>]
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
  getSeedFile,
  runContainerCommand,
} from './_shared.js'

const ENGINE = 'questdb'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const SEED_FILE = getSeedFile(ENGINE, 'sample-db.sql')

// QuestDB's HTTP web console port offset from PG wire protocol port
// Default: PG port 8812 + 188 = HTTP port 9000
const QUESTDB_HTTP_PORT_OFFSET = 188

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('QuestDB Database Generator')
  console.log('==========================\n')

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

  const httpPort = config.port + QUESTDB_HTTP_PORT_OFFSET
  console.log('Waiting for QuestDB to be ready...')
  const isReady = await waitForHttpReady(httpPort, '/')

  if (!isReady) {
    console.error('Error: QuestDB did not become ready in time')
    process.exit(1)
  }

  console.log('QuestDB is ready.\n')

  console.log('Seeding database with sample data...')
  const seedContent = await readFile(SEED_FILE, 'utf-8')

  // QuestDB uses psql via spindb run
  const seedResult = runContainerCommand(containerName, ['-c', seedContent])

  if (seedResult.status !== 0) {
    console.error('Error seeding database:')
    console.error(seedResult.stderr)
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  const verifyResult = runContainerCommand(containerName, [
    '-c',
    'SELECT COUNT(*) FROM test_user',
  ])

  if (verifyResult.status === 0) {
    const match = verifyResult.stdout.match(/(\d+)/)
    if (match) {
      console.log(`Verified: ${match[1]} users in test_user table`)
    } else {
      console.warn(
        'Warning: Could not verify user count from output:',
        verifyResult.stdout.trim() || '(empty)',
      )
    }
  } else {
    console.warn('Warning: Verification query failed:', verifyResult.stderr)
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
