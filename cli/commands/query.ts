import { Command } from 'commander'
import { existsSync } from 'fs'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { promptInstallDependencies } from '../ui/prompts'
import { uiError, uiWarning } from '../ui/theme'
import { getMissingDependencies } from '../../core/dependency-manager'
import {
  Engine,
  isFileBasedEngine,
  isRemoteContainer,
  type QueryOptions,
  type QueryResult,
} from '../../types'
import { loadCredentials } from '../../core/credential-manager'
import { parseConnectionString } from '../../core/remote-container'

/**
 * Format a QueryResult as a table for terminal output
 */
function formatTable(result: QueryResult): string {
  if (result.columns.length === 0 || result.rows.length === 0) {
    return '(0 rows)'
  }

  // Calculate column widths
  const widths: number[] = result.columns.map((col) => col.length)

  for (const row of result.rows) {
    for (let i = 0; i < result.columns.length; i++) {
      const col = result.columns[i]
      const value = formatValue(row[col])
      widths[i] = Math.max(widths[i], value.length)
    }
  }

  // Build header
  const header = result.columns
    .map((col, i) => col.padEnd(widths[i]))
    .join(' | ')

  // Build separator
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-')

  // Build rows
  const rows = result.rows.map((row) =>
    result.columns
      .map((col, i) => formatValue(row[col]).padEnd(widths[i]))
      .join(' | '),
  )

  // Combine
  const lines = [header, separator, ...rows]

  // Add row count
  const countMsg =
    result.rowCount === 1 ? '(1 row)' : `(${result.rowCount} rows)`
  lines.push('')
  lines.push(countMsg)

  return lines.join('\n')
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

export const queryCommand = new Command('query')
  .description('Execute a query and return results')
  .argument('<name>', 'Container name')
  .argument('<query>', 'Query to execute')
  .option('-d, --database <name>', 'Target database (defaults to primary)')
  .option('--json', 'Output results as JSON')
  .action(
    async (
      name: string,
      query: string,
      options: { database?: string; json?: boolean },
    ) => {
      try {
        const containerName = name

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

        const { engine: engineName } = config

        // Build remote query options if this is a linked container
        let remoteQueryOptions: QueryOptions | undefined
        if (isRemoteContainer(config)) {
          const creds = await loadCredentials(
            containerName,
            engineName,
            'remote',
          )
          if (!creds?.connectionString) {
            const errorMsg = `No credentials found for remote container "${containerName}". Try re-linking with: spindb link`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }

          const parsed = parseConnectionString(creds.connectionString)
          remoteQueryOptions = {
            host: parsed.host,
            password: parsed.password,
            username: parsed.username,
            ssl: config.remote?.ssl,
            scheme: parsed.scheme,
          }
          // Override port if the connection string specifies one
          if (parsed.port) {
            config.port = parsed.port
          }
        } else if (isFileBasedEngine(engineName)) {
          // File-based databases: check file exists instead of running status
          if (!existsSync(config.database)) {
            if (options.json) {
              console.log(
                JSON.stringify({
                  error: `Database file not found: ${config.database}`,
                }),
              )
            } else {
              console.error(
                uiError(`Database file not found: ${config.database}`),
              )
            }
            process.exit(1)
          }
        } else {
          // Server databases need to be running
          const running = await processManager.isRunning(containerName, {
            engine: engineName,
          })
          if (!running) {
            if (options.json) {
              console.log(
                JSON.stringify({
                  error: `Container "${containerName}" is not running`,
                }),
              )
            } else {
              console.error(
                uiError(
                  `Container "${containerName}" is not running. Start it first with: spindb start ${containerName}`,
                ),
              )
            }
            process.exit(1)
          }
        }

        const engine = getEngine(engineName)

        let missingDeps = await getMissingDependencies(engineName)
        if (missingDeps.length > 0) {
          if (options.json) {
            console.log(
              JSON.stringify({
                error: `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
              }),
            )
            process.exit(1)
          }

          console.log(
            uiWarning(
              `Missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
            ),
          )

          // Install all missing dependencies
          for (const dep of missingDeps) {
            const installed = await promptInstallDependencies(
              dep.binary,
              engineName,
            )

            if (!installed) {
              process.exit(1)
            }
          }

          missingDeps = await getMissingDependencies(engineName)
          if (missingDeps.length > 0) {
            console.error(
              uiError(
                `Still missing tools: ${missingDeps.map((d) => d.name).join(', ')}`,
              ),
            )
            process.exit(1)
          }

          console.log(chalk.green('  ✓ All required tools are now available'))
          console.log()
        }

        const database = options.database || config.database

        // Execute the query
        const result = await engine.executeQuery(config, query, {
          database,
          ...remoteQueryOptions,
        })

        // Output results
        if (options.json) {
          // JSON mode: output just the rows array
          console.log(JSON.stringify(result.rows, null, 2))
        } else {
          // Table mode
          console.log(formatTable(result))
        }
      } catch (error) {
        const e = error as Error

        // Map of tool patterns to their engines
        const toolPatternToEngine: Record<string, Engine> = {
          'psql not found': Engine.PostgreSQL,
          'mysql not found': Engine.MySQL,
          'mysql client not found': Engine.MySQL,
          'redis-cli not found': Engine.Redis,
          'mongosh not found': Engine.MongoDB,
          'sqlite3 not found': Engine.SQLite,
        }

        const matchingPattern = Object.keys(toolPatternToEngine).find((p) =>
          e.message.toLowerCase().includes(p.toLowerCase()),
        )

        if (matchingPattern && !options.json) {
          const missingTool = matchingPattern
            .replace(' not found', '')
            .replace(' client', '')
          const toolEngine = toolPatternToEngine[matchingPattern]
          const installed = await promptInstallDependencies(
            missingTool,
            toolEngine,
          )
          if (installed) {
            console.log(
              chalk.yellow('  Please re-run your command to continue.'),
            )
          }
          process.exit(1)
        }

        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
