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
import { Engine, type ContainerConfig } from '../../types'

export type WhichSelectCriteria = {
  targetPort?: number
  targetEngine?: Engine
  targetDatabase?: string
  runningOnly?: boolean
}

/**
 * Pick the best-matching container for the given criteria.
 *
 * Multiple containers can legitimately share a port (e.g., one running, others
 * stopped from earlier experiments). Prefer running containers, and if the
 * caller passed a database name, prefer containers that actually host it.
 * Stable — containers that tie on score keep their original order.
 */
export function selectContainerForWhich(
  containers: ContainerConfig[],
  criteria: WhichSelectCriteria,
): ContainerConfig | null {
  const { targetPort, targetEngine, targetDatabase, runningOnly } = criteria

  const candidates = containers.filter((c) => {
    if (targetPort !== undefined && c.port !== targetPort) return false
    if (targetEngine && c.engine !== targetEngine) return false
    if (runningOnly && c.status !== 'running') return false
    return true
  })

  function score(c: ContainerConfig): number {
    let s = 0
    if (c.status === 'running') s += 4
    if (targetDatabase) {
      const hostsTarget =
        c.database === targetDatabase ||
        (c.databases?.includes(targetDatabase) ?? false)
      if (hostsTarget) s += 2
    }
    return s
  }

  // Decorate-sort-undecorate to keep the sort stable across Node versions that
  // previously had unstable Array#sort for equal scores.
  const ranked = candidates
    .map((c, i) => ({ c, i, s: score(c) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)

  return ranked[0]?.c ?? null
}

/**
 * Parse a database connection URL and extract host, port, and engine type.
 * Returns null for invalid URLs or unrecognized protocols without explicit port.
 */
function parseConnectionUrl(url: string): {
  host: string
  port: number
  database?: string
  engine?: Engine
  unsupportedProtocol?: string
} | null {
  try {
    const parsed = new URL(url)
    const database = parsed.pathname.replace(/^\//, '').split('?')[0] || undefined

    // If URL has explicit port, use it
    if (parsed.port) {
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port, 10),
        database,
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
        database,
        unsupportedProtocol: parsed.protocol.replace(/:$/, ''),
      }
    }

    return {
      host: parsed.hostname,
      port: defaultPort,
      database,
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
        let targetDatabase: string | undefined

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
          targetDatabase = parsed.database
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

        const containers = await containerManager.list()
        const match = selectContainerForWhich(containers, {
          targetPort,
          targetEngine,
          targetDatabase,
          runningOnly: options.running,
        })

        if (!match) {
          const criteria: string[] = []
          if (targetPort) criteria.push(`port ${targetPort}`)
          if (targetEngine) criteria.push(`engine ${targetEngine}`)
          if (options.running) criteria.push('running')

          const errorMsg = `No container found matching: ${criteria.join(', ')}`
          if (options.json) {
            console.log(
              JSON.stringify({ error: errorMsg, found: false }, null, 2),
            )
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
