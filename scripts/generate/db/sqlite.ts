#!/usr/bin/env tsx
/**
 * Generate a SQLite database with sample data.
 *
 * Usage:
 *   pnpm generate:db sqlite [container-name]
 *
 * Note: SQLite is file-based, so --port is not applicable.
 */

import { existsSync, mkdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import {
  parseArgs,
  runSpindb,
  getSeedFile,
  runContainerCommand,
} from './_shared.js'
import { join } from 'path'

function getDemoDir(): string {
  const dir = join(homedir(), '.spindb', 'demo')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

const ENGINE = 'sqlite'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`
const SEED_FILE = getSeedFile(ENGINE, 'sample-db.sql')

async function getFileBasedConfig(
  name: string,
): Promise<{ name: string; database: string } | null> {
  // Use os.homedir() for cross-platform compatibility, bail out if unavailable
  const homeDir = homedir()
  if (!homeDir) {
    return null
  }

  const configPath = join(homeDir, '.spindb', 'config.json')

  if (!existsSync(configPath)) {
    return null
  }

  try {
    const content = await readFile(configPath, 'utf-8')
    const config = JSON.parse(content) as {
      sqlite?: Record<string, { path: string }>
    }
    const entry = config.sqlite?.[name]
    if (entry) {
      return { name, database: entry.path }
    }
    return null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const { containerName } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('SQLite Database Generator')
  console.log('=========================\n')

  if (!existsSync(SEED_FILE)) {
    console.error(`Error: Seed file not found: ${SEED_FILE}`)
    process.exit(1)
  }

  console.log(`Checking for container "${containerName}"...`)
  let config = await getFileBasedConfig(containerName)

  if (!config) {
    console.log(`Container not found. Creating "${containerName}"...`)

    // Create in ~/.spindb/demo/ to avoid polluting CWD
    const dbPath = join(getDemoDir(), `${containerName}.sqlite`)
    const createResult = runSpindb([
      'create',
      containerName,
      '--engine',
      ENGINE,
      '--path',
      dbPath,
    ])

    if (!createResult.success) {
      console.error('Error creating container:')
      console.error(createResult.output)
      process.exit(1)
    }

    console.log('Container created successfully.')
    config = await getFileBasedConfig(containerName)

    if (!config) {
      // SQLite might not register in config, use the expected path
      config = { name: containerName, database: dbPath }
    }
  } else {
    console.log(`Found existing container: ${config.database}`)
  }

  console.log(`Database file: ${config.database}\n`)

  console.log('Seeding database with sample data...')
  const seedContent = await readFile(SEED_FILE, 'utf-8')

  const seedResult = runContainerCommand(containerName, ['-cmd', seedContent])

  if (seedResult.status !== 0) {
    console.error('Error seeding database:')
    console.error(seedResult.stderr)
    process.exit(1)
  }

  console.log('Database seeded successfully!\n')

  console.log('Verifying data...')
  const verifyResult = runContainerCommand(containerName, [
    '-cmd',
    'SELECT COUNT(*) FROM test_user;',
  ])

  if (verifyResult.status === 0) {
    const match = verifyResult.stdout.match(/(\d+)/)
    if (match) {
      console.log(`Verified: ${match[1]} users in test_user table`)
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
