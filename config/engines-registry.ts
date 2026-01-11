/**
 * Engines Registry
 *
 * Loads and provides type-safe access to the engines.json configuration.
 * This module ensures that all engines in the Engine enum are present
 * in the JSON file at runtime.
 */

import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { type Engine, ALL_ENGINES } from '../types'

/**
 * Engine configuration from engines.json
 */
export type EngineConfig = {
  displayName: string
  icon: string
  status: 'integrated' | 'pending' | 'planned'
  binarySource: 'hostdb' | 'system' | 'edb'
  supportedVersions?: string[]
  defaultVersion?: string
  defaultPort?: number | null
  runtime?: 'server' | 'embedded'
  queryLanguage?: string
  connectionScheme?: string
  superuser?: string | null
  clientTools?: string[]
  licensing?: 'commercial'
  notes?: string
}

/**
 * Structure of engines.json file
 * Type-safe: engines.json MUST have all Engine enum values
 */
export type EnginesJson = {
  $schema?: string
  engines: Record<Engine, EngineConfig>
}

// Cache for loaded engines config
let cachedEngines: EnginesJson | null = null

// Get directory of this file for relative path resolution
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * Load and parse engines.json with runtime validation
 * Ensures all engines from the Engine enum are present
 */
export async function loadEnginesJson(): Promise<EnginesJson> {
  if (cachedEngines) return cachedEngines

  const jsonPath = join(__dirname, 'engines.json')
  const content = await readFile(jsonPath, 'utf-8')
  const parsed = JSON.parse(content) as EnginesJson

  // Runtime validation: ensure all engines are present
  for (const engine of ALL_ENGINES) {
    if (!(engine in parsed.engines)) {
      throw new Error(
        `engines.json is missing engine: ${engine}. ` +
          `All engines from the Engine enum must be present.`,
      )
    }
  }

  cachedEngines = parsed
  return cachedEngines
}

/**
 * Get configuration for a specific engine
 */
export async function getEngineConfig(engine: Engine): Promise<EngineConfig> {
  const data = await loadEnginesJson()
  return data.engines[engine]
}

/**
 * Get all integrated engines (synchronous, uses ALL_ENGINES)
 * This doesn't need to load JSON because we know integrated engines at compile time
 */
export function getIntegratedEngines(): Engine[] {
  return [...ALL_ENGINES]
}

/**
 * Clear the engines cache (for testing)
 */
export function clearEnginesCache(): void {
  cachedEngines = null
}
