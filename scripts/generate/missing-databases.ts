#!/usr/bin/env tsx
/**
 * Create demo containers for database engines that don't have any containers yet.
 *
 * This is a dev-only utility for quickly creating one container of each engine
 * type for testing purposes.
 *
 * Usage:
 *   pnpm generate:missing           # Create missing demo containers
 *   pnpm generate:missing --all     # Create demo containers for ALL engines
 *   pnpm generate:missing --dry-run # Show what would be created
 *
 * Containers are created but NOT started or seeded. Use `pnpm generate:db <engine>`
 * to seed individual containers with sample data.
 */

import { runSpindb, type ContainerConfig } from './db/_shared.js'

// TODO - source from hostdb if possible
const SUPPORTED_ENGINES = [
  'postgresql',
  'mysql',
  'mariadb',
  'mongodb',
  'ferretdb',
  'redis',
  'valkey',
  'clickhouse',
  'sqlite',
  'duckdb',
  'qdrant',
  'meilisearch',
  'couchdb',
  'cockroachdb',
  'surrealdb',
  'questdb',
  'typedb',
] as const

type SupportedEngine = (typeof SUPPORTED_ENGINES)[number]

type ParsedArgs = {
  all: boolean
  dryRun: boolean
  help: boolean
}

function printUsage(): void {
  console.log('Usage: pnpm generate:missing [options]')
  console.log('')
  console.log(
    'Create demo containers for database engines that do not have any containers yet.',
  )
  console.log('')
  console.log('Options:')
  console.log('  --all       Create demo containers for ALL engines,')
  console.log('              even if containers already exist')
  console.log('  --dry-run   Show what would be created without creating')
  console.log('  --help, -h  Show this help message')
  console.log('')
  console.log('Examples:')
  console.log(
    '  pnpm generate:missing           # Create missing demo containers',
  )
  console.log('  pnpm generate:missing --all     # Create one for each engine')
  console.log(
    '  pnpm generate:missing --dry-run # Preview what would be created',
  )
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  return {
    all: args.includes('--all'),
    dryRun: args.includes('--dry-run'),
    help: args.includes('--help') || args.includes('-h'),
  }
}

function getExistingContainers(): ContainerConfig[] {
  const result = runSpindb(['list', '--json', '--no-scan'])

  if (!result.success) {
    console.error('Error listing containers')
    process.exit(1)
  }

  try {
    return JSON.parse(result.output) as ContainerConfig[]
  } catch {
    // No containers (empty output) or JSON parse error
    if (result.output.trim()) {
      console.warn('Warning: Could not parse container list output')
    }
    return []
  }
}

function getEnginesWithContainers(
  containers: ContainerConfig[],
): Set<SupportedEngine> {
  const engines = new Set<SupportedEngine>()
  for (const container of containers) {
    if (SUPPORTED_ENGINES.includes(container.engine as SupportedEngine)) {
      engines.add(container.engine as SupportedEngine)
    }
  }
  return engines
}

function getNextAvailableName(
  baseName: string,
  existingNames: Set<string>,
): string {
  if (!existingNames.has(baseName)) {
    return baseName
  }

  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`)) {
    suffix++
  }
  return `${baseName}-${suffix}`
}

async function main(): Promise<void> {
  const { all, dryRun, help } = parseArgs()

  if (help) {
    printUsage()
    return
  }

  console.log('Missing Databases Generator')
  console.log('===========================\n')

  if (dryRun) {
    console.log('DRY RUN MODE - no containers will be created\n')
  }

  console.log('Checking existing containers...')
  const containers = getExistingContainers()
  const existingEngines = getEnginesWithContainers(containers)
  const existingNames = new Set(containers.map((c) => c.name))

  console.log(`Found ${containers.length} existing container(s)`)
  if (existingEngines.size > 0) {
    console.log(
      `Engines with containers: ${Array.from(existingEngines).join(', ')}`,
    )
  }
  console.log()

  // Determine which engines to create
  const enginesToCreate: SupportedEngine[] = all
    ? [...SUPPORTED_ENGINES]
    : SUPPORTED_ENGINES.filter((engine) => !existingEngines.has(engine))

  if (enginesToCreate.length === 0) {
    console.log('All engines already have containers. Nothing to create.')
    console.log('Use --all flag to create additional demo containers.')
    return
  }

  console.log(
    `Will create ${enginesToCreate.length} container(s): ${enginesToCreate.join(', ')}\n`,
  )

  const created: string[] = []
  const failed: { engine: string; error: string }[] = []

  for (const engine of enginesToCreate) {
    const baseName = `demo-${engine}`
    const containerName = getNextAvailableName(baseName, existingNames)

    console.log(`Creating ${containerName}...`)

    if (dryRun) {
      console.log(`  [dry-run] Would create: ${containerName}\n`)
      created.push(containerName)
      existingNames.add(containerName)
      continue
    }

    const result = runSpindb(['create', containerName, '--engine', engine])

    if (result.success) {
      console.log(`  Created successfully\n`)
      created.push(containerName)
      existingNames.add(containerName)
    } else {
      const errorLine =
        result.output
          .split('\n')
          .find((line) => line.toLowerCase().includes('error')) ||
        'Unknown error'
      console.log(`  Failed: ${errorLine}\n`)
      failed.push({ engine, error: errorLine })
    }
  }

  // Summary
  console.log('Summary')
  console.log('-------')
  console.log(`Created: ${created.length}`)
  if (created.length > 0) {
    for (const name of created) {
      console.log(`  - ${name}`)
    }
  }

  if (failed.length > 0) {
    console.log(`\nFailed: ${failed.length}`)
    for (const { engine, error } of failed) {
      console.log(`  - ${engine}: ${error}`)
    }
  }

  console.log('\nContainers are created but NOT started.')
  console.log('To start: spindb start <name>')
  console.log('To seed with demo data: pnpm generate:db <engine> <name>')
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
