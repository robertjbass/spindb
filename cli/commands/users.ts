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

function exitWithError(message: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: message }))
  } else {
    console.error(uiError(message))
  }
  process.exit(1)
}

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
          exitWithError(
            `Container "${containerName}" not found. Run "spindb list" to see available containers.`,
            options.json,
          )
        }

        const engineName = config.engine

        // Check container is running (skip for file-based engines)
        if (!isFileBasedEngine(engineName)) {
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            exitWithError(
              `Container "${containerName}" is not running. Start it with: spindb start ${containerName}`,
              options.json,
            )
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
          exitWithError(
            `Credential file already exists for "${resolvedUsername}" in "${containerName}". Use --force to overwrite.`,
            options.json,
          )
        }

        // Create the user in the database
        const credentials = await engine.createUser(config, {
          username: resolvedUsername,
          password,
          database,
        })

        // Save credentials to disk (non-fatal — credentials are already created)
        let credentialFile: string | undefined
        if (options.save) {
          try {
            credentialFile = await saveCredentials(
              containerName,
              engineName,
              credentials,
            )
          } catch (error) {
            if (!options.json) {
              console.error(
                uiWarning(
                  `Could not save credentials to disk: ${(error as Error).message}`,
                ),
              )
            }
            process.exitCode = 1
          }
        }

        // Copy to clipboard before output so JSON includes the status
        let clipboardCopied: boolean | undefined
        if (options.copy) {
          const textToCopy = credentials.apiKey || credentials.connectionString
          if (textToCopy) {
            clipboardCopied = await platformService.copyToClipboard(textToCopy)
          }
        }

        // Output results
        if (options.json) {
          const result: Record<string, unknown> = {
            username: credentials.username,
            password: credentials.password,
            ...(credentials.database != null && {
              database: credentials.database,
            }),
            connectionString: credentials.connectionString,
            ...(credentials.apiKey != null && { apiKey: credentials.apiKey }),
            ...(credentialFile != null && {
              credentialFile,
            }),
            ...(clipboardCopied !== undefined && { clipboardCopied }),
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

          // Show clipboard status in human-readable output
          if (clipboardCopied !== undefined) {
            if (clipboardCopied) {
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
          exitWithError(
            'User management is not supported for this engine',
            options.json,
          )
        }
        exitWithError((error as Error).message, options.json)
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
        exitWithError(`Container "${containerName}" not found`, options.json)
      }

      const usernames = await listCredentials(containerName, config.engine)

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              container: containerName,
              engine: config.engine,
              users: usernames,
            },
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
      exitWithError((error as Error).message, options.json)
    }
  })
