import { Command } from 'commander'
import { spawn } from 'child_process'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import {
  isUsqlInstalled,
  isPgcliInstalled,
  isMycliInstalled,
  detectPackageManager,
  installUsql,
  installPgcli,
  installMycli,
  getUsqlManualInstructions,
  getPgcliManualInstructions,
  getMycliManualInstructions,
} from '../../core/dependency-manager'
import { getEngine } from '../../engines'
import { getEngineDefaults } from '../../config/defaults'
import { promptContainerSelect } from '../ui/prompts'
import { error, warning, info, success } from '../ui/theme'

export const connectCommand = new Command('connect')
  .description('Connect to a container with database client')
  .argument('[name]', 'Container name')
  .option('-d, --database <name>', 'Database name')
  .option('--tui', 'Use usql for enhanced shell experience')
  .option('--install-tui', 'Install usql if not present, then connect')
  .option(
    '--pgcli',
    'Use pgcli for enhanced PostgreSQL shell (dropdown auto-completion)',
  )
  .option('--install-pgcli', 'Install pgcli if not present, then connect')
  .option(
    '--mycli',
    'Use mycli for enhanced MySQL shell (dropdown auto-completion)',
  )
  .option('--install-mycli', 'Install mycli if not present, then connect')
  .action(
    async (
      name: string | undefined,
      options: {
        database?: string
        tui?: boolean
        installTui?: boolean
        pgcli?: boolean
        installPgcli?: boolean
        mycli?: boolean
        installMycli?: boolean
      },
    ) => {
      try {
        let containerName = name

        // Interactive selection if no name provided
        if (!containerName) {
          const containers = await containerManager.list()
          const running = containers.filter((c) => c.status === 'running')

          if (running.length === 0) {
            if (containers.length === 0) {
              console.log(
                warning('No containers found. Create one with: spindb create'),
              )
            } else {
              console.log(
                warning(
                  'No running containers. Start one first with: spindb start',
                ),
              )
            }
            return
          }

          const selected = await promptContainerSelect(
            running,
            'Select container to connect to:',
          )
          if (!selected) return
          containerName = selected
        }

        // Get container config
        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(error(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const { engine: engineName } = config
        const engineDefaults = getEngineDefaults(engineName)

        // Default database: container's database or superuser
        const database =
          options.database ?? config.database ?? engineDefaults.superuser

        // Check if running
        const running = await processManager.isRunning(containerName, {
          engine: engineName,
        })
        if (!running) {
          console.error(
            error(
              `Container "${containerName}" is not running. Start it first.`,
            ),
          )
          process.exit(1)
        }

        // Get engine
        const engine = getEngine(engineName)
        const connectionString = engine.getConnectionString(config, database)

        // Handle --tui and --install-tui flags (usql)
        const useUsql = options.tui || options.installTui
        if (useUsql) {
          const usqlInstalled = await isUsqlInstalled()

          if (!usqlInstalled) {
            if (options.installTui) {
              // Try to install usql
              console.log(
                info('Installing usql for enhanced shell experience...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installUsql(pm)
                if (result.success) {
                  console.log(success('usql installed successfully!'))
                  console.log()
                } else {
                  console.error(
                    error(`Failed to install usql: ${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('Manual installation:'))
                  for (const instruction of getUsqlManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(error('No supported package manager found'))
                console.log()
                console.log(chalk.gray('Manual installation:'))
                for (const instruction of getUsqlManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              // --tui flag but usql not installed
              console.error(error('usql is not installed'))
              console.log()
              console.log(
                chalk.gray('Install usql for enhanced shell experience:'),
              )
              console.log(chalk.cyan('  spindb connect --install-tui'))
              console.log()
              console.log(chalk.gray('Or install manually:'))
              for (const instruction of getUsqlManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        // Handle --pgcli and --install-pgcli flags
        const usePgcli = options.pgcli || options.installPgcli
        if (usePgcli) {
          if (engineName !== 'postgresql') {
            console.error(
              error('pgcli is only available for PostgreSQL containers'),
            )
            console.log(chalk.gray('For MySQL, use: spindb connect --mycli'))
            process.exit(1)
          }

          const pgcliInstalled = await isPgcliInstalled()

          if (!pgcliInstalled) {
            if (options.installPgcli) {
              console.log(
                info('Installing pgcli for enhanced PostgreSQL shell...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installPgcli(pm)
                if (result.success) {
                  console.log(success('pgcli installed successfully!'))
                  console.log()
                } else {
                  console.error(
                    error(`Failed to install pgcli: ${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('Manual installation:'))
                  for (const instruction of getPgcliManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(error('No supported package manager found'))
                console.log()
                console.log(chalk.gray('Manual installation:'))
                for (const instruction of getPgcliManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(error('pgcli is not installed'))
              console.log()
              console.log(
                chalk.gray('Install pgcli for enhanced PostgreSQL shell:'),
              )
              console.log(chalk.cyan('  spindb connect --install-pgcli'))
              console.log()
              console.log(chalk.gray('Or install manually:'))
              for (const instruction of getPgcliManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        // Handle --mycli and --install-mycli flags
        const useMycli = options.mycli || options.installMycli
        if (useMycli) {
          if (engineName !== 'mysql') {
            console.error(error('mycli is only available for MySQL containers'))
            console.log(
              chalk.gray('For PostgreSQL, use: spindb connect --pgcli'),
            )
            process.exit(1)
          }

          const mycliInstalled = await isMycliInstalled()

          if (!mycliInstalled) {
            if (options.installMycli) {
              console.log(info('Installing mycli for enhanced MySQL shell...'))
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installMycli(pm)
                if (result.success) {
                  console.log(success('mycli installed successfully!'))
                  console.log()
                } else {
                  console.error(
                    error(`Failed to install mycli: ${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('Manual installation:'))
                  for (const instruction of getMycliManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(error('No supported package manager found'))
                console.log()
                console.log(chalk.gray('Manual installation:'))
                for (const instruction of getMycliManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(error('mycli is not installed'))
              console.log()
              console.log(chalk.gray('Install mycli for enhanced MySQL shell:'))
              console.log(chalk.cyan('  spindb connect --install-mycli'))
              console.log()
              console.log(chalk.gray('Or install manually:'))
              for (const instruction of getMycliManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        console.log(info(`Connecting to ${containerName}:${database}...`))
        console.log()

        // Build client command based on engine and shell preference
        let clientCmd: string
        let clientArgs: string[]

        if (usePgcli) {
          // pgcli accepts connection strings
          clientCmd = 'pgcli'
          clientArgs = [connectionString]
        } else if (useMycli) {
          // mycli: mycli -h host -P port -u user database
          clientCmd = 'mycli'
          clientArgs = [
            '-h',
            '127.0.0.1',
            '-P',
            String(config.port),
            '-u',
            engineDefaults.superuser,
            database,
          ]
        } else if (useUsql) {
          // usql accepts connection strings directly for both PostgreSQL and MySQL
          clientCmd = 'usql'
          clientArgs = [connectionString]
        } else if (engineName === 'mysql') {
          // MySQL: mysql -h 127.0.0.1 -P port -u root database
          clientCmd = 'mysql'
          clientArgs = [
            '-h',
            '127.0.0.1',
            '-P',
            String(config.port),
            '-u',
            engineDefaults.superuser,
            database,
          ]
        } else {
          // PostgreSQL: psql connection_string
          clientCmd = 'psql'
          clientArgs = [connectionString]
        }

        const clientProcess = spawn(clientCmd, clientArgs, {
          stdio: 'inherit',
        })

        clientProcess.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            console.log(warning(`${clientCmd} not found on your system.`))
            console.log()
            console.log(
              chalk.gray('  Install client tools or connect manually:'),
            )
            console.log(chalk.cyan(`  ${connectionString}`))
            console.log()

            if (clientCmd === 'usql') {
              console.log(chalk.gray('  Install usql:'))
              console.log(
                chalk.cyan('  brew tap xo/xo && brew install xo/xo/usql'),
              )
            } else if (clientCmd === 'pgcli') {
              console.log(chalk.gray('  Install pgcli:'))
              console.log(chalk.cyan('  brew install pgcli'))
            } else if (clientCmd === 'mycli') {
              console.log(chalk.gray('  Install mycli:'))
              console.log(chalk.cyan('  brew install mycli'))
            } else if (engineName === 'mysql') {
              console.log(chalk.gray('  On macOS with Homebrew:'))
              console.log(chalk.cyan('  brew install mysql-client'))
            } else {
              console.log(chalk.gray('  On macOS with Homebrew:'))
              console.log(
                chalk.cyan('  brew install libpq && brew link --force libpq'),
              )
            }
            console.log()
          } else {
            console.error(error(err.message))
          }
        })

        await new Promise<void>((resolve) => {
          clientProcess.on('close', () => resolve())
        })
      } catch (err) {
        const e = err as Error
        console.error(error(e.message))
        process.exit(1)
      }
    },
  )
