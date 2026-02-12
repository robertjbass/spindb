import { Command } from 'commander'
import chalk from 'chalk'
import inquirer from 'inquirer'
import {
  existsSync,
  renameSync,
  mkdirSync,
  statSync,
  unlinkSync,
  copyFileSync,
} from 'fs'
import { dirname, resolve, basename, join } from 'path'
import { homedir } from 'os'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { portManager } from '../../core/port-manager'
import { getEngine } from '../../engines'
import { paths } from '../../config/paths'
import { promptContainerSelect } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiError, uiWarning, uiSuccess, uiInfo } from '../ui/theme'
import { Engine, isFileBasedEngine } from '../../types'
import {
  FILE_BASED_EXTENSION_REGEX,
  isValidExtensionForEngine,
  formatExtensionsForEngine,
  getRegistryForEngine,
} from '../../engines/file-based-utils'

function isValidName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)
}

// Prompt for what to edit when no options provided
async function promptEditAction(
  engine: string,
): Promise<'name' | 'port' | 'config' | 'relocate' | null> {
  const choices = [{ name: 'Rename container', value: 'name' }]

  // File-based engines: show relocate instead of port
  if (isFileBasedEngine(engine as Engine)) {
    choices.push({ name: 'Relocate database file', value: 'relocate' })
  } else {
    choices.push({ name: 'Change port', value: 'port' })
  }

  // Only show config option for engines that support it
  if (engine === Engine.PostgreSQL) {
    choices.push({
      name: 'Edit database config (postgresql.conf)',
      value: 'config',
    })
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
  return action as 'name' | 'port' | 'config' | 'relocate'
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
    console.log(uiWarning('Name unchanged'))
    return null
  }

  return newName
}

// Common PostgreSQL config settings that users might want to edit
const COMMON_PG_SETTINGS = [
  {
    name: 'max_connections',
    description: 'Maximum concurrent connections',
    default: '200',
  },
  {
    name: 'shared_buffers',
    description: 'Memory for shared buffers',
    default: '128MB',
  },
  { name: 'work_mem', description: 'Memory per operation', default: '4MB' },
  {
    name: 'maintenance_work_mem',
    description: 'Memory for maintenance ops',
    default: '64MB',
  },
  {
    name: 'effective_cache_size',
    description: 'Planner cache size estimate',
    default: '4GB',
  },
]

// Prompt for PostgreSQL config setting to edit
async function promptConfigSetting(): Promise<{
  key: string
  value: string
} | null> {
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
          if (!/^[a-z_]+$/.test(input))
            return 'Setting names are lowercase with underscores'
          return true
        },
      },
    ])
    key = customKey
  }

  const defaultValue =
    COMMON_PG_SETTINGS.find((s) => s.name === key)?.default || ''
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

// Prompt for new port
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
    console.log(uiWarning('Port unchanged'))
    return null
  }

  const portAvailable = await portManager.isPortAvailable(newPort)
  if (!portAvailable) {
    console.log(
      uiWarning(
        `Note: Port ${newPort} is currently in use. It will be used when the container starts.`,
      ),
    )
  }

  return newPort
}

// Prompt for new file location (file-based engine relocate)
async function promptNewLocation(
  currentPath: string,
  engine: Engine.SQLite | Engine.DuckDB,
): Promise<string | null> {
  console.log()
  console.log(chalk.gray(`  Current location: ${currentPath}`))
  console.log(
    chalk.gray('  Enter an absolute path or relative to current directory.'),
  )
  console.log()

  const { newPath } = await inquirer.prompt<{ newPath: string }>([
    {
      type: 'input',
      name: 'newPath',
      message: 'New file location:',
      default: currentPath,
      validate: (input: string) => {
        if (!input.trim()) return 'Path is required'
        if (!isValidExtensionForEngine(resolve(input), engine)) {
          return `Path should end with ${formatExtensionsForEngine(engine)}`
        }
        return true
      },
    },
  ])

  const resolvedPath = resolve(newPath)

  if (resolvedPath === currentPath) {
    console.log(uiWarning('Location unchanged'))
    return null
  }

  // Check if target already exists
  if (existsSync(resolvedPath)) {
    const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
      {
        type: 'confirm',
        name: 'overwrite',
        message: `File already exists at ${resolvedPath}. Overwrite?`,
        default: false,
      },
    ])
    if (!overwrite) {
      console.log(uiWarning('Relocate cancelled'))
      return null
    }
  }

  return resolvedPath
}

