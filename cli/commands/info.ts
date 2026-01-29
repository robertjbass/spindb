import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { existsSync } from 'fs'
import { basename } from 'path'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { paths } from '../../config/paths'
import { getEngine } from '../../engines'
import { uiError, uiInfo, header } from '../ui/theme'
import { getEngineIcon } from '../constants'
import { Engine, type ContainerConfig } from '../../types'

function formatDate(dateString: string): string {
  const date = new Date(dateString)
  return date.toLocaleString()
}

async function getActualStatus(
  config: ContainerConfig,
): Promise<'running' | 'stopped' | 'available' | 'missing'> {
  // SQLite: check file existence instead of running status
  if (config.engine === Engine.SQLite) {
    const fileExists = existsSync(config.database)
    return fileExists ? 'available' : 'missing'
  }

  const running = await processManager.isRunning(config.name, {
    engine: config.engine,
  })
  return running ? 'running' : 'stopped'
}

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
  const isSQLite = config.engine === Engine.SQLite

  // Status display based on engine type
  let statusDisplay: string
  if (isSQLite) {
    statusDisplay =
      actualStatus === 'available'
        ? chalk.blue('🔵 available')
        : chalk.gray('⚪ missing')
  } else {
    statusDisplay =
      actualStatus === 'running'
        ? chalk.green('● running')
        : chalk.gray('○ stopped')
  }

  console.log()
  console.log(header(`Container: ${config.name}`))
  console.log()
  console.log(
    chalk.gray('  ') +
      chalk.white('Engine:'.padEnd(14)) +
      chalk.cyan(`${icon}${config.engine} ${config.version}`),
  )
  console.log(
    chalk.gray('  ') + chalk.white('Status:'.padEnd(14)) + statusDisplay,
  )

  // Show file path for SQLite, port for server databases
  if (isSQLite) {
    console.log(
      chalk.gray('  ') +
        chalk.white('File:'.padEnd(14)) +
        chalk.green(config.database),
    )
  } else {
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
  }

  console.log(
    chalk.gray('  ') +
      chalk.white('Created:'.padEnd(14)) +
      chalk.gray(formatDate(config.created)),
  )

  // Don't show data dir for SQLite (file path is already shown)
  if (!isSQLite) {
    console.log(
      chalk.gray('  ') +
        chalk.white('Data Dir:'.padEnd(14)) +
        chalk.gray(dataDir),
    )
  }
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

async function displayAllContainersInfo(
  containers: ContainerConfig[],
  options: { json?: boolean },
): Promise<void> {
  if (options.json) {
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

  for (const container of containers) {
    const actualStatus = await getActualStatus(container)
    const isSQLite = container.engine === Engine.SQLite

    // Status display based on engine type
    let statusDisplay: string
    if (isSQLite) {
      statusDisplay =
        actualStatus === 'available'
          ? chalk.blue('🔵 available')
          : chalk.gray('⚪ missing')
    } else {
      statusDisplay =
        actualStatus === 'running'
          ? chalk.green('● running')
          : chalk.gray('○ stopped')
    }

    // getEngineIcon() includes trailing space for consistent alignment
    const engineDisplay = `${getEngineIcon(container.engine)}${container.engine}`

    // Show truncated file path for SQLite instead of port
    let portOrPath: string
    if (isSQLite) {
      const fileName = basename(container.database)
      // Truncate if longer than 8 chars to fit in 8-char column
      portOrPath = fileName.length > 8 ? fileName.slice(0, 7) + '…' : fileName
    } else {
      portOrPath = String(container.port)
    }

    console.log(
      chalk.gray('  ') +
        chalk.cyan(container.name.padEnd(18)) +
        chalk.white(engineDisplay.padEnd(13)) +
        chalk.yellow(container.version.padEnd(10)) +
        chalk.green(portOrPath.padEnd(8)) +
        chalk.gray(container.database.padEnd(16)) +
        statusDisplay,
    )
  }

  console.log()

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
      // If a specific container name is provided, check for it first
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
        await displayContainerInfo(config, options)
        return
      }

      // No name provided - list all containers
      const containers = await containerManager.list()

      if (containers.length === 0) {
        if (options.json) {
          console.log(JSON.stringify([], null, 2))
        } else {
          console.log(
            uiInfo('No containers found. Create one with: spindb create'),
          )
        }
        return
      }

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
                name: `${c.name} ${chalk.gray(`(${getEngineIcon(c.engine)}${c.engine})`)}`,
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

      await displayAllContainersInfo(containers, options)
    } catch (error) {
      const e = error as Error
      if (options.json) {
        console.error(JSON.stringify({ error: e.message }))
      } else {
        console.error(uiError(e.message))
      }
      process.exit(1)
    }
  })
