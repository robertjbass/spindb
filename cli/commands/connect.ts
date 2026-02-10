import { Command } from 'commander'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import {
  isUsqlInstalled,
  isPgcliInstalled,
  isMycliInstalled,
  isLitecliInstalled,
  isIredisInstalled,
  detectPackageManager,
  installUsql,
  installPgcli,
  installMycli,
  installLitecli,
  installIredis,
  getUsqlManualInstructions,
  getPgcliManualInstructions,
  getMycliManualInstructions,
  getLitecliManualInstructions,
  getIredisManualInstructions,
} from '../../core/dependency-manager'
import { getEngine } from '../../engines'
import { getEngineDefaults } from '../../config/defaults'
import { promptContainerSelect } from '../ui/prompts'
import { uiError, uiWarning, uiInfo, uiSuccess } from '../ui/theme'
import { Engine } from '../../types'
import { configManager } from '../../core/config-manager'
import { DBLAB_ENGINES, getDblabArgs } from '../../core/dblab-utils'
import { downloadDblabCli } from './menu/shell-handlers'

export const connectCommand = new Command('connect')
  .alias('shell')
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
  .option(
    '--litecli',
    'Use litecli for enhanced SQLite shell (auto-completion, syntax highlighting)',
  )
  .option('--install-litecli', 'Install litecli if not present, then connect')
  .option(
    '--iredis',
    'Use iredis for enhanced Redis shell (auto-completion, syntax highlighting)',
  )
  .option('--install-iredis', 'Install iredis if not present, then connect')
  .option('--dblab', 'Use dblab visual TUI (table browser, query editor)')
  .option('--install-dblab', 'Download dblab if not present, then connect')
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
        litecli?: boolean
        installLitecli?: boolean
        iredis?: boolean
        installIredis?: boolean
        dblab?: boolean
        installDblab?: boolean
      },
    ) => {
      try {
        let containerName = name

        if (!containerName) {
          const containers = await containerManager.list()
          // SQLite containers are always "available" if file exists, server containers need to be running
          const connectable = containers.filter((c) => {
            if (c.engine === Engine.SQLite) {
              return existsSync(c.database)
            }
            return c.status === 'running'
          })

          if (connectable.length === 0) {
            if (containers.length === 0) {
              console.log(
                uiWarning(
                  'No containers found. Create one with: spindb create',
                ),
              )
            } else {
              console.log(
                uiWarning(
                  'No running containers. Start one first with: spindb start',
                ),
              )
            }
            return
          }

          const selected = await promptContainerSelect(
            connectable,
            'Select container to connect to:',
          )
          if (!selected) return
          containerName = selected
        }

        const config = await containerManager.getConfig(containerName)
        if (!config) {
          console.error(uiError(`Container "${containerName}" not found`))
          process.exit(1)
        }

        const { engine: engineName } = config
        const engineDefaults = getEngineDefaults(engineName)

        const database =
          options.database ?? config.database ?? engineDefaults.superuser

        // SQLite: check file exists instead of running status
        if (engineName === Engine.SQLite) {
          if (!existsSync(config.database)) {
            console.error(
              uiError(`SQLite database file not found: ${config.database}`),
            )
            process.exit(1)
          }
        } else {
          // Server databases need to be running
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            console.error(
              uiError(
                `Container "${containerName}" is not running. Start it first.`,
              ),
            )
            process.exit(1)
          }
        }

        const engine = getEngine(engineName)
        const connectionString = engine.getConnectionString(config, database)

        const useUsql = options.tui || options.installTui
        if (useUsql) {
          const usqlInstalled = await isUsqlInstalled()

          if (!usqlInstalled) {
            if (options.installTui) {
              console.log(
                uiInfo('Installing usql for enhanced shell experience...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installUsql(pm)
                if (result.success) {
                  console.log(uiSuccess('usql installed successfully!'))
                  console.log()
                } else {
                  console.error(
                    uiError(`Failed to install usql: ${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('Manual installation:'))
                  for (const instruction of getUsqlManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('No supported package manager found'))
                console.log()
                console.log(chalk.gray('Manual installation:'))
                for (const instruction of getUsqlManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('usql is not installed'))
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

        const usePgcli = options.pgcli || options.installPgcli
        if (usePgcli) {
          if (engineName !== 'postgresql') {
            console.error(
              uiError('pgcli is only available for PostgreSQL containers'),
            )
            console.log(chalk.gray('For MySQL, use: spindb connect --mycli'))
            process.exit(1)
          }

          const pgcliInstalled = await isPgcliInstalled()

          if (!pgcliInstalled) {
            if (options.installPgcli) {
              console.log(
                uiInfo('Installing pgcli for enhanced PostgreSQL shell...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installPgcli(pm)
                if (result.success) {
                  console.log(uiSuccess('pgcli installed successfully!'))
                  console.log()
                } else {
                  console.error(
                    uiError(`Failed to install pgcli: ${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('Manual installation:'))
                  for (const instruction of getPgcliManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('No supported package manager found'))
                console.log()
                console.log(chalk.gray('Manual installation:'))
                for (const instruction of getPgcliManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('pgcli is not installed'))
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

        const useMycli = options.mycli || options.installMycli
        if (useMycli) {
          if (engineName !== 'mysql') {
            console.error(
              uiError('mycli is only available for MySQL containers'),
            )
            console.log(
              chalk.gray('For PostgreSQL, use: spindb connect --pgcli'),
            )
            process.exit(1)
          }

          const mycliInstalled = await isMycliInstalled()

          if (!mycliInstalled) {
            if (options.installMycli) {
              console.log(
                uiInfo('Installing mycli for enhanced MySQL shell...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installMycli(pm)
                if (result.success) {
                  console.log(uiSuccess('mycli installed successfully!'))
                  console.log()
                } else {
                  console.error(
                    uiError(`Failed to install mycli: ${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('Manual installation:'))
                  for (const instruction of getMycliManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('No supported package manager found'))
                console.log()
                console.log(chalk.gray('Manual installation:'))
                for (const instruction of getMycliManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('mycli is not installed'))
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

        const useLitecli = options.litecli || options.installLitecli
        if (useLitecli) {
          if (engineName !== Engine.SQLite) {
            console.error(
              uiError('litecli is only available for SQLite containers'),
            )
            if (engineName === 'postgresql') {
              console.log(
                chalk.gray('For PostgreSQL, use: spindb connect --pgcli'),
              )
            } else if (engineName === 'mysql') {
              console.log(chalk.gray('For MySQL, use: spindb connect --mycli'))
            }
            process.exit(1)
          }

          const litecliInstalled = await isLitecliInstalled()

          if (!litecliInstalled) {
            if (options.installLitecli) {
              console.log(
                uiInfo('Installing litecli for enhanced SQLite shell...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installLitecli(pm)
                if (result.success) {
                  console.log(uiSuccess('litecli installed successfully!'))
                  console.log()
                } else {
                  console.error(
                    uiError(`Failed to install litecli: ${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('Manual installation:'))
                  for (const instruction of getLitecliManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('No supported package manager found'))
                console.log()
                console.log(chalk.gray('Manual installation:'))
                for (const instruction of getLitecliManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('litecli is not installed'))
              console.log()
              console.log(
                chalk.gray('Install litecli for enhanced SQLite shell:'),
              )
              console.log(chalk.cyan('  spindb connect --install-litecli'))
              console.log()
              console.log(chalk.gray('Or install manually:'))
              for (const instruction of getLitecliManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        const useIredis = options.iredis || options.installIredis
        if (useIredis) {
          if (engineName !== Engine.Redis) {
            console.error(
              uiError('iredis is only available for Redis containers'),
            )
            if (engineName === 'postgresql') {
              console.log(
                chalk.gray('For PostgreSQL, use: spindb connect --pgcli'),
              )
            } else if (engineName === 'mysql') {
              console.log(chalk.gray('For MySQL, use: spindb connect --mycli'))
            } else if (engineName === Engine.SQLite) {
              console.log(
                chalk.gray('For SQLite, use: spindb connect --litecli'),
              )
            }
            process.exit(1)
          }

          const iredisInstalled = await isIredisInstalled()

          if (!iredisInstalled) {
            if (options.installIredis) {
              console.log(
                uiInfo('Installing iredis for enhanced Redis shell...'),
              )
              const pm = await detectPackageManager()
              if (pm) {
                const result = await installIredis(pm)
                if (result.success) {
                  console.log(uiSuccess('iredis installed successfully!'))
                  console.log()
                } else {
                  console.error(
                    uiError(`Failed to install iredis: ${result.error}`),
                  )
                  console.log()
                  console.log(chalk.gray('Manual installation:'))
                  for (const instruction of getIredisManualInstructions()) {
                    console.log(chalk.cyan(`  ${instruction}`))
                  }
                  process.exit(1)
                }
              } else {
                console.error(uiError('No supported package manager found'))
                console.log()
                console.log(chalk.gray('Manual installation:'))
                for (const instruction of getIredisManualInstructions()) {
                  console.log(chalk.cyan(`  ${instruction}`))
                }
                process.exit(1)
              }
            } else {
              console.error(uiError('iredis is not installed'))
              console.log()
              console.log(
                chalk.gray('Install iredis for enhanced Redis shell:'),
              )
              console.log(chalk.cyan('  spindb connect --install-iredis'))
              console.log()
              console.log(chalk.gray('Or install manually:'))
              for (const instruction of getIredisManualInstructions()) {
                console.log(chalk.cyan(`  ${instruction}`))
              }
              process.exit(1)
            }
          }
        }

        const useDblab = options.dblab || options.installDblab
        if (useDblab) {
          if (!DBLAB_ENGINES.has(engineName)) {
            console.error(
              uiError(`dblab is not supported for ${engineName} containers`),
            )
            process.exit(1)
          }

          let dblabPath = await configManager.getBinaryPath('dblab')

          if (!dblabPath) {
            if (options.installDblab) {
              dblabPath = await downloadDblabCli()
              if (!dblabPath) {
                process.exit(1)
              }
            } else {
              console.error(uiError('dblab is not installed'))
              console.log()
              console.log(chalk.gray('Download dblab:'))
              console.log(chalk.cyan('  spindb connect --install-dblab'))
              console.log()
              console.log(chalk.gray('Or download manually from:'))
              console.log(
                chalk.cyan('  https://github.com/danvergara/dblab/releases'),
              )
              process.exit(1)
            }
          }

          const dblabArgs = getDblabArgs(config, database)
          const dblabProcess = spawn(dblabPath, dblabArgs, {
            stdio: 'inherit',
          })

          await new Promise<void>((resolve) => {
            dblabProcess.on('error', (err: NodeJS.ErrnoException) => {
              if (err.code === 'ENOENT') {
                console.log(uiWarning('dblab not found.'))
                console.log(chalk.gray('  Download it with:'))
                console.log(chalk.cyan('  spindb connect --install-dblab'))
              } else {
                console.error(uiError(err.message))
              }
              resolve()
            })
            dblabProcess.on('close', () => resolve())
          })

          return
        }

        console.log(uiInfo(`Connecting to ${containerName}:${database}...`))
        console.log()

        let clientCmd: string
        let clientArgs: string[]

        if (useLitecli) {
          clientCmd = 'litecli'
          clientArgs = [config.database]
        } else if (useIredis) {
          clientCmd = 'iredis'
          clientArgs = [
            '-h',
            '127.0.0.1',
            '-p',
            String(config.port),
            '-n',
            database,
          ]
        } else if (usePgcli) {
          clientCmd = 'pgcli'
          clientArgs = [connectionString]
        } else if (useMycli) {
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
          clientCmd = 'usql'
          clientArgs = [connectionString]
        } else if (engineName === Engine.SQLite) {
          clientCmd = 'sqlite3'
          clientArgs = [config.database]
        } else if (engineName === Engine.Redis) {
          clientCmd = 'redis-cli'
          clientArgs = [
            '-h',
            '127.0.0.1',
            '-p',
            String(config.port),
            '-n',
            database,
          ]
        } else if (engineName === 'mysql') {
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
          clientCmd = 'psql'
          clientArgs = [connectionString]
        }

        const clientProcess = spawn(clientCmd, clientArgs, {
          stdio: 'inherit',
        })

        clientProcess.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            console.log(uiWarning(`${clientCmd} not found on your system.`))
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
            } else if (clientCmd === 'litecli') {
              console.log(chalk.gray('  Install litecli:'))
              console.log(chalk.cyan('  brew install litecli'))
            } else if (clientCmd === 'iredis') {
              console.log(chalk.gray('  Install iredis:'))
              console.log(chalk.cyan('  pip install iredis'))
            } else if (clientCmd === 'redis-cli') {
              console.log(chalk.gray('  Install Redis:'))
              console.log(chalk.cyan('  brew install redis'))
            } else if (clientCmd === 'sqlite3') {
              console.log(chalk.gray('  sqlite3 comes with macOS.'))
              console.log(chalk.gray('  If not available, check your PATH.'))
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
            console.error(uiError(err.message))
          }
        })

        await new Promise<void>((resolve) => {
          clientProcess.on('close', () => resolve())
        })
      } catch (error) {
        const e = error as Error
        console.error(uiError(e.message))
        process.exit(1)
      }
    },
  )
