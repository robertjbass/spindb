import { Command } from 'commander'
import chalk from 'chalk'
import { existsSync } from 'fs'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getPgwebStatus } from '../../core/pgweb-utils'
import { uiError, uiInfo } from '../ui/theme'
import { getEngineIcon } from '../constants'
import { Engine, type ContainerConfig } from '../../types'
import { loadEnginesJson } from '../../config/engines-registry'

function getSecondaryPorts(
  config: ContainerConfig,
): Array<{ port: number; label: string }> {
  const ports: Array<{ port: number; label: string }> = []
  switch (config.engine) {
    case 'cockroachdb':
      ports.push({ port: config.port + 1, label: 'HTTP UI' })
      break
    case 'clickhouse':
      ports.push({ port: config.port + 1, label: 'HTTP' })
      break
    case 'qdrant':
      ports.push({ port: config.port + 1, label: 'gRPC' })
      break
    case 'typedb':
      ports.push({ port: config.port + 6271, label: 'HTTP' })
      break
    case 'questdb':
      ports.push({ port: config.port + 188, label: 'HTTP Console' })
      ports.push({ port: config.port + 197, label: 'ILP' })
      break
    case 'ferretdb':
      if (config.backendPort) {
        ports.push({ port: config.backendPort, label: 'PostgreSQL backend' })
      }
      break
  }
  return ports
}

export type PortEntry = { port: number; label: string }

export async function getContainerPorts(config: ContainerConfig): Promise<{
  status: 'running' | 'stopped' | 'available' | 'missing'
  ports: PortEntry[]
}> {
  const isFileBasedDB =
    config.engine === Engine.SQLite || config.engine === Engine.DuckDB

  if (isFileBasedDB) {
    const fileExists = existsSync(config.database)
    return {
      status: fileExists ? 'available' : 'missing',
      ports: [],
    }
  }

  const isRunning = await processManager.isRunning(config.name, {
    engine: config.engine,
  })

  const enginesJson = await loadEnginesJson()
  const engineConfig = enginesJson.engines[config.engine]
  const displayName = engineConfig?.displayName || config.engine

  const ports: PortEntry[] = [{ port: config.port, label: displayName }]

  // Add secondary ports
  ports.push(...getSecondaryPorts(config))

  // Check for pgweb (PG-wire-protocol engines only)
  if (
    config.engine === 'postgresql' ||
    config.engine === 'cockroachdb' ||
    config.engine === 'ferretdb'
  ) {
    const pgweb = await getPgwebStatus(config.name, config.engine)
    if (pgweb.running && pgweb.port) {
      ports.push({ port: pgweb.port, label: 'pgweb' })
    }
  }

  return {
    status: isRunning ? 'running' : 'stopped',
    ports,
  }
}

export const portsCommand = new Command('ports')
  .description('Show ports used by containers')
  .argument('[name]', 'Container name (shows all if omitted)')
  .option('--json', 'Output as JSON')
  .option('--running', 'Only show running containers')
  .action(
    async (
      name: string | undefined,
      options: { json?: boolean; running?: boolean },
    ) => {
      try {
        let containers: ContainerConfig[]

        if (name) {
          const config = await containerManager.getConfig(name)
          if (!config) {
            if (options.json) {
              console.log(
                JSON.stringify({ error: `Container "${name}" not found` }),
              )
            } else {
              console.error(uiError(`Container "${name}" not found`))
            }
            process.exit(1)
          }
          containers = [config]
        } else {
          containers = await containerManager.list()
        }

        // Gather port info for all containers
        const results = await Promise.all(
          containers.map(async (config) => {
            const { status, ports } = await getContainerPorts(config)
            return { config, status, ports }
          }),
        )

        // Filter to running only if requested
        const filtered = options.running
          ? results.filter((r) => r.status === 'running')
          : results

        if (options.json) {
          const jsonOutput = filtered.map((r) => ({
            name: r.config.name,
            engine: r.config.engine,
            status: r.status,
            ports: r.ports,
          }))
          console.log(JSON.stringify(jsonOutput, null, 2))
          return
        }

        if (filtered.length === 0) {
          console.log(
            uiInfo(
              options.running
                ? 'No running containers found.'
                : 'No containers found. Create one with: spindb create',
            ),
          )
          return
        }

        console.log()
        console.log(
          chalk.gray('  ') +
            chalk.bold.white('NAME'.padEnd(22)) +
            chalk.bold.white('ENGINE'.padEnd(18)) +
            chalk.bold.white('PORT(S)'),
        )
        console.log(chalk.gray('  ' + '─'.repeat(66)))

        for (const { config, ports } of filtered) {
          const engineIcon = getEngineIcon(config.engine)
          const engineName = config.engine.padEnd(13)

          let portDisplay: string
          if (ports.length === 0) {
            portDisplay = chalk.gray('—')
          } else {
            const parts = ports.map((p, i) =>
              i === 0
                ? String(p.port)
                : `${p.port} ${chalk.gray(`(${p.label})`)}`,
            )
            portDisplay = parts.join(chalk.gray(', '))
          }

          console.log(
            chalk.gray('  ') +
              chalk.cyan(config.name.padEnd(22)) +
              engineIcon +
              chalk.white(engineName) +
              portDisplay,
          )
        }

        console.log()
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
