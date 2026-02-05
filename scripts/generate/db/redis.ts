#!/usr/bin/env tsx
/**
 * Generate a Redis database with sample data.
 *
 * Usage:
 *   pnpm generate:db redis [container-name] [--port <port>]
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
  parseQuotedCommand,
  runContainerCommand,
} from './_shared.js'

const ENGINE = 'redis'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const SEED_FILE = getSeedFile(ENGINE, 'sample-db.redis')

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('Redis Database Generator')
  console.log('========================\n')

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

  console.log('Waiting for Redis to be ready...')
  const isReady = await waitForReady(containerName, ['--', 'PING'])

  if (!isReady) {
    console.error('Error: Redis did not become ready in time')
    process.exit(1)
  }

  console.log('Redis is ready.\n')

  console.log('Seeding database with sample data...')
  const seedContent = await readFile(SEED_FILE, 'utf-8')

  // Execute each Redis command individually (supports # comments)
  const commands = seedContent
    .trim()
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))

  for (const command of commands) {
    const args = parseQuotedCommand(command)
    const result = runContainerCommand(containerName, args)

    if (result.status !== 0) {
      console.error(`Error executing: ${command}`)
      console.error(result.stderr)
      process.exit(1)
    }
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  const verifyResult = runContainerCommand(containerName, ['GET', 'user:count'])

  if (verifyResult.status === 0) {
    const count = verifyResult.stdout.trim().replace(/"/g, '')
    if (count) {
      console.log(`Verified: ${count} users stored`)
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
