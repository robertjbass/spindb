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
] as const
type SupportedEngine = (typeof SUPPORTED_ENGINES)[number]

// Map aliases to canonical engine names
const ENGINE_ALIASES: Record<string, SupportedEngine> = {
  // PostgreSQL
  postgresql: 'postgresql',
  postgres: 'postgresql',
  pg: 'postgresql',
  // MySQL
  mysql: 'mysql',
  // MariaDB
  mariadb: 'mariadb',
  maria: 'mariadb',
  // MongoDB
  mongodb: 'mongodb',
  mongo: 'mongodb',
  // FerretDB
  ferretdb: 'ferretdb',
  ferret: 'ferretdb',
  // Redis
  redis: 'redis',
  // Valkey
  valkey: 'valkey',
  // ClickHouse
  clickhouse: 'clickhouse',
  ch: 'clickhouse',
  // SQLite
  sqlite: 'sqlite',
  lite: 'sqlite',
  // DuckDB
  duckdb: 'duckdb',
  duck: 'duckdb',
  // Qdrant
  qdrant: 'qdrant',
  qd: 'qdrant',
  // Meilisearch
  meilisearch: 'meilisearch',
  meili: 'meilisearch',
  ms: 'meilisearch',
  // CouchDB
  couchdb: 'couchdb',
  couch: 'couchdb',
  // CockroachDB
  cockroachdb: 'cockroachdb',
  crdb: 'cockroachdb',
  cockroach: 'cockroachdb',
  // SurrealDB
  surrealdb: 'surrealdb',
  surreal: 'surrealdb',
  // QuestDB
  questdb: 'questdb',
  quest: 'questdb',
}

function resolveEngine(input: string): SupportedEngine | null {
  return ENGINE_ALIASES[input.toLowerCase()] ?? null
}

function printUsage(): void {
  console.log(
    'Usage: pnpm generate:db <engine> [container-name] [--port <port>]',
  )
  console.log('')
  console.log('Supported engines (with aliases):')
  console.log('  - postgresql (postgres, pg)')
  console.log('  - mysql')
  console.log('  - mariadb (maria)')
  console.log('  - mongodb (mongo)')
  console.log('  - ferretdb (ferret)')
  console.log('  - redis')
  console.log('  - valkey')
  console.log('  - clickhouse (ch)')
  console.log('  - sqlite (lite)')
  console.log('  - duckdb (duck)')
  console.log('  - qdrant (qd)')
  console.log('  - meilisearch (meili, ms)')
  console.log('  - couchdb (couch)')
  console.log('  - cockroachdb (crdb, cockroach)')
  console.log('  - surrealdb (surreal)')
  console.log('  - questdb (quest)')
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

  child.on('close', (code) => {
    process.exit(code ?? 0)
  })

  child.on('error', (error) => {
    console.error(`Error running script: ${error.message}`)
    process.exit(1)
  })
}

main()
