import { Command } from 'commander'
import { join, resolve } from 'path'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { platformService } from '../../core/platform-service'
import { exportToDocker, getExportBackupPath } from '../../core/docker-exporter'
import { promptContainerSelect, promptConfirm } from '../ui/prompts'
import { createSpinner } from '../ui/spinner'
import { uiSuccess, uiError, uiWarning, box, formatBytes } from '../ui/theme'
import { isFileBasedEngine } from '../../types'
import { getDefaultFormat } from '../../config/backup-formats'
import { getEngineDefaults } from '../../config/engine-defaults'
import { paths } from '../../config/paths'
import { stat, rm } from 'fs/promises'
import { existsSync } from 'fs'
import inquirer from 'inquirer'

export const exportCommand = new Command('export')
  .description('Export container to various formats')
  .addCommand(
    new Command('docker')
      .description('Export container to Docker-ready package')
      .argument('[container]', 'Container name')
      .option(
        '-o, --output <dir>',
        'Output directory (default: ~/.spindb/containers/{engine}/{name}/docker)',
      )
      .option('-p, --port <number>', 'Override external port', parseInt)
      .option('--no-data', 'Skip including database backup')
      .option('--no-tls', 'Skip TLS certificate generation')
      .option('-f, --force', 'Overwrite existing output directory')
      .option('-c, --copy', 'Copy password to clipboard')
      .option('-j, --json', 'Output result as JSON')
      .action(
        async (
          containerArg: string | undefined,
          options: {
            output?: string
            port?: number
            data?: boolean
            tls?: boolean
            force?: boolean
            copy?: boolean
            json?: boolean
          },
        ) => {
          try {
            let containerName = containerArg

            // Select container if not provided
            if (!containerName) {
              if (options.json) {
                console.log(
                  JSON.stringify({ error: 'Container name is required' }),
                )
                process.exit(1)
              }

              const containers = await containerManager.list()

              if (containers.length === 0) {
                console.log(
                  uiWarning(
                    'No containers found. Create one with: spindb create',
                  ),
                )
                return
              }

              const selected = await promptContainerSelect(
                containers,
                'Select container to export:',
              )
              if (!selected) return
              containerName = selected
            }

            // Get container config
            const config = await containerManager.getConfig(containerName)
            if (!config) {
              if (options.json) {
                console.log(
                  JSON.stringify({
                    error: `Container "${containerName}" not found`,
                  }),
                )
              } else {
                console.error(uiError(`Container "${containerName}" not found`))
              }
              process.exit(1)
            }

            const { engine: engineName, version, database, port } = config
            const engine = getEngine(engineName)
            const engineDefaultPort = getEngineDefaults(engineName).defaultPort

            // Default output directory: ~/.spindb/containers/{engine}/{name}/docker
            const defaultOutputDir = join(
              paths.getContainerPath(containerName, { engine: engineName }),
              'docker',
            )
            const outputDir = options.output
              ? resolve(options.output)
              : defaultOutputDir
            const includeData = options.data !== false
            const skipTLS = options.tls === false

            // Determine target port:
            // 1. If user explicitly passed -p, use that
            // 2. If local port matches engine default, use it
            // 3. If interactive mode and ports differ, prompt user
            // 4. In JSON mode, default to engine's standard port
            let targetPort: number
            if (options.port !== undefined) {
              // User explicitly specified a port
              targetPort = options.port
            } else if (port === engineDefaultPort) {
              // Local port matches engine default, no decision needed
              targetPort = engineDefaultPort
            } else if (!options.json) {
              // Interactive mode: prompt user to choose between local and default port
              console.log()
              console.log(
                chalk.yellow(
                  `Local container uses port ${chalk.cyan(String(port))}, but ${engine.displayName}'s standard port is ${chalk.cyan(String(engineDefaultPort))}.`,
                ),
              )
              const { selectedPort } = await inquirer.prompt<{
                selectedPort: number
              }>([
                {
                  type: 'list',
                  name: 'selectedPort',
                  message: 'Which port should the Docker container use?',
                  choices: [
                    {
                      name: `${engineDefaultPort} ${chalk.gray('(standard port - recommended)')}`,
                      value: engineDefaultPort,
                    },
                    {
                      name: `${port} ${chalk.gray('(same as local container)')}`,
                      value: port,
                    },
                  ],
                  default: engineDefaultPort,
                },
              ])
              targetPort = selectedPort
            } else {
              // JSON mode: default to standard port
              targetPort = engineDefaultPort
            }

            // Check if output directory already exists
            if (existsSync(outputDir)) {
              let shouldOverwrite = options.force

              if (!shouldOverwrite && !options.json) {
                // Interactive prompt to confirm overwrite
                console.log()
                console.log(
                  uiWarning(`Output directory already exists: ${outputDir}`),
                )
                shouldOverwrite = await promptConfirm(
                  'Do you want to overwrite it?',
                  false, // Default to No for safety
                )
              }

              if (shouldOverwrite) {
                // Remove existing directory
                await rm(outputDir, { recursive: true, force: true })
              } else {
                if (options.json) {
                  console.log(
                    JSON.stringify({
                      error: `Output directory already exists: ${outputDir}`,
                    }),
                  )
                } else {
                  console.log(
                    uiError(
                      'Export cancelled. Use --force to overwrite or --output to specify a different path.',
                    ),
                  )
                }
                process.exit(1)
              }
            }

            // For server-based engines with data, check if container is running
            let backupPath: string | undefined
            if (includeData && !isFileBasedEngine(engineName)) {
              const running = await processManager.isRunning(containerName, {
                engine: engineName,
              })

              if (!running) {
                if (options.json) {
                  console.log(
                    JSON.stringify({
                      error: `Container "${containerName}" is not running. Start it first to export with data.`,
                    }),
                  )
                } else {
                  console.error(
                    uiError(
                      `Container "${containerName}" is not running.\nStart it first with: spindb start ${containerName}`,
                    ),
                  )
                }
                process.exit(1)
              }
            }

            if (!options.json) {
              console.log()
              console.log(
                chalk.bold(
                  `Exporting ${chalk.cyan(containerName)} to Docker...`,
                ),
              )
              console.log()
            }

            // Step 1: Create backup if including data
            if (includeData) {
              const backupSpinner = options.json
                ? null
                : createSpinner('Creating database backup...')
              backupSpinner?.start()

              try {
                // Create a temporary backup
                const tempBackupPath = getExportBackupPath(
                  outputDir,
                  containerName,
                  database,
                  engineName,
                )

                // Create parent directory for backup
                const { mkdir } = await import('fs/promises')
                await mkdir(join(outputDir, 'data'), { recursive: true })

                // Create backup using engine's backup method
                const format = getDefaultFormat(engineName)
                const result = await engine.backup(config, tempBackupPath, {
                  database,
                  format,
                })

                backupPath = result.path

                const backupStat = await stat(result.path)
                backupSpinner?.succeed(
                  `Backup created (${formatBytes(backupStat.size)})`,
                )
              } catch (error) {
                const e = error as Error
                backupSpinner?.fail('Backup failed')

                if (options.json) {
                  console.log(JSON.stringify({ error: e.message }))
                } else {
                  console.error(uiError(e.message))
                }
                process.exit(1)
              }
            }

            // Step 2: Generate Docker artifacts
            const exportSpinner = options.json
              ? null
              : createSpinner('Generating Docker artifacts...')
            exportSpinner?.start()

            const result = await exportToDocker(config, {
              outputDir,
              port: targetPort,
              includeData,
              backupPath,
              skipTLS,
            })

            exportSpinner?.succeed('Docker artifacts generated')

            // Copy password to clipboard if requested
            if (options.copy) {
              const copied = await platformService.copyToClipboard(
                result.credentials.password,
              )
              if (copied && !options.json) {
                console.log(uiSuccess('Password copied to clipboard'))
              }
            }

            // Output results
            if (options.json) {
              console.log(
                JSON.stringify({
                  success: true,
                  outputDir: result.outputDir,
                  engine: result.engine,
                  version: result.version,
                  port: result.port,
                  database: result.database,
                  username: result.credentials.username,
                  password: result.credentials.password,
                  files: result.files,
                }),
              )
            } else {
              console.log()
              console.log(
                uiSuccess(`Exported ${chalk.cyan(containerName)} to Docker`),
              )
              console.log()

              // Display summary box
              const lines = [
                `${chalk.bold(engine.displayName)} ${version}`,
                `Port: ${chalk.green(String(targetPort))}`,
                `Database: ${chalk.cyan(database)}`,
                '',
                chalk.bold('Generated Credentials'),
                chalk.gray('────────────────────────'),
                `Username: ${chalk.white(result.credentials.username)}`,
                `Password: ${chalk.white(result.credentials.password)}`,
                chalk.gray('────────────────────────'),
                '',
                chalk.yellow('Save these credentials now - stored in .env'),
              ]

              console.log(box(lines))
              console.log()
              console.log(chalk.gray('  Output:'), chalk.cyan(result.outputDir))
              console.log()
              console.log(chalk.bold('  To run:'))
              console.log(
                chalk.cyan(
                  `    cd "${result.outputDir}" && docker-compose up -d`,
                ),
              )
              console.log()
            }
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
      ),
  )
