#!/usr/bin/env tsx
/**
 * Integration test runner script
 *
 * Usage:
 *   pnpm test:engine              # Run all integration tests
 *   pnpm test:engine postgres     # Run PostgreSQL tests
 *   pnpm test:engine pg           # Run PostgreSQL tests (alias)
 *   pnpm test:engine mongo        # Run MongoDB tests (alias)
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

// Engine name to test file mapping (canonical names)
const ENGINE_TEST_FILES: Record<string, string> = {
  postgresql: 'postgresql.test.ts',
  mysql: 'mysql.test.ts',
  mariadb: 'mariadb.test.ts',
  sqlite: 'sqlite.test.ts',
  duckdb: 'duckdb.test.ts',
  mongodb: 'mongodb.test.ts',
  ferretdb: 'ferretdb.test.ts',
  redis: 'redis.test.ts',
  valkey: 'valkey.test.ts',
  clickhouse: 'clickhouse.test.ts',
  qdrant: 'qdrant.test.ts',
  meilisearch: 'meilisearch.test.ts',
  couchdb: 'couchdb.test.ts',
}

// Aliases for engine names (maps alias -> canonical name)
const ENGINE_ALIASES: Record<string, string> = {
  // PostgreSQL aliases
  postgres: 'postgresql',
  pg: 'postgresql',
  // MongoDB aliases
  mongo: 'mongodb',
  // FerretDB aliases
  ferret: 'ferretdb',
  fdb: 'ferretdb',
  // SQLite aliases
  lite: 'sqlite',
  // DuckDB aliases
  duck: 'duckdb',
  // Qdrant aliases
  qd: 'qdrant',
  // Meilisearch aliases
  meili: 'meilisearch',
  ms: 'meilisearch',
  // CouchDB aliases
  couch: 'couchdb',
}

// Test run order (matches test:integration script order)
const TEST_ORDER = [
  'postgresql',
  'mysql',
  'mariadb',
  'sqlite',
  'duckdb',
  'mongodb',
  'ferretdb',
  'redis',
  'valkey',
  'clickhouse',
  'qdrant',
  'meilisearch',
  'couchdb',
]

function resolveEngine(input: string): string | null {
  const normalized = input.toLowerCase().trim()

  // Check if it's a canonical name
  if (ENGINE_TEST_FILES[normalized]) {
    return normalized
  }

  // Check if it's an alias
  if (ENGINE_ALIASES[normalized]) {
    return ENGINE_ALIASES[normalized]
  }

  return null
}

function printUsage(): void {
  console.log('Usage: pnpm test:engine [engine]')
  console.log('')
  console.log('Run integration tests for database engines.')
  console.log('')
  console.log('Arguments:')
  console.log('  engine    Engine name or alias (optional, runs all if omitted)')
  console.log('')
  console.log('Available engines:')
  console.log('  postgresql    (aliases: postgres, pg)')
  console.log('  mysql')
  console.log('  mariadb')
  console.log('  sqlite        (aliases: lite)')
  console.log('  duckdb        (aliases: duck)')
  console.log('  mongodb       (aliases: mongo)')
  console.log('  ferretdb      (aliases: ferret, fdb)')
  console.log('  redis')
  console.log('  valkey')
  console.log('  clickhouse')
  console.log('  qdrant        (aliases: qd)')
  console.log('  meilisearch   (aliases: meili, ms)')
  console.log('  couchdb       (aliases: couch)')
  console.log('')
  console.log('Examples:')
  console.log('  pnpm test:engine              # Run all integration tests')
  console.log('  pnpm test:engine postgres     # Run PostgreSQL tests')
  console.log('  pnpm test:engine pg           # Run PostgreSQL tests (alias)')
  console.log('  pnpm test:engine mongo        # Run MongoDB tests')
}

async function runTest(testFile: string): Promise<number> {
  const testPath = join(process.cwd(), 'tests', 'integration', testFile)

  if (!existsSync(testPath)) {
    console.error(`Test file not found: ${testPath}`)
    return 1
  }

  return new Promise((resolve) => {
    const proc = spawn(
      'node',
      [
        '--import',
        'tsx',
        '--test',
        '--experimental-test-isolation=none',
        testPath,
      ],
      {
        stdio: 'inherit',
        cwd: process.cwd(),
      },
    )

    proc.on('close', (code) => {
      resolve(code ?? 1)
    })

    proc.on('error', (err) => {
      console.error(`Failed to run test: ${err.message}`)
      resolve(1)
    })
  })
}

async function runAllTests(): Promise<number> {
  let hasFailure = false

  for (const engine of TEST_ORDER) {
    const testFile = ENGINE_TEST_FILES[engine]
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Running ${engine} integration tests...`)
    console.log(`${'='.repeat(60)}\n`)

    const exitCode = await runTest(testFile)
    if (exitCode !== 0) {
      hasFailure = true
      console.error(`\n${engine} tests failed with exit code ${exitCode}`)
      // Continue to next test instead of stopping (matches run-s behavior)
    }
  }

  return hasFailure ? 1 : 0
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // Handle help flag
  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  // No argument - run all tests
  if (args.length === 0) {
    const exitCode = await runAllTests()
    process.exit(exitCode)
  }

  // Single engine argument
  const engineInput = args[0]
  const engine = resolveEngine(engineInput)

  if (!engine) {
    console.error(`Error: Unknown engine "${engineInput}"`)
    console.error('')
    console.error('Valid engines: ' + Object.keys(ENGINE_TEST_FILES).join(', '))
    console.error(
      'Valid aliases: ' +
        Object.entries(ENGINE_ALIASES)
          .map(([alias, canonical]) => `${alias} -> ${canonical}`)
          .join(', '),
    )
    process.exit(1)
  }

  const testFile = ENGINE_TEST_FILES[engine]
  console.log(`Running ${engine} integration tests...\n`)

  const exitCode = await runTest(testFile)
  process.exit(exitCode)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
