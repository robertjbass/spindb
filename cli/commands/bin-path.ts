/**
 * Bin Path Command
 *
 * Resolve the absolute path to an engine's binary tool.
 * Designed for scripting — outputs just the path for $() substitution.
 *
 * Note: Tool resolution is global, not version-scoped. If multiple versions
 * of an engine are installed, the path returned is whichever version was
 * registered most recently (typically the latest download). Tools shared
 * between engines (e.g., mongosh for both MongoDB and FerretDB) resolve
 * to the same binary regardless of which engine is specified.
 *
 * Usage:
 *   spindb bin-path postgresql                   # Default tool (psql)
 *   spindb bin-path postgresql --tool pg_dump     # Specific tool
 *   spindb bin-path redis --tool redis-server     # Server binary
 *   spindb bin-path postgresql --json             # JSON output for scripting
 */

import { Command } from 'commander'
import { Engine, ALL_ENGINES } from '../../types'
import { getEngineConfig } from '../../config/engines-registry'
import { findBinary } from '../../core/dependency-manager'
import { configManager } from '../../core/config-manager'
import { uiError } from '../ui/theme'

const ENGINE_ALIASES: Record<string, Engine> = {
  pg: Engine.PostgreSQL,
  postgres: Engine.PostgreSQL,
  mysql: Engine.MySQL,
  maria: Engine.MariaDB,
  mongo: Engine.MongoDB,
  cockroach: Engine.CockroachDB,
  crdb: Engine.CockroachDB,
  surreal: Engine.SurrealDB,
  ferret: Engine.FerretDB,
  quest: Engine.QuestDB,
  meili: Engine.Meilisearch,
  couch: Engine.CouchDB,
  influx: Engine.InfluxDB,
  weav: Engine.Weaviate,
  tb: Engine.TigerBeetle,
  lsql: Engine.LibSQL,
}

function resolveEngine(input: string): Engine | null {
  const normalized = input.toLowerCase()
  const values = Object.values(Engine) as string[]
  if (values.includes(normalized)) {
    return normalized as Engine
  }
  return ENGINE_ALIASES[normalized] ?? null
}

function exitWithError(msg: string, json?: boolean): never {
  if (json) {
    console.log(JSON.stringify({ error: msg }, null, 2))
  } else {
    console.error(uiError(msg))
  }
  process.exit(1)
}

export const binPathCommand = new Command('bin-path')
  .description('Output the absolute path to an engine binary')
  .argument('<engine>', 'Engine name (e.g., postgresql, redis, mongodb)')
  .option(
    '-t, --tool <tool>',
    'Specific binary tool (defaults to first client tool)',
  )
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      engineInput: string,
      options: {
        tool?: string
        json?: boolean
      },
    ) => {
      try {
        const engine = resolveEngine(engineInput)
        if (!engine) {
          const validEngines = ALL_ENGINES.join(', ')
          exitWithError(
            `Unknown engine "${engineInput}". Valid engines: ${validEngines}`,
            options.json,
          )
        }

        const engineConfig = await getEngineConfig(engine)
        const toolName = options.tool ?? engineConfig.clientTools[0]

        if (!toolName) {
          exitWithError(
            `Engine "${engine}" has no registered client tools. This engine uses a REST API — use spindb connect instead.`,
            options.json,
          )
        }

        // Verify the requested tool belongs to this engine
        if (options.tool && !engineConfig.clientTools.includes(options.tool)) {
          const validTools = engineConfig.clientTools.join(', ')
          exitWithError(
            `Tool "${options.tool}" is not a known tool for ${engine}. Available: ${validTools}`,
            options.json,
          )
        }

        // Ensure bundled binaries are registered before lookup
        await configManager.scanInstalledBinaries()

        const result = await findBinary(toolName)

        if (!result) {
          exitWithError(
            `${toolName} not found. Run: spindb engines download ${engine}`,
            options.json,
          )
        }

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                engine,
                tool: toolName,
                path: result.path,
                version: result.version ?? null,
              },
              null,
              2,
            ),
          )
          return
        }

        // Plain output: just the path (useful for $() substitution)
        process.stdout.write(result.path)
        if (process.stdout.isTTY) {
          console.log()
        }
      } catch (error) {
        const e = error as Error
        exitWithError(e.message, options.json)
      }
    },
  )
