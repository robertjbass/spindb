import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { promptContainerSelect } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { error, warning, success } from '../ui/theme'

function isValidName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
}

async function promptEditAction(): Promise<'name' | 'port' | null> {
  const { action } = await inquirer.prompt<{ action: string }>([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to edit?',
      choices: [
        { name: 'Rename container', value: 'name' },
        { name: 'Change port', value: 'port' },
        { name: chalk.gray('Cancel'), value: 'cancel' },
      ],
    },
  ])

  if (action === 'cancel') return null
  return action as 'name' | 'port'
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
  .description('Edit container properties (rename or change port)')
  .argument('[name]', 'Container name')
  .option('-n, --name <newName>', 'New container name')
  .option('-p, --port <port>', 'New port number', parseInt)
  .action(
    async (
      name: string | undefined,
      options: { name?: string; port?: number },
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

        if (options.name === undefined && options.port === undefined) {
          const action = await promptEditAction()
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

        console.log()
        console.log(success('Container updated successfully'))
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
