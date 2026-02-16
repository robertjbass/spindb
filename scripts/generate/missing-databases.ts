#!/usr/bin/env tsx
/**
 * Create demo containers for database engines that don't have any containers yet.
 *
 * This is a dev-only utility for quickly creating one container of each engine
 * type for testing purposes.
 *
 * Usage:
 *   pnpm generate:missing                # Create missing demo containers
 *   pnpm generate:missing --all          # Create demo containers for ALL engines
 *   pnpm generate:missing --seed         # Create and seed with demo data
 *   pnpm generate:missing --all --seed   # Create all and seed with demo data
 *   pnpm generate:missing --dry-run      # Show what would be created
 *
 * Without --seed, containers are created but NOT started or seeded.
 * With --seed, each container is created, started, and seeded via `generate:db`.
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { runSpindb, PROJECT_ROOT, type ContainerConfig } from './db/_shared.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  'influxdb',
  'weaviate',
  'tigerbeetle',
] as const

type SupportedEngine = (typeof SUPPORTED_ENGINES)[number]

/**
 * Engines that need multiple demo containers with different versions.
 * Each entry generates a separate container with the specified version and name suffix.
 * The first entry (no suffix) is the "default" version.
 */
const VERSION_OVERRIDES: Record<
  string,
  Array<{ version: string; suffix: string }>
> = {
  ferretdb: [
    { version: '2', suffix: '' }, // demo-ferretdb (v2)
    { version: '1', suffix: '-v1' }, // demo-ferretdb-v1 (v1)
  ],
}

const FILE_BASED_ENGINES: ReadonlySet<string> = new Set(['sqlite', 'duckdb'])

const FILE_BASED_EXTENSIONS: Record<string, string> = {
  sqlite: '.sqlite',
  duckdb: '.duckdb',
}

/**
 * Directory for generated file-based databases.
 * Uses ~/.spindb/demo/ to avoid polluting the project CWD.
 */
