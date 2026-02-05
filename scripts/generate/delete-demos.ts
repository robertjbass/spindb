#!/usr/bin/env tsx
/**
 * Delete all demo containers created by generate:db or generate:missing.
 *
 * This is a dev-only utility for cleaning up demo containers.
 *
 * Usage:
 *   pnpm delete:demos           # Delete all demo-* containers
 *   pnpm delete:demos --dry-run # Show what would be deleted
 *   pnpm delete:demos --help    # Show help
 */

import {
  runSpindb,
  runSpindbStreaming,
  type ContainerConfig,
} from './db/_shared.js'

type ParsedArgs = {
  dryRun: boolean
  help: boolean
}

function printUsage(): void {
  console.log('Usage: pnpm delete:demos [options]')
  console.log('')
  console.log(
    'Delete all demo containers (demo-*) created by generate scripts.',
  )
  console.log('')
  console.log('Options:')
  console.log('  --dry-run   Show what would be deleted without deleting')
  console.log('  --help, -h  Show this help message')
  console.log('')
  console.log('Examples:')
  console.log('  pnpm delete:demos           # Delete all demo-* containers')
  console.log('  pnpm delete:demos --dry-run # Preview what would be deleted')
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  return {
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
    return []
  }
}

function isDemoContainer(name: string): boolean {
  return name.startsWith('demo-')
}

async function main(): Promise<void> {
  const { dryRun, help } = parseArgs()

  if (help) {
    printUsage()
    return
  }

  console.log('Delete Demo Containers')
  console.log('======================\n')

  if (dryRun) {
    console.log('DRY RUN MODE - no containers will be deleted\n')
  }

  console.log('Finding demo containers...')
  const containers = getExistingContainers()
  const demoContainers = containers.filter((c) => isDemoContainer(c.name))

  if (demoContainers.length === 0) {
    console.log('No demo containers found (demo-*).')
    return
  }

  console.log(`Found ${demoContainers.length} demo container(s):\n`)
  for (const container of demoContainers) {
    const status = container.status === 'running' ? '● running' : '○ stopped'
    console.log(`  - ${container.name} (${container.engine}) [${status}]`)
  }
  console.log()

  const deleted: string[] = []
  const failed: { name: string; error: string }[] = []

  for (const container of demoContainers) {
    const { name, status } = container

    if (dryRun) {
      if (status === 'running') {
        console.log(`[dry-run] Would stop: ${name}`)
      }
      console.log(`[dry-run] Would delete: ${name}\n`)
      deleted.push(name)
      continue
    }

    // Stop if running
    if (status === 'running') {
      console.log(`Stopping ${name}...`)
      const stopCode = await runSpindbStreaming(['stop', name])
      if (stopCode !== 0) {
        console.log(
          `  Warning: Failed to stop ${name}, attempting delete anyway\n`,
        )
      }
    }

    // Delete with force flag
    console.log(`Deleting ${name}...`)
    const result = runSpindb(['delete', name, '--force'])

    if (result.success) {
      console.log(`  Deleted successfully\n`)
      deleted.push(name)
    } else {
      const errorLine =
        result.output
          .split('\n')
          .find((line) => line.toLowerCase().includes('error')) ||
        'Unknown error'
      console.log(`  Failed: ${errorLine}\n`)
      failed.push({ name, error: errorLine })
    }
  }

  // Summary
  console.log('Summary')
  console.log('-------')
  console.log(`Deleted: ${deleted.length}`)
  if (deleted.length > 0) {
    for (const name of deleted) {
      console.log(`  - ${name}`)
    }
  }

  if (failed.length > 0) {
    console.log(`\nFailed: ${failed.length}`)
    for (const { name, error } of failed) {
      console.log(`  - ${name}: ${error}`)
    }
  }
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
