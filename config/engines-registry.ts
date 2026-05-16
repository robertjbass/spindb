import { readFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { type Engine, ALL_ENGINES } from '../types'

/**
 * Engine metadata for spindb. Carries STABLE engine-shape data only — display
 * name, runtime model, connection scheme, etc.
 *
 * Version-related fields (which versions exist, what's the default) USED to
 * live here but were removed once `hostdb` became the single source of truth:
 *   - `supportedVersions` → use `engine.supportedVersions` on the engine
 *     instance (built from the hostdb-driven wrapper's `SUPPORTED_MAJOR_VERSIONS`).
 *   - `defaultVersion` → use `getEngineDefaults(engine).defaultVersion` from
 *     `config/engine-defaults.ts` (spindb major-level policy, resolved to a
 *     full version via hostdb at create time).
 *   - `versionPlatforms` → use `hostdb.getAvailablePlatforms(engine, version)`.
 */
export type EngineConfig = {
  displayName: string
  icon: string
  status: 'integrated' | 'pending' | 'planned'
  binarySource: 'hostdb' | 'system' | 'edb'
  defaultPort: number | null
  runtime: 'server' | 'embedded'
  queryLanguage: string
  scriptFileLabel: string | null
  connectionScheme: string
  superuser: string | null
  clientTools: string[]
  licensing?: string | string[]
  notes?: string
  platforms?: string[]
}

export type EnginesJson = {
  $schema?: string
  engines: Record<Engine, EngineConfig>
}

// Cache for loaded engines config
let cachedEngines: EnginesJson | null = null

// Get directory of this file for relative path resolution
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export async function loadEnginesJson(): Promise<EnginesJson> {
  if (cachedEngines) return cachedEngines

  const jsonPath = join(__dirname, 'engines.json')

  let content: string
  try {
    content = await readFile(jsonPath, 'utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read engines.json at ${jsonPath}: ${message}`)
  }

  let parsed: EnginesJson
  try {
    parsed = JSON.parse(content) as EnginesJson
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse engines.json at ${jsonPath}: ${message}`)
  }

  // Structural validation: ensure parsed has expected shape
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `engines.json at ${jsonPath} has invalid structure: expected object`,
    )
  }
  if (!parsed.engines || typeof parsed.engines !== 'object') {
    throw new Error(
      `engines.json at ${jsonPath} has invalid structure: missing or invalid 'engines' field`,
    )
  }

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

export async function getEngineConfig(engine: Engine): Promise<EngineConfig> {
  const data = await loadEnginesJson()
  return data.engines[engine]
}

export function getAllEngines(): Engine[] {
  return [...ALL_ENGINES]
}

export function clearEnginesCache(): void {
  cachedEngines = null
}
