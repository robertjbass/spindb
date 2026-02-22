import { Command } from 'commander'
import { mkdir } from 'fs/promises'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import {
  parseConnectionString,
  detectEngineFromConnectionString,
  detectProvider,
  generateRemoteContainerName,
  redactConnectionString,
  buildRemoteConfig,
  getDefaultPortForEngine,
  isLocalhost,
} from '../../core/remote-container'
import { saveCredentials } from '../../core/credential-manager'
import { paths } from '../../config/paths'
import { uiSuccess, uiWarning } from '../ui/theme'
import { exitWithError, logDebug } from '../../core/error-handler'
import { getEngineMetadata } from '../helpers'
import { Engine } from '../../types'
import type { ContainerConfig } from '../../types'

/**
 * Validate that the provided engine string is a valid Engine enum value.
 */
function resolveEngine(engineStr: string): Engine | null {
  const normalized = engineStr.toLowerCase()
  const values = Object.values(Engine) as string[]
  if (values.includes(normalized)) {
    return normalized as Engine
  }
  // Common aliases
  const aliases: Record<string, Engine> = {
    pg: Engine.PostgreSQL,
    postgres: Engine.PostgreSQL,
    mongo: Engine.MongoDB,
    mariadb: Engine.MariaDB,
    cockroach: Engine.CockroachDB,
    surreal: Engine.SurrealDB,
  }
  return aliases[normalized] ?? null
}

export const linkCommand = new Command('link')
  .description('Link an external database to SpinDB')
  .argument('<connection-string>', 'Database connection string (URL format)')
  .argument('[name]', 'Container name (auto-generated if omitted)')
  .option('--engine <engine>', 'Engine type (auto-detected from URL scheme)')
  .option('-d, --database <name>', 'Database name (extracted from URL)')
  .option('--provider <name>', 'Provider hint (auto-detected from hostname)')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      connectionString: string,
      nameArg: string | undefined,
      options: {
        engine?: string
        database?: string
        provider?: string
        json?: boolean
      },
    ) => {
      try {
        // Parse the connection string
        let parsed
        try {
          parsed = parseConnectionString(connectionString)
        } catch (error) {
          return exitWithError({
            message: (error as Error).message,
            json: options.json,
          })
        }

        // Detect or validate engine
        let engine: Engine
        if (options.engine) {
          const resolved = resolveEngine(options.engine)
          if (!resolved) {
            return exitWithError({
              message: `Unknown engine: "${options.engine}". Use one of: postgresql, mysql, mongodb, redis, etc.`,
              json: options.json,
            })
          }
          engine = resolved
        } else {
          const detected = detectEngineFromConnectionString(connectionString)
          if (!detected) {
            return exitWithError({
              message:
                'Could not detect engine from connection string scheme. Use --engine to specify.',
              json: options.json,
            })
          }
          engine = detected
        }

        // Extract connection details
        const host = parsed.host
        const port = parsed.port ?? getDefaultPortForEngine(engine)
        const database = options.database ?? parsed.database ?? 'default'

        // Detect provider
        const provider = options.provider ?? detectProvider(host)

        // SpinDB collision check for localhost connections
        if (isLocalhost(host) && port > 0) {
          const containers = await containerManager.list()
          const conflicting = containers.find(
            (c) =>
              c.engine === engine && c.port === port && c.status !== 'linked',
          )
          if (conflicting) {
            return exitWithError({
              message: `Port ${port} is already managed by SpinDB container "${conflicting.name}". Use "spindb connect ${conflicting.name}" instead.`,
              json: options.json,
            })
          }
        }

        // Generate or validate container name
        const containerName =
          nameArg ??
          generateRemoteContainerName({
            engine,
            host,
            database,
            provider,
          })

        // Validate name format
        if (!containerManager.isValidName(containerName)) {
          return exitWithError({
            message: `Invalid container name: "${containerName}". Must start with a letter and contain only letters, numbers, hyphens, underscores.`,
            json: options.json,
          })
        }

        // Check uniqueness within engine namespace
        if (await containerManager.exists(containerName, { engine })) {
          return exitWithError({
            message: `Container "${containerName}" already exists for engine ${engine}. Choose a different name.`,
            json: options.json,
          })
        }

        // Version detection placeholder (requires engine-specific client binaries)
        const detectedVersion = ''

        // Create container directory
        const containerPath = paths.getContainerPath(containerName, {
          engine,
        })
        await mkdir(containerPath, { recursive: true })

        // Build remote config
        const remoteConfig = buildRemoteConfig({
          host,
          connectionString,
          provider,
        })

        // Create container config with 'linked' status
        const config: ContainerConfig = {
          name: containerName,
          engine,
          version: detectedVersion || 'unknown',
          port,
          database,
          databases: [database],
          created: new Date().toISOString(),
          status: 'linked',
          remote: remoteConfig,
        }

        await containerManager.saveConfig(containerName, { engine }, config)

        // Save full connection string via credential manager
        // Always use 'remote' as the credential key for linked containers.
        // The actual DB username is stored in the file content (DB_USER field).
        try {
          await saveCredentials(containerName, engine, {
            username: 'remote',
            password: parsed.password || '',
            connectionString,
            engine,
            container: containerName,
            database,
          })
        } catch (credError) {
          // Credential save failed — warn since the full connection string won't be recoverable
          if (!options.json) {
            console.log(
              uiWarning(
                'Could not save credentials. The full connection string may not be retrievable.',
              ),
            )
          }
          logDebug(`Credential save failed: ${(credError as Error).message}`)
        }

        // Output
        if (options.json) {
          const metadata = await getEngineMetadata(engine)
          console.log(
            JSON.stringify(
              {
                success: true,
                name: containerName,
                engine,
                host,
                port,
                database,
                status: 'linked',
                provider: provider ?? undefined,
                ssl: remoteConfig.ssl,
                connectionString: redactConnectionString(connectionString),
                ...metadata,
              },
              null,
              2,
            ),
          )
        } else {
          console.log()
          console.log(uiSuccess(`Linked remote database as "${containerName}"`))
          console.log()
          console.log(
            chalk.gray('  ') +
              chalk.white('Engine:'.padEnd(14)) +
              chalk.cyan(engine),
          )
          console.log(
            chalk.gray('  ') +
              chalk.white('Host:'.padEnd(14)) +
              chalk.cyan(host),
          )
          console.log(
            chalk.gray('  ') +
              chalk.white('Port:'.padEnd(14)) +
              chalk.green(String(port)),
          )
          console.log(
            chalk.gray('  ') +
              chalk.white('Database:'.padEnd(14)) +
              chalk.yellow(database),
          )
          if (provider) {
            console.log(
              chalk.gray('  ') +
                chalk.white('Provider:'.padEnd(14)) +
                chalk.magenta(provider),
            )
          }
          console.log(
            chalk.gray('  ') +
              chalk.white('SSL:'.padEnd(14)) +
              (remoteConfig.ssl ? chalk.green('yes') : chalk.gray('no')),
          )
          console.log()
          console.log(chalk.gray('  Connection string (redacted):'))
          console.log(
            chalk.cyan(`  ${redactConnectionString(connectionString)}`),
          )
          console.log()
          console.log(chalk.gray('  Connect with:'))
          console.log(chalk.cyan(`  spindb connect ${containerName}`))
          console.log()
        }
      } catch (error) {
        const e = error as Error
        return exitWithError({ message: e.message, json: options.json })
      }
    },
  )
