/**
 * Which Command
 *
 * Find a SpinDB container by port number or connection URL.
 * Useful for scripting when you need to find which container matches
 * a DATABASE_URL or port.
 *
 * Usage:
 *   spindb which --port 5432           # Find container on port 5432
 *   spindb which --url "$DATABASE_URL" # Find container matching URL
 *   spindb which --port 5432 --json    # JSON output for scripting
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { containerManager } from '../../core/container-manager'
import { uiError } from '../ui/theme'
import { Engine } from '../../types'

/**
 * Parse a database connection URL and extract host, port, and engine type.
 * Returns null for invalid URLs or unrecognized protocols without explicit port.
 */
function parseConnectionUrl(url: string): {
  host: string
  port: number
  engine?: Engine
  unsupportedProtocol?: string
} | null {
  try {
    const parsed = new URL(url)

    // If URL has explicit port, use it
    if (parsed.port) {
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port, 10),
        engine: getEngineFromProtocol(parsed.protocol),
      }
    }

    // No explicit port - need a recognized protocol to infer default
    const defaultPort = getDefaultPort(parsed.protocol)
    if (defaultPort === undefined) {
      // Return with flag indicating unsupported protocol
      return {
        host: parsed.hostname,
        port: 0, // Will be caught by caller
        unsupportedProtocol: parsed.protocol.replace(/:$/, ''),
      }
    }

    return {
      host: parsed.hostname,
      port: defaultPort,
      engine: getEngineFromProtocol(parsed.protocol),
    }
  } catch {
    return null
  }
}

/**
 * Get default port for a database protocol.
 * Returns undefined for unrecognized protocols.
 */
function getDefaultPort(protocol: string): number | undefined {
  const defaults: Record<string, number> = {
    'postgresql:': 5432,
    'postgres:': 5432,
    'mysql:': 3306,
    'mongodb:': 27017,
    'redis:': 6379,
  }
  return defaults[protocol]
}

/**
 * Get engine type from URL protocol
 */
function getEngineFromProtocol(protocol: string): Engine | undefined {
  const mapping: Record<string, Engine> = {
    'postgresql:': Engine.PostgreSQL,
    'postgres:': Engine.PostgreSQL,
    'mysql:': Engine.MySQL,
    'mongodb:': Engine.MongoDB,
    'redis:': Engine.Redis,
  }
  return mapping[protocol]
}

export const whichCommand = new Command('which')
  .description('Find container by port or connection URL')
  .option('-p, --port <port>', 'Find container by port number')
  .option('-u, --url <url>', 'Find container by connection URL')
  .option(
    '-e, --engine <engine>',
    'Filter by engine type (postgresql, mysql, etc.)',
  )
  .option('-r, --running', 'Only match running containers')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (options: {
      port?: string
      url?: string
      engine?: string
      running?: boolean
      json?: boolean
    }) => {
      try {
        // Must specify either --port or --url
        if (!options.port && !options.url) {
          const errorMsg = 'Must specify either --port or --url'
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }, null, 2))
          } else {
            console.error(uiError(errorMsg))
            console.log(chalk.dim('  Usage: spindb which --port 5432'))
            console.log(
              chalk.dim('         spindb which --url "$DATABASE_URL"'),
            )
          }
          process.exit(1)
        }

        // Parse the port/URL to find what we're looking for
        let targetPort: number | undefined
        let targetEngine: Engine | undefined

        if (options.url) {
          const parsed = parseConnectionUrl(options.url)
          if (!parsed) {
            const errorMsg = `Invalid connection URL: ${options.url}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }

          // Check for unsupported protocol
          if (parsed.unsupportedProtocol) {
            const errorMsg = `Unsupported protocol "${parsed.unsupportedProtocol}". Supported: postgresql, mysql, mongodb, redis (or specify port explicitly)`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }

          // Only match localhost URLs
          if (parsed.host !== 'localhost' && parsed.host !== '127.0.0.1') {
            const errorMsg = `URL must point to localhost, got: ${parsed.host}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }

          targetPort = parsed.port
          targetEngine = parsed.engine
        } else if (options.port) {
          targetPort = parseInt(options.port, 10)
          if (isNaN(targetPort)) {
            const errorMsg = `Invalid port number: ${options.port}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        // Override engine if explicitly specified
        if (options.engine) {
          const engineLower = options.engine.toLowerCase()
          const engineMap: Record<string, Engine> = {
            postgresql: Engine.PostgreSQL,
            postgres: Engine.PostgreSQL,
            pg: Engine.PostgreSQL,
            mysql: Engine.MySQL,
            mariadb: Engine.MariaDB,
            mongodb: Engine.MongoDB,
            mongo: Engine.MongoDB,
            redis: Engine.Redis,
            valkey: Engine.Valkey,
            clickhouse: Engine.ClickHouse,
            qdrant: Engine.Qdrant,
            meilisearch: Engine.Meilisearch,
            couchdb: Engine.CouchDB,
            cockroachdb: Engine.CockroachDB,
            crdb: Engine.CockroachDB,
            surrealdb: Engine.SurrealDB,
            surreal: Engine.SurrealDB,
            questdb: Engine.QuestDB,
            quest: Engine.QuestDB,
            ferretdb: Engine.FerretDB,
            ferret: Engine.FerretDB,
          }
          targetEngine = engineMap[engineLower]
          if (!targetEngine) {
            const validEngines = [
              ...new Set(Object.keys(engineMap).sort()),
            ].join(', ')
            const errorMsg = `Invalid engine "${options.engine}". Valid options: ${validEngines}`
            if (options.json) {
              console.log(JSON.stringify({ error: errorMsg }, null, 2))
            } else {
              console.error(uiError(errorMsg))
            }
            process.exit(1)
          }
        }

        // Get all containers and find matching one
        const containers = await containerManager.list()

        const match = containers.find((c) => {
          // Port must match
          if (targetPort !== undefined && c.port !== targetPort) {
            return false
          }

          // Engine must match if specified
          if (targetEngine && c.engine !== targetEngine) {
            return false
          }

          // Running filter
          if (options.running && c.status !== 'running') {
            return false
          }

          return true
        })

        if (!match) {
          const criteria: string[] = []
          if (targetPort) criteria.push(`port ${targetPort}`)
          if (targetEngine) criteria.push(`engine ${targetEngine}`)
          if (options.running) criteria.push('running')

          const errorMsg = `No container found matching: ${criteria.join(', ')}`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg, found: false }, null, 2))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // Output result
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                found: true,
                name: match.name,
                engine: match.engine,
                version: match.version,
                port: match.port,
                status: match.status,
                database: match.database,
              },
              null,
              2,
            ),
          )
        } else {
          // Simple output: just the container name (useful for $() substitution)
          console.log(match.name)
        }
      } catch (error) {
        const e = error as Error
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }, null, 2))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
