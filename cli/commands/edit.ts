import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { getEngine } from '../../engines'
import { paths } from '../../config/paths'
import { promptContainerSelect } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { error, warning, success, info } from '../ui/theme'

function isValidName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
}

/**
 * Prompt for what to edit when no options provided
 */
async function promptEditAction(
  engine: string,
): Promise<'name' | 'port' | 'config' | null> {
  const choices = [
    { name: 'Rename container', value: 'name' },
    { name: 'Change port', value: 'port' },
  ]

  // Only show config option for engines that support it
  if (engine === 'postgresql') {
    choices.push({ name: 'Edit database config (postgresql.conf)', value: 'config' })
  }

  choices.push({ name: chalk.gray('Cancel'), value: 'cancel' })

  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to edit?',
      choices,
    },
  ])

  if (action === 'cancel') return null
  return action as 'name' | 'port' | 'config'
}

async function promptNewName(currentName: string): Promise<string | null> {
  const { newName } = await inquirer.prompt<{ newName: string }>([
    {
      type: 'input',
      name: 'newName',
      message: 'New container name:',
      default: currentName,
      validate: (input: string) => {
        if (!input) return 'Name is required'
        if (!isValidName(input)) {
          return 'Name must start with a letter and contain only letters, numbers, hyphens, and underscores'
        }
        return true
      },
    },
  ])

  if (newName === currentName) {
    console.log(warning('Name unchanged'))
    return null
  }

  return newName
}

// Common PostgreSQL config settings that users might want to edit
const COMMON_PG_SETTINGS = [
  { name: 'max_connections', description: 'Maximum concurrent connections', default: '200' },
  { name: 'shared_buffers', description: 'Memory for shared buffers', default: '128MB' },
  { name: 'work_mem', description: 'Memory per operation', default: '4MB' },
  { name: 'maintenance_work_mem', description: 'Memory for maintenance ops', default: '64MB' },
  { name: 'effective_cache_size', description: 'Planner cache size estimate', default: '4GB' },
]

/**
 * Prompt for PostgreSQL config setting to edit
 */
async function promptConfigSetting(): Promise<{ key: string; value: string } | null> {
  const choices = COMMON_PG_SETTINGS.map((s) => ({
    name: `${s.name.padEnd(25)} ${chalk.gray(s.description)}`,
    value: s.name,
  }))
  choices.push({ name: chalk.cyan('Custom setting...'), value: '__custom__' })
  choices.push({ name: chalk.gray('Cancel'), value: '__cancel__' })

  const { setting } = await inquirer.prompt<{ setting: string }>([
    {
      type: 'list',
      name: 'setting',
      message: 'Select setting to edit:',
      choices,
    },
  ])

  if (setting === '__cancel__') return null

  let key = setting
  if (setting === '__custom__') {
    const { customKey } = await inquirer.prompt<{ customKey: string }>([
      {
        type: 'input',
        name: 'customKey',
        message: 'Setting name:',
        validate: (input: string) => {
          if (!input.trim()) return 'Setting name is required'
          if (!/^[a-z_]+$/.test(input)) return 'Setting names are lowercase with underscores'
          return true
        },
      },
    ])
    key = customKey
  }

  const defaultValue = COMMON_PG_SETTINGS.find((s) => s.name === key)?.default || ''
  const { value } = await inquirer.prompt<{ value: string }>([
    {
      type: 'input',
      name: 'value',
      message: `Value for ${key}:`,
      default: defaultValue,
      validate: (input: string) => {
        if (!input.trim()) return 'Value is required'
        return true
      },
    },
  ])

  return { key, value }
}

/**
 * Prompt for new port
 */
async function promptNewPort(currentPort: number): Promise<number | null> {
  const { newPort } = await inquirer.prompt<{ newPort: number }>([
    {
      type: 'input',
      name: 'newPort',
      message: 'New port:',
      default: String(currentPort),
      validate: (input: string) => {
        const num = parseInt(input, 10)
        if (isNaN(num) || num < 1 || num > 65535) {
          return 'Port must be a number between 1 and 65535'
        }
        return true
      },
      filter: (input: string) => parseInt(input, 10),
    },
  ])

  if (newPort === currentPort) {
    console.log(warning('Port unchanged'))
    return null
  }

  const portAvailable = await portManager.isPortAvailable(newPort)
  if (!portAvailable) {
    console.log(
      warning(
        `Note: Port ${newPort} is currently in use. It will be used when the container starts.`,
      ),
    )
  }

  return newPort
}

