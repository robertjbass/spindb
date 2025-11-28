import {
  engineDefaults,
  getEngineDefaults,
  isEngineSupported,
  getSupportedEngines,
  type EngineDefaults,
} from './engine-defaults'

// Re-export engine-related functions and types
export {
  engineDefaults,
  getEngineDefaults,
  isEngineSupported,
  getSupportedEngines,
  type EngineDefaults,
}

export type PlatformMappings = {
  [key: string]: string
}

export type PortRange = {
  start: number
  end: number
}

/**
 * Legacy Defaults type - kept for backward compatibility
 * New code should use getEngineDefaults(engine) instead
 */
export type Defaults = {
  /** @deprecated Use getEngineDefaults(engine).defaultVersion instead */
  postgresVersion: string
  port: number
  portRange: PortRange
  engine: string
  /** @deprecated Use getEngineDefaults(engine).supportedVersions instead */
  supportedPostgresVersions: string[]
  superuser: string
  platformMappings: PlatformMappings
}

// Get PostgreSQL defaults from engine-defaults
const pgDefaults = engineDefaults.postgresql

/**
 * Default configuration values
 * For backward compatibility, this defaults to PostgreSQL settings.
 * New code should use getEngineDefaults(engine) for engine-specific defaults.
 */
export const defaults: Defaults = {
  // Default PostgreSQL version (from engine defaults)
  postgresVersion: pgDefaults.defaultVersion,

  // Default port (standard PostgreSQL port)
  port: pgDefaults.defaultPort,

  // Port range to scan if default is busy
  portRange: pgDefaults.portRange,

  // Default engine
  engine: 'postgresql',

  // Supported PostgreSQL versions (from engine defaults)
  supportedPostgresVersions: pgDefaults.supportedVersions,

  // Default superuser (from engine defaults)
  superuser: pgDefaults.superuser,

  // Platform mappings for zonky.io binaries (PostgreSQL specific)
  platformMappings: {
    'darwin-arm64': 'darwin-arm64v8',
    'darwin-x64': 'darwin-amd64',
    'linux-arm64': 'linux-arm64v8',
    'linux-x64': 'linux-amd64',
  },
}
