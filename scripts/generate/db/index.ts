#!/usr/bin/env tsx
/**
 * Dispatcher for database generation scripts.
 *
 * Usage:
 *   pnpm generate:db <engine> [container-name] [--port <port>]
 *
 * Examples:
 *   pnpm generate:db postgresql           # Create demo-postgresql with seed data
 *   pnpm generate:db pg mydb              # Seed existing container "mydb"
 *   pnpm generate:db postgres --port 5555 # Create on specific port
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Single source of truth for engine names and aliases
const ENGINE_DEFS = [
  { engine: 'postgresql', aliases: ['postgres', 'pg'] },
  { engine: 'mysql', aliases: [] },
  { engine: 'mariadb', aliases: ['maria'] },
  { engine: 'mongodb', aliases: ['mongo'] },
  { engine: 'ferretdb', aliases: ['ferret'] },
  { engine: 'redis', aliases: [] },
  { engine: 'valkey', aliases: [] },
  { engine: 'clickhouse', aliases: ['ch'] },
  { engine: 'sqlite', aliases: ['lite'] },
  { engine: 'duckdb', aliases: ['duck'] },
  { engine: 'qdrant', aliases: ['qd'] },
  { engine: 'meilisearch', aliases: ['meili', 'ms'] },
  { engine: 'couchdb', aliases: ['couch'] },
  { engine: 'cockroachdb', aliases: ['crdb', 'cockroach'] },
  { engine: 'surrealdb', aliases: ['surreal'] },
  { engine: 'questdb', aliases: ['quest'] },
  { engine: 'typedb', aliases: ['tdb'] },
  { engine: 'influxdb', aliases: ['influx'] },
] as const

type SupportedEngine = (typeof ENGINE_DEFS)[number]['engine']

// Derive alias map from ENGINE_DEFS
const ENGINE_ALIASES: Record<string, SupportedEngine> = Object.fromEntries(
  ENGINE_DEFS.flatMap(({ engine, aliases }) => [
    [engine, engine],
    ...aliases.map((alias) => [alias, engine]),
  ]),
) as Record<string, SupportedEngine>

function resolveEngine(input: string): SupportedEngine | null {
  return ENGINE_ALIASES[input.toLowerCase()] ?? null
}

function printUsage(): void {
  console.log(
    'Usage: pnpm generate:db <engine> [container-name] [--port <port>]',
  )
  console.log('')
  console.log('Supported engines (with aliases):')
  for (const { engine, aliases } of ENGINE_DEFS) {
    const aliasText = aliases.length > 0 ? ` (${aliases.join(', ')})` : ''
    console.log(`  - ${engine}${aliasText}`)
  }
  console.log('')
  console.log('Options:')
  console.log('  --port <port>  Specify port for new containers')
  console.log('')
  console.log('Examples:')
  console.log(
    '  pnpm generate:db postgresql           # Create demo-postgresql',
  )
  console.log('  pnpm generate:db pg mydb              # Seed existing "mydb"')
  console.log(
    '  pnpm generate:db postgres --port 5555 # Create on specific port',
  )
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage()
    process.exit(args.length === 0 ? 1 : 0)
  }

  const engineInput = args[0]
  const engine = resolveEngine(engineInput)
  const engineArgs = args.slice(1)

  if (!engine) {
    console.error(`Error: Unknown engine "${engineInput}"`)
    console.error('')
    printUsage()
    process.exit(1)
  }

  const scriptPath = join(__dirname, `${engine}.ts`)

  if (!existsSync(scriptPath)) {
    console.error(`Error: Script not found: ${scriptPath}`)
    console.error(
      `\nThe generator for "${engine}" has not been implemented yet.`,
    )
    process.exit(1)
  }

  // Run the engine-specific script with tsx
  const child = spawn('tsx', [scriptPath, ...engineArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('close', (code) => resolve(code ?? 0))
    child.on('error', reject)
  })

  process.exit(exitCode)
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Error running script: ${message}`)
  process.exit(1)
})
