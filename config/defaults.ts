import {
  engineDefaults,
  getEngineDefaults,
  isEngineSupported,
  getSupportedEngines,
  type EngineDefaults,
} from './engine-defaults'
import { Engine } from '../types'

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

export type Defaults = {
  port: number
  portRange: PortRange
  engine: Engine
  superuser: string
  platformMappings: PlatformMappings
}

const pgDefaults = engineDefaults.postgresql

/**
 * Default configuration values (PostgreSQL-based defaults)
 * Use getEngineDefaults(engine) for engine-specific defaults.
 */
export const defaults: Defaults = {
  port: pgDefaults.defaultPort,
  portRange: pgDefaults.portRange,
  engine: Engine.PostgreSQL,
  superuser: pgDefaults.superuser,
  platformMappings: {
    'darwin-arm64': 'darwin-arm64v8',
    'darwin-x64': 'darwin-amd64',
    'linux-arm64': 'linux-arm64v8',
    'linux-x64': 'linux-amd64',
    // Windows uses EDB binaries instead of zonky.io
    // EDB naming convention: windows-x64
    'win32-x64': 'windows-x64',
  },
}
