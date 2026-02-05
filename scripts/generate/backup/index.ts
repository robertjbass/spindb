#!/usr/bin/env tsx
/**
 * Dispatcher for backup generation scripts.
 *
 * Usage:
 *   pnpm generate:backup <engine> [args...]
 *
 * Examples:
 *   pnpm generate:backup qdrant              # Generate Qdrant snapshot fixture
 *   pnpm generate:backup qdrant my-snapshot  # With custom name
 */

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SUPPORTED_ENGINES = ['qdrant'] as const
type SupportedEngine = (typeof SUPPORTED_ENGINES)[number]

function printUsage(): void {
  console.log('Usage: pnpm generate:backup <engine> [args...]')
  console.log('')
  console.log('Supported engines:')
  for (const engine of SUPPORTED_ENGINES) {
    console.log(`  - ${engine}`)
  }
  console.log('')
  console.log('Examples:')
  console.log('  pnpm generate:backup qdrant')
  console.log('  pnpm generate:backup qdrant my-snapshot')
}

function isSupported(engine: string): engine is SupportedEngine {
  return SUPPORTED_ENGINES.includes(engine as SupportedEngine)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage()
    process.exit(args.length === 0 ? 1 : 0)
  }

  const engine = args[0].toLowerCase()
  const engineArgs = args.slice(1)

  if (!isSupported(engine)) {
    console.error(`Error: Unknown engine "${engine}"`)
    console.error('')
    printUsage()
    process.exit(1)
  }

  const scriptPath = join(__dirname, `${engine}.ts`)

  if (!existsSync(scriptPath)) {
    console.error(`Error: Script not found: ${scriptPath}`)
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
