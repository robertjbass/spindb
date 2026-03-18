/**
 * Bin Path Command
 *
 * Resolve the absolute path to an engine's binary tool.
 * Designed for scripting — outputs just the path for $() substitution.
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
  mongo: Engine.MongoDB,
  cockroach: Engine.CockroachDB,
  crdb: Engine.CockroachDB,
  surreal: Engine.SurrealDB,
  ferret: Engine.FerretDB,
  quest: Engine.QuestDB,
}

function resolveEngine(input: string): Engine | null {
  const normalized = input.toLowerCase()
  const values = Object.values(Engine) as string[]
  if (values.includes(normalized)) {
    return normalized as Engine
  }
  return ENGINE_ALIASES[normalized] ?? null
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
          const errorMsg = `Unknown engine "${engineInput}". Valid engines: ${validEngines}`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        const engineConfig = await getEngineConfig(engine)
        const toolName = options.tool ?? engineConfig.clientTools[0]

        if (!toolName) {
          const errorMsg = `Engine "${engine}" has no registered client tools`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // Verify the requested tool belongs to this engine
        if (options.tool && !engineConfig.clientTools.includes(options.tool)) {
          const validTools = engineConfig.clientTools.join(', ')
          const errorMsg = `Tool "${options.tool}" is not a known tool for ${engine}. Available: ${validTools}`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
        }

        // Ensure bundled binaries are registered before lookup
        await configManager.scanInstalledBinaries()

        const result = await findBinary(toolName)

        if (!result) {
          const errorMsg = `${toolName} not found. Run: spindb engines download ${engine}`
          if (options.json) {
            console.log(JSON.stringify({ error: errorMsg }))
          } else {
            console.error(uiError(errorMsg))
          }
          process.exit(1)
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
        if (options.json) {
          console.log(JSON.stringify({ error: e.message }))
        } else {
          console.error(uiError(e.message))
        }
        process.exit(1)
      }
    },
  )