export const editCommand = new Command('edit')
  .description(
    'Edit container properties (rename, port, relocate, or database config)',
  )
  .argument('[name]', 'Container name')
  .option('-n, --name <newName>', 'New container name')
  .option('-p, --port <port>', 'New port number', parseInt)
  .option(
    '--relocate <path>',
    'New file location for file-based database (moves the file)',
  )
  .option(
    '--overwrite',
    'Overwrite destination file if it exists (for --relocate)',
  )
  .option(
    '--set-config <setting>',
    'Set a database config value (e.g., max_connections=200)',
  )
  .option('-j, --json', 'Output result as JSON')
  .action(
    async (
      name: string | undefined,
      options: {
        name?: string
        port?: number
        relocate?: string
        overwrite?: boolean
        setConfig?: string
        json?: boolean
      },
    ) => {
      try {
        let containerName = name
        const changes: Record<string, unknown> = {}

        if (!containerName) {
          const containers = await containerManager.list()

          if (containers.length === 0) {
            console.log(uiWarning('No containers found'))
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
          console.error(uiError(`Container "${containerName}" not found`))
          process.exit(1)
        }

        // If no options provided, prompt for what to edit
        if (
          options.name === undefined &&
          options.port === undefined &&
          options.relocate === undefined &&
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
          } else if (action === 'relocate') {
            const newLocation = await promptNewLocation(
              config.database,
              config.engine as Engine.SQLite | Engine.DuckDB,
            )
            if (newLocation) {
              options.relocate = newLocation
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
              uiError(
                'Name must start with a letter and contain only letters, numbers, hyphens, and underscores',
              ),
            )
            process.exit(1)
          }

          const exists = await containerManager.exists(options.name, {
            engine: config.engine,
          })
          if (exists) {
            console.error(uiError(`Container "${options.name}" already exists`))
            process.exit(1)
          }

          const running = await processManager.isRunning(containerName, {
            engine: config.engine,
          })
          if (running) {
            console.error(
              uiError(
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

          changes.renamed = { from: containerName, to: options.name }
          containerName = options.name
        }

        if (options.port !== undefined) {
          if (options.port < 1 || options.port > 65535) {
            console.error(uiError('Port must be between 1 and 65535'))
            process.exit(1)
          }

          const portAvailable = await portManager.isPortAvailable(options.port)
          if (!portAvailable) {
            console.log(
              uiWarning(
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
          changes.port = { from: config.port, to: options.port }
          if (!options.json) {
            console.log(
              chalk.gray(
                '  Note: Port change takes effect on next container start.',
              ),
            )
          }
        }

        // Handle file-based engine relocate
        if (options.relocate) {
          if (!isFileBasedEngine(config.engine)) {
            console.error(
              uiError(
                'Relocate is only available for file-based containers (SQLite, DuckDB)',
              ),
            )
            process.exit(1)
          }

          // Expand ~ to home directory
          let expandedPath = options.relocate
          if (options.relocate === '~') {
            expandedPath = homedir()
          } else if (options.relocate.startsWith('~/')) {
            expandedPath = join(homedir(), options.relocate.slice(2))
          }

          // Convert relative paths to absolute
          if (!expandedPath.startsWith('/')) {
            expandedPath = resolve(process.cwd(), expandedPath)
          }

          // Check if path looks like a file (has db extension) or directory
          const hasDbExtension = FILE_BASED_EXTENSION_REGEX.test(expandedPath)

          // Treat as directory if:
          // - ends with /
          // - exists and is a directory
          // - doesn't have a database file extension
          const isDirectory =
            expandedPath.endsWith('/') ||
            (existsSync(expandedPath) &&
              statSync(expandedPath).isDirectory()) ||
            !hasDbExtension

          let newPath: string
          if (isDirectory) {
            const dirPath = expandedPath.endsWith('/')
              ? expandedPath.slice(0, -1)
              : expandedPath
            const currentFileName = basename(config.database)
            newPath = join(dirPath, currentFileName)
          } else {
            newPath = expandedPath
          }

          // Check source file exists
          if (!existsSync(config.database)) {
            console.error(
              uiError(`Source database file not found: ${config.database}`),
            )
            process.exit(1)
          }

          // Check if destination already exists
          if (existsSync(newPath)) {
            if (options.overwrite) {
              // Remove existing file before move
              unlinkSync(newPath)
              console.log(uiWarning(`Overwriting existing file: ${newPath}`))
            } else {
              console.error(
                uiError(`Destination file already exists: ${newPath}`),
              )
              console.log(
                uiInfo('Use --overwrite to replace the existing file'),
              )
              process.exit(1)
            }
          }

          // Ensure target directory exists
          const targetDir = dirname(newPath)
          if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true })
            console.log(uiInfo(`Created directory: ${targetDir}`))
          }

          const spinner = createSpinner(`Moving database to ${newPath}...`)
          spinner.start()

          try {
            // Track if we need to delete source file after registry update
            // (for cross-device moves where rename doesn't work)
            let needsSourceCleanup = false
            const originalPath = config.database

            // Try rename first (fast, same filesystem)
            try {
              renameSync(config.database, newPath)
            } catch (renameErr) {
              const e = renameErr as NodeJS.ErrnoException
              // EXDEV = cross-device link, need to copy+delete
              if (e.code === 'EXDEV') {
                try {
                  // Copy file preserving mode/permissions
                  copyFileSync(config.database, newPath)
                  // Don't delete source yet - wait for registry update to succeed
                  needsSourceCleanup = true
                } catch (copyErr) {
                  // Clean up partial target on failure
                  if (existsSync(newPath)) {
                    try {
                      unlinkSync(newPath)
                    } catch {
                      // Ignore cleanup errors
                    }
                  }
                  throw copyErr
                }
              } else {
                throw renameErr
              }
            }

            // Update the container config and file-based registry
            await containerManager.updateConfig(containerName, {
              database: newPath,
            })
            await getRegistryForEngine(config.engine).update(containerName, {
              filePath: newPath,
            })

            // Now safe to delete source file for cross-device moves
            if (needsSourceCleanup && existsSync(originalPath)) {
              unlinkSync(originalPath)
            }

            spinner.succeed(`Database relocated to ${newPath}`)
            changes.relocated = { from: originalPath, to: newPath }
          } catch (error) {
            spinner.fail('Failed to relocate database')
            throw error
          }
        }

        // Handle config change
        if (options.setConfig) {
          // Only PostgreSQL supports config editing for now
          if (config.engine !== Engine.PostgreSQL) {
            console.error(
              uiError(
                `Config editing is only supported for PostgreSQL containers`,
              ),
            )
            process.exit(1)
          }

          // Parse the setting (key=value format)
          const match = options.setConfig.match(/^([a-z_]+)=(.+)$/)
          if (!match) {
            console.error(
              uiError(
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
            await (
              engine as {
                setConfigValue: (
                  dataDir: string,
                  key: string,
                  value: string,
                ) => Promise<void>
              }
            ).setConfigValue(dataDir, configKey, configValue)
            spinner.succeed(`Set ${configKey} = ${configValue}`)
            changes.config = { key: configKey, value: configValue }
          } else {
            spinner.fail('Config editing not supported for this engine')
            process.exit(1)
          }

          // Check if container is running and warn about restart
          const running = await processManager.isRunning(containerName, {
            engine: config.engine,
          })
          if (!options.json) {
            if (running) {
              console.log(
                uiInfo(
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
        }

        if (options.json) {
          console.log(
            JSON.stringify({
              success: true,
              container: containerName,
              changes,
            }),
          )
        } else {
          console.log()
          console.log(uiSuccess('Container updated successfully'))
        }
      } catch (error) {
        const e = error as Error
        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
