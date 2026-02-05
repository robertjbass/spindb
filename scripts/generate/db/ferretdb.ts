#!/usr/bin/env tsx
/**
 * Generate a FerretDB database with sample data.
 *
 * Usage:
 *   pnpm generate:db ferretdb [container-name] [--port <port>]
 */

import { existsSync } from 'fs'
import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  getSeedFile,
  PROJECT_ROOT,
} from './_shared.js'
import { spawnSync } from 'child_process'

const ENGINE = 'ferretdb'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const SEED_FILE = getSeedFile(ENGINE, 'sample-db.js')

async function waitForFerretReady(
  containerName: string,
  maxAttempts = 30,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = spawnSync(
      'pnpm',
      [
        'start',
        'run',
        containerName,
        '--',
        '--eval',
        'db.adminCommand("ping")',
      ],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )

    if (result.status === 0) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return false
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('FerretDB Database Generator')
  console.log('===========================\n')

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

  console.log('Waiting for FerretDB to be ready...')
  const isReady = await waitForFerretReady(containerName)

  if (!isReady) {
    console.error('Error: FerretDB did not become ready in time')
    process.exit(1)
  }

  console.log('FerretDB is ready.\n')

  console.log('Seeding database with sample data...')

  // FerretDB uses mongosh with --file to run JS seed scripts
  const seedResult = spawnSync(
    'pnpm',
    ['start', 'run', containerName, '--', '--file', SEED_FILE],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  if (seedResult.status !== 0) {
    console.error('Error seeding database:')
    console.error(seedResult.stderr)
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  const verifyResult = spawnSync(
    'pnpm',
    [
      'start',
      'run',
      containerName,
      '--',
      '--eval',
      'db.getSiblingDB("testdb").test_user.countDocuments()',
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )

  if (verifyResult.status === 0) {
    const match = verifyResult.stdout.match(/(\d+)/)
    if (match) {
      console.log(`Verified: ${match[1]} users in test_user collection`)
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
