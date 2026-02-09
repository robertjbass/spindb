#!/usr/bin/env tsx
/**
 * Generate a TypeDB database with sample data.
 *
 * Usage:
 *   pnpm generate:db typedb [container-name] [--port <port>]
 */

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
  waitForHttpReady,
  getSeedFile,
  runContainerCommand,
} from './_shared.js'

const ENGINE = 'typedb'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const SEED_FILE = getSeedFile(ENGINE, 'sample-db.tqls')
const DEFAULT_TYPEDB_HTTP_PORT = 8000

async function resolveHttpPort(
  containerName: string,
  fallback: number,
): Promise<number> {
  const homeDir = process.env.HOME || process.env.USERPROFILE
  if (!homeDir) {
    return fallback
  }

  const configPath = join(
    homeDir,
    '.spindb',
    'containers',
    ENGINE,
    containerName,
    'config.yml',
  )

  try {
    const content = await readFile(configPath, 'utf-8')
    const addressMatch = content.match(
      /^\s*http:\s*$[\s\S]*?^\s*address:\s*[^:\n]+:(\d+)/m,
    )
    if (addressMatch) {
      return parseInt(addressMatch[1], 10)
    }
    const portMatch = content.match(/^\s*http:\s*$[\s\S]*?^\s*port:\s*(\d+)/m)
    if (portMatch) {
      return parseInt(portMatch[1], 10)
    }
  } catch {
    return fallback
  }

  return fallback
}

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('TypeDB Database Generator')
  console.log('=========================\n')

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

  const httpPort = await resolveHttpPort(
    containerName,
    DEFAULT_TYPEDB_HTTP_PORT,
  )
  console.log(`Waiting for TypeDB to be ready (HTTP port ${httpPort})...`)
  const isReady = await waitForHttpReady(httpPort, '/health')

  if (!isReady) {
    console.error('Error: TypeDB did not become ready in time')
    process.exit(1)
  }

  console.log('TypeDB is ready.\n')

  console.log('Seeding database with sample data...')

  // TypeDB uses --script for .tqls files which contain transaction commands
  const seedResult = runContainerCommand(containerName, ['--script', SEED_FILE])

  if (seedResult.status !== 0) {
    console.error('Error seeding database:')
    console.error(seedResult.stderr)
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  const verifyResult = runContainerCommand(containerName, [
    '-c',
    'match $u isa test_user; reduce $c = count;',
  ])

  if (verifyResult.status === 0) {
    // Match a standalone count number from TypeDB reduce output (e.g., "{ $c = 5; }")
    const match =
      verifyResult.stdout.match(/\$c\s*=\s*(\d+)/) ||
      verifyResult.stdout.match(/count[:\s]+(\d+)/i) ||
      verifyResult.stdout.match(/^\s*(\d+)\s*$/m)
    if (match) {
      console.log(`Verified: ${match[1]} users in test_user entity type`)
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