function getDemoDir(): string {
  const dir = join(homedir(), '.spindb', 'demo')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

type ParsedArgs = {
  all: boolean
  seed: boolean
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
  console.log('  --seed      Start and seed each container with demo data')
  console.log('  --dry-run   Show what would be created without creating')
  console.log('  --help, -h  Show this help message')
  console.log('')
  console.log('Examples:')
  console.log(
    '  pnpm generate:missing           # Create missing demo containers',
  )
  console.log('  pnpm generate:missing --all     # Create one for each engine')
  console.log(
    '  pnpm generate:missing --seed    # Create missing and seed with demo data',
  )
  console.log(
    '  pnpm generate:missing --dry-run # Preview what would be created',
  )
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  return {
    all: args.includes('--all'),
    seed: args.includes('--seed'),
    dryRun: args.includes('--dry-run'),
    help: args.includes('--help') || args.includes('-h'),
  }
}

function hasSeedScript(engine: string): boolean {
  return existsSync(join(__dirname, 'db', `${engine}.ts`))
}

function getCreateArgs(
  engine: string,
  containerName: string,
  version?: string,
): string[] {
  const args = ['create', containerName, '--engine', engine]
  if (version) {
    args.push('--version', version)
  }
  if (FILE_BASED_ENGINES.has(engine)) {
    const ext = FILE_BASED_EXTENSIONS[engine]
    const dbPath = join(getDemoDir(), `${containerName}${ext}`)
    args.push('--path', dbPath)
  }
  return args
}

function runGenerateDb(
  engine: string,
  containerName: string,
  version?: string,
): Promise<number> {
  const scriptPath = join(__dirname, 'db', `${engine}.ts`)

  if (!existsSync(scriptPath)) {
    console.log(`  No seed script for ${engine}, skipping seed`)
    return Promise.resolve(0)
  }

  return new Promise((resolve) => {
    let settled = false
    const args = [scriptPath, containerName]
    if (version) {
      args.push('--version', version)
    }
    const child = spawn('tsx', args, {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        resolve(code ?? 1)
      }
    })
    child.on('error', (err) => {
      console.error(`  Seed script error for ${engine}: ${err.message}`)
      if (!settled) {
        settled = true
        resolve(1)
      }
    })
  })
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
  const { all, seed, dryRun, help } = parseArgs()

  if (help) {
    printUsage()
    return
  }

  console.log('Missing Databases Generator')
  console.log('===========================\n')

  if (dryRun) {
    console.log('DRY RUN MODE - no containers will be created\n')
  }

  if (seed) {
    console.log('SEED MODE - containers will be started and seeded\n')
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
  const seeded: string[] = []
  const failed: { engine: string; error: string }[] = []

  // Build the list of containers to create, expanding VERSION_OVERRIDES
  type CreateTask = {
    engine: SupportedEngine
    containerName: string
    version?: string
  }
  const createTasks: CreateTask[] = []

  for (const engine of enginesToCreate) {
    const overrides = VERSION_OVERRIDES[engine]
    if (overrides) {
      // Engine has multiple version variants — create one container per variant
      for (const { version, suffix } of overrides) {
        const baseName = `demo-${engine}${suffix}`
        const containerName = getNextAvailableName(baseName, existingNames)
        createTasks.push({ engine, containerName, version })
        existingNames.add(containerName)
      }
    } else {
      const baseName = `demo-${engine}`
      const containerName = getNextAvailableName(baseName, existingNames)
      createTasks.push({ engine, containerName })
      existingNames.add(containerName)
    }
  }

  for (const { engine, containerName, version } of createTasks) {
    const versionLabel = version ? ` v${version}` : ''

    if (dryRun) {
      const action = seed ? 'create and seed' : 'create'
      console.log(
        `  [dry-run] Would ${action}: ${containerName}${versionLabel}`,
      )
      created.push(containerName)
      continue
    }

    if (seed && hasSeedScript(engine)) {
      // Use generate:db which handles create + start + seed
      console.log(
        `\nCreating and seeding ${containerName} (${engine}${versionLabel})...`,
      )
      console.log('─'.repeat(50))
      const exitCode = await runGenerateDb(engine, containerName, version)

      if (exitCode === 0) {
        created.push(containerName)
        seeded.push(containerName)
      } else {
        failed.push({ engine, error: 'generate:db failed' })
      }
    } else if (seed && !hasSeedScript(engine)) {
      // No seed script — fall back to create-only
      console.log(
        `Creating ${containerName} (no seed script for ${engine}${versionLabel})...`,
      )
      const result = runSpindb(getCreateArgs(engine, containerName, version))

      if (result.success) {
        console.log(`  Created successfully (no seed available)\n`)
        created.push(containerName)
      } else {
        const errorLine =
          result.output
            .split('\n')
            .find((line) => line.toLowerCase().includes('error')) ||
          'Unknown error'
        console.log(`  Failed: ${errorLine}\n`)
        failed.push({ engine, error: errorLine })
      }
    } else {
      console.log(`Creating ${containerName}${versionLabel}...`)
      const result = runSpindb(getCreateArgs(engine, containerName, version))

      if (result.success) {
        console.log(`  Created successfully\n`)
        created.push(containerName)
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
  }

  // Summary
  console.log('\n\nSummary')
  console.log('-------')
  console.log(`Created: ${created.length}`)
  if (created.length > 0) {
    for (const name of created) {
      console.log(`  - ${name}`)
    }
  }

  if (seeded.length > 0) {
    console.log(`Seeded: ${seeded.length}`)
    for (const name of seeded) {
      console.log(`  - ${name}`)
    }
  }

  if (failed.length > 0) {
    console.log(`\nFailed: ${failed.length}`)
    for (const { engine, error } of failed) {
      console.log(`  - ${engine}: ${error}`)
    }
  }

  if (!seed) {
    console.log('\nContainers are created but NOT started.')
    console.log('To start: spindb start <name>')
    console.log('To seed with demo data: pnpm generate:db <engine> <name>')
  }
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
