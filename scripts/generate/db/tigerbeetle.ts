#!/usr/bin/env tsx
/**
 * Generate a TigerBeetle database container.
 *
 * TigerBeetle uses a custom binary protocol and has no SQL/REST API,
 * so this script only creates and starts the container. Data seeding
 * must be done via the TigerBeetle REPL or client libraries.
 *
 * Usage:
 *   pnpm generate:db tigerbeetle [container-name] [--port <port>]
 */

import {
  parseArgs,
  runSpindb,
  runSpindbStreaming,
  getContainerConfig,
} from './_shared.js'

const ENGINE = 'tigerbeetle'
const DEFAULT_CONTAINER_NAME = `demo-${ENGINE}`

async function main(): Promise<void> {
  const { containerName, port } = parseArgs(DEFAULT_CONTAINER_NAME)

  console.log('TigerBeetle Database Generator')
  console.log('==============================\n')

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

  console.log('Done!')
  console.log(`\nContainer "${containerName}" is ready.`)
  console.log('\nTigerBeetle uses a custom binary protocol.')
  console.log('To interact with it, use the REPL:')
  console.log(`  pnpm start connect ${containerName}`)
}

main().catch((error) => {
  console.error('Error:', error)
  process.exit(1)
})
