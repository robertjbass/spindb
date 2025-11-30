import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { paths } from '../../config/paths'
import { getEngine } from '../../engines'
import { error, info, header } from '../ui/theme'
import { getEngineIcon } from '../constants'
import type { ContainerConfig } from '../../types'

/**
 * Format a date for display
 */
function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleString()
}

/**
 * Get actual running status (not just config status)
 */
async function getActualStatus(
  config: ContainerConfig,
): Promise<'running' | 'stopped'> {
  const running = await processManager.isRunning(config.name, {
    engine: config.engine,
  })
  return running ? 'running' : 'stopped'
}

/**
 * Display info for a single container
 */
async function displayContainerInfo(
  config: ContainerConfig,
  options: { json?: boolean },
): Promise<void> {
  const actualStatus = await getActualStatus(config)
  const engine = getEngine(config.engine)
  const connectionString = engine.getConnectionString(config)
  const dataDir = paths.getContainerDataPath(config.name, {
    engine: config.engine,
  })

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          ...config,
          status: actualStatus,
          connectionString,
          dataDir,
        },
        null,
        2,
      ),
    )
    return
  }

  const icon = getEngineIcon(config.engine)
  const statusDisplay =
    actualStatus === 'running'
      ? chalk.green('● running')
      : chalk.gray('○ stopped')

  console.log()
  console.log(header(`Container: ${config.name}`))
  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.white('Engine:'.padEnd(14)) +
      chalk.cyan(`${icon} ${config.engine} ${config.version}`),
  )
  console.log(
    chalk.gray('  ') + chalk.white('Status:'.padEnd(14)) + statusDisplay,
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Port:'.padEnd(14)) +
      chalk.green(String(config.port)),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Database:'.padEnd(14)) +
      chalk.yellow(config.database),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Created:'.padEnd(14)) +
      chalk.gray(formatDate(config.created)),
  )
  console.log(
    chalk.gray('  ') +
      chalk.white('Data Dir:'.padEnd(14)) +
      chalk.gray(dataDir),
  )
  if (config.clonedFrom) {
    console.log(
      chalk.gray('  ') +
        chalk.white('Cloned From:'.padEnd(14)) +
        chalk.gray(config.clonedFrom),
    )
  }
  console.log()
  console.log(chalk.gray('  ') + chalk.white('Connection String:'))
  console.log(chalk.gray('  ') + chalk.cyan(connectionString))
  console.log()
}

/**
 * Display summary info for all containers
 */
async function displayAllContainersInfo(
  containers: ContainerConfig[],
  options: { json?: boolean },
): Promise<void> {
  if (options.json) {
    // Get actual status for all containers
    const containersWithStatus = await Promise.all(
      containers.map(async (config) => {
        const actualStatus = await getActualStatus(config)
        const engine = getEngine(config.engine)
        const connectionString = engine.getConnectionString(config)
        const dataDir = paths.getContainerDataPath(config.name, {
          engine: config.engine,
        })
        return {
          ...config,
          status: actualStatus,
          connectionString,
          dataDir,
        }
      }),
    )
    console.log(JSON.stringify(containersWithStatus, null, 2))
    return
  }

  console.log()
  console.log(header('All Containers'))
  console.log()

  // Table header
  console.log(
    chalk.gray('  ') +
      chalk.bold.white('NAME'.padEnd(18)) +
      chalk.bold.white('ENGINE'.padEnd(14)) +
      chalk.bold.white('VERSION'.padEnd(10)) +
      chalk.bold.white('PORT'.padEnd(8)) +
      chalk.bold.white('DATABASE'.padEnd(16)) +
      chalk.bold.white('STATUS'),
  )
  console.log(chalk.gray('  ' + '─'.repeat(78)))

  // Table rows
  for (const container of containers) {
    const actualStatus = await getActualStatus(container)
    const statusDisplay =
      actualStatus === 'running'
        ? chalk.green('● running')
        : chalk.gray('○ stopped')

    const icon = getEngineIcon(container.engine)
    const engineDisplay = `${icon} ${container.engine}`

    console.log(
      chalk.gray('  ') +
        chalk.cyan(container.name.padEnd(18)) +
        chalk.white(engineDisplay.padEnd(13)) +
        chalk.yellow(container.version.padEnd(10)) +
        chalk.green(String(container.port).padEnd(8)) +
        chalk.gray(container.database.padEnd(16)) +
        statusDisplay,
    )
  }

  console.log()

  // Summary
  const statusChecks = await Promise.all(
    containers.map((c) => getActualStatus(c)),
  )
  const running = statusChecks.filter((s) => s === 'running').length
  const stopped = statusChecks.filter((s) => s === 'stopped').length

  console.log(
    chalk.gray(
      `  ${containers.length} container(s): ${running} running, ${stopped} stopped`,
    ),
  )
  console.log()

  // Connection strings
  console.log(chalk.bold.white('  Connection Strings:'))
  console.log(chalk.gray('  ' + '─'.repeat(78)))
  for (const container of containers) {
    const engine = getEngine(container.engine)
    const connectionString = engine.getConnectionString(container)
    console.log(
      chalk.gray('  ') +
        chalk.cyan(container.name.padEnd(18)) +
        chalk.gray(connectionString),
    )
  }
  console.log()
}

export const infoCommand = new Command('info')
  .alias('status')
  .description('Show container details')
  .argument('[name]', 'Container name (omit to show all)')
  .option('--json', 'Output as JSON')
  .action(async (name: string | undefined, options: { json?: boolean }) => {
    try {
      const containers = await containerManager.list()

      if (containers.length === 0) {
        console.log(info('No containers found. Create one with: spindb create'))
        return
      }

      // If name provided, show single container
      if (name) {
        const config = await containerManager.getConfig(name)
        if (!config) {
          console.error(error(`Container "${name}" not found`))
          process.exit(1)
        }
        await displayContainerInfo(config, options)
        return
      }

      // If running interactively without name, ask if they want all or specific
      if (!options.json && process.stdout.isTTY && containers.length > 1) {
        const { choice } = await inquirer.prompt<{
          choice: string
        }>([
          {
            type: 'list',
            name: 'choice',
            message: 'Show info for:',
            choices: [
              { name: 'All containers', value: 'all' },
              ...containers.map((c) => ({
                name: `${c.name} ${chalk.gray(`(${getEngineIcon(c.engine)} ${c.engine})`)}`,
                value: c.name,
              })),
            ],
          },
        ])

        if (choice === 'all') {
          await displayAllContainersInfo(containers, options)
        } else {
          const config = await containerManager.getConfig(choice)
          if (config) {
            await displayContainerInfo(config, options)
          }
        }
        return
      }

      // Non-interactive or only one container: show all
      await displayAllContainersInfo(containers, options)
    } catch (err) {
      const e = err as Error
      console.error(error(e.message))
      process.exit(1)
    }
  })
