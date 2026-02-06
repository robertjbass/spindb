import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { generatePassword } from '../../core/credential-generator'
import {
  saveCredentials,
  listCredentials,
  credentialsExist,
  getDefaultUsername,
} from '../../core/credential-manager'
import {
  assertValidUsername,
  UnsupportedOperationError,
} from '../../core/error-handler'
import { platformService } from '../../core/platform-service'
import { isFileBasedEngine } from '../../types'
import { uiError, uiSuccess, uiWarning } from '../ui/theme'

export const usersCommand = new Command('users').description(
  'Manage database users and credentials',
)

usersCommand
  .command('create')
  .description('Create a database user')
  .argument('<container>', 'Container name')
  .argument('[username]', 'Username to create')
  .option('-p, --password <password>', 'Use specific password')
  .option('-d, --database <database>', 'Target database for grants')
  .option('-c, --copy', 'Copy connection string to clipboard')
  .option('-j, --json', 'Output as JSON')
  .option('--no-save', 'Do not save credentials to disk')
  .option('--force', 'Overwrite existing credential file')
  .action(
    async (
      containerName: string,
      username: string | undefined,
      options: {
        password?: string
        database?: string
        copy?: boolean
        json?: boolean
        save: boolean
        force?: boolean
      },
    ) => {
      try {
        const config = await containerManager.getConfig(containerName)
        if (!config) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error: `Container "${containerName}" not found`,
              }),
            )
          } else {
            console.error(
              uiError(
                `Container "${containerName}" not found. Run "spindb list" to see available containers.`,
              ),
            )
          }
          process.exit(1)
        }

        const engineName = config.engine

        // Check container is running (skip for file-based engines)
        if (!isFileBasedEngine(engineName)) {
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            const errorMsg = `Container "${containerName}" is not running. Start it with: spindb start ${containerName}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        // Use default username if none provided
        const resolvedUsername = username || getDefaultUsername(config.engine)

        assertValidUsername(resolvedUsername)

        const engine = getEngine(engineName)

        // Generate or use provided password
        const password =
          options.password ||
          generatePassword({ length: 20, alphanumericOnly: true })

        const database = options.database || config.database

        // Check if credential file already exists
        if (
          options.save &&
          !options.force &&
          credentialsExist(containerName, engineName, resolvedUsername)
        ) {
          const errorMsg = `Credential file already exists for "${resolvedUsername}" in "${containerName}". Use --force to overwrite.`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // Create the user in the database
        const credentials = await engine.createUser(config, {
          username: resolvedUsername,
          password,
          database,
        })

        // Save credentials to disk
        let credentialFile: string | undefined
        if (options.save) {
          credentialFile = await saveCredentials(
            containerName,
            engineName,
            credentials,
          )
        }

        // Output results
        if (options.json) {
          const result: Record<string, unknown> = {
            username: credentials.username,
            password: credentials.password,
            database: credentials.database,
            connectionString: credentials.connectionString,
          }
          if (credentials.apiKey) {
            result.apiKey = credentials.apiKey
          }
          if (credentialFile) {
            result.credentialFile = credentialFile
          }
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log()
          console.log(uiSuccess(`Created user "${resolvedUsername}"`))
          console.log()
          if (credentials.apiKey) {
            console.log(`  ${chalk.gray('Key name:')}  ${credentials.username}`)
            console.log(`  ${chalk.gray('API key:')}   ${credentials.apiKey}`)
            console.log(
              `  ${chalk.gray('API URL:')}   ${credentials.connectionString}`,
            )
          } else {
            console.log(`  ${chalk.gray('Username:')}  ${credentials.username}`)
            console.log(`  ${chalk.gray('Password:')}  ${credentials.password}`)
            if (credentials.database) {
              console.log(
                `  ${chalk.gray('Database:')}  ${credentials.database}`,
              )
            }
            console.log(
              `  ${chalk.gray('URL:')}       ${credentials.connectionString}`,
            )
          }
          if (credentialFile) {
            console.log()
            console.log(`  ${chalk.gray('Saved to:')} ${credentialFile}`)
          }
          console.log()
        }

        // Copy to clipboard if requested
        if (options.copy) {
          const textToCopy = credentials.apiKey || credentials.connectionString
          const copied = await platformService.copyToClipboard(textToCopy)
          if (!options.json) {
            if (copied) {
              console.log(
                uiSuccess(
                  credentials.apiKey
                    ? 'API key copied to clipboard'
                    : 'Connection string copied to clipboard',
                ),
              )
            } else {
              console.log(uiWarning('Could not copy to clipboard'))
            }
          }
        }
      } catch (error) {
        if (error instanceof UnsupportedOperationError) {
          const msg = `User management is not supported for this engine`
          if (options.json) {
            console.log(JSON.stringify({ error: msg }))
          } else {
            console.error(uiError(msg))
          }
          process.exit(1)
        }
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

usersCommand
  .command('list')
  .description('List saved credentials for a container')
  .argument('<container>', 'Container name')
  .option('-j, --json', 'Output as JSON')
  .action(async (containerName: string, options: { json?: boolean }) => {
    try {
      const config = await containerManager.getConfig(containerName)
      if (!config) {
        if (options.json) {
          console.log(
            JSON.stringify({ error: `Container "${containerName}" not found` }),
          )
        } else {
          console.error(uiError(`Container "${containerName}" not found`))
        }
        process.exit(1)
      }

      const usernames = await listCredentials(containerName, config.engine)

      if (options.json) {
        console.log(
          JSON.stringify(
            { container: containerName, users: usernames },
            null,
            2,
          ),
        )
      } else {
        if (usernames.length === 0) {
          console.log()
          console.log(chalk.gray(`No saved credentials for "${containerName}"`))
          console.log(
            chalk.gray(
              `  Create one with: spindb users create ${containerName} <username>`,
            ),
          )
          console.log()
        } else {
          console.log()
          console.log(chalk.bold(`Saved credentials for "${containerName}":`))
          for (const user of usernames) {
            console.log(`  ${chalk.cyan(user)}`)
          }
          console.log()
        }
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
  })
