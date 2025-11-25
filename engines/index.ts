import { postgresqlEngine } from './postgresql'
import type { BaseEngine } from './base-engine'
import type { EngineInfo } from '../types'

/**
 * Registry of available database engines
 */
export const engines: Record<string, BaseEngine> = {
  postgresql: postgresqlEngine,
  postgres: postgresqlEngine, // Alias
  pg: postgresqlEngine, // Alias
}

/**
 * Get an engine by name
 */
export function getEngine(name: string): BaseEngine {
  const engine = engines[name.toLowerCase()]
  if (!engine) {
    const available = [...new Set(Object.values(engines))].map((e) => e.name)
    throw new Error(
      `Unknown engine "${name}". Available: ${available.join(', ')}`,
    )
  }
  return engine
}

/**
 * List all available engines
 */
export function listEngines(): EngineInfo[] {
  // Return unique engines (filter out aliases)
  const seen = new Set<BaseEngine>()
  return Object.entries(engines)
    .filter(([, engine]) => {
      if (seen.has(engine)) return false
      seen.add(engine)
      return true
    })
    .map(([, engine]) => ({
      name: engine.name,
      displayName: engine.displayName,
      defaultPort: engine.defaultPort,
      supportedVersions: engine.supportedVersions,
    }))
}