export const editCommand = new Command('edit')
  .description('Edit container properties (rename, port, or database config)')
  .argument('[name]', 'Container name')
  .option('-n, --name <newName>', 'New container name')
  .option('-p, --port <port>', 'New port number', parseInt)
  .option(
    '--set-config <setting>',
    'Set a database config value (e.g., max_connections=200)',
  )
  .action(
    async (
      name: string | undefined,
      options: { name?: string; port?: number; setConfig?: string },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(warning('No containers found'))
            return
          }

          const selected = await promptContainerSelect(
            containers,
            'Select container to edit:',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(error(`Container "${containerName}" not found`))
          process.exit(1)
        }

        // If no options provided, prompt for what to edit
        if (
          options.name === undefined &&
          options.port === undefined &&
          options.setConfig === undefined
        ) {
          const action = await promptEditAction(config.engine)
          if (!action) return

          if (action === 'name') {
            const newName = await promptNewName(containerName)
            if (newName) {
              options.name = newName
            } else {
              return
            }
          } else if (action === 'port') {
            const newPort = await promptNewPort(config.port)
            if (newPort) {
              options.port = newPort
            } else {
              return
            }
          } else if (action === 'config') {
            const configSetting = await promptConfigSetting()
            if (configSetting) {
              options.setConfig = `${configSetting.key}=${configSetting.value}`
            } else {
              return
            }
          }
        }

        if (options.name) {
          if (!isValidName(options.name)) {
            console.error(
              error(
                'Name must start with a letter and contain only letters, numbers, hyphens, and underscores',
              ),
            )
            process.exit(1)
          }

          const exists = await containerManager.exists(options.name, {
            engine: config.engine,
          })
          if (exists) {
            console.error(error(`Container "${options.name}" already exists`))
            process.exit(1)
          }

          const running = await processManager.isRunning(containerName, {
            engine: config.engine,
          })
          if (running) {
            console.error(
              error(
                `Container "${containerName}" is running. Stop it first to rename.`,
              ),
            )
            process.exit(1)
          }

          const spinner = createSpinner(
            `Renaming "${containerName}" to "${options.name}"...`,
          )
          spinner.start()

          await containerManager.rename(containerName, options.name)

          spinner.succeed(`Renamed "${containerName}" to "${options.name}"`)

          containerName = options.name
        }

        if (options.port !== undefined) {
          if (options.port < 1 || options.port > 65535) {
            console.error(error('Port must be between 1 and 65535'))
            process.exit(1)
          }

          const portAvailable = await portManager.isPortAvailable(options.port)
          if (!portAvailable) {
            console.log(
              warning(
                `Port ${options.port} is currently in use. The container will use this port on next start.`,
              ),
            )
          }

          const spinner = createSpinner(`Changing port to ${options.port}...`)
          spinner.start()

          await containerManager.updateConfig(containerName, {
            port: options.port,
          })

          spinner.succeed(`Port changed to ${options.port}`)
          console.log(
            chalk.gray(
              '  Note: Port change takes effect on next container start.',
            ),
          )
        }

        // Handle config change
        if (options.setConfig) {
          // Only PostgreSQL supports config editing for now
          if (config.engine !== 'postgresql') {
            console.error(
              error(`Config editing is only supported for PostgreSQL containers`),
            )
            process.exit(1)
          }

          // Parse the setting (key=value format)
          const match = options.setConfig.match(/^([a-z_]+)=(.+)$/)
          if (!match) {
            console.error(
              error(
                'Invalid config format. Use: --set-config key=value (e.g., max_connections=200)',
              ),
            )
            process.exit(1)
          }

          const [, configKey, configValue] = match

          // Get the PostgreSQL engine to update config
          const engine = getEngine(config.engine)
          const dataDir = paths.getContainerDataPath(containerName, {
            engine: config.engine,
          })

          const spinner = createSpinner(
            `Setting ${configKey} = ${configValue}...`,
          )
          spinner.start()

          // Use the PostgreSQL engine's setConfigValue method
          if ('setConfigValue' in engine) {
            await (engine as { setConfigValue: (dataDir: string, key: string, value: string) => Promise<void> }).setConfigValue(
              dataDir,
              configKey,
              configValue,
            )
          }

          spinner.succeed(`Set ${configKey} = ${configValue}`)

          // Check if container is running and warn about restart
          const running = await processManager.isRunning(containerName, {
            engine: config.engine,
          })
          if (running) {
            console.log(
              info(
                '  Note: Restart the container for changes to take effect.',
              ),
            )
            console.log(
              chalk.gray(
                `    spindb stop ${containerName} && spindb start ${containerName}`,
              ),
            )
          } else {
            console.log(
              chalk.gray(
                '  Config change will take effect on next container start.',
              ),
            )
          }
        }

        console.log()
        console.log(success('Container updated successfully'))
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
