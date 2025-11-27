/**
 * Engine-specific default configurations
 * Extracted for dependency injection pattern - allows each engine to define its own defaults
 */

export type EngineDefaults = {
  /** Default version to use when not specified */
  defaultVersion: string
  /** Default port for this engine */
  defaultPort: number
  /** Port range to scan if default is busy */
  portRange: { start: number; end: number }
  /** Supported major versions */
  supportedVersions: string[]
  /** Default superuser name */
  superuser: string
  /** Connection string scheme (e.g., 'postgresql', 'mysql') */
  connectionScheme: string
  /** Log file name within container directory */
  logFileName: string
  /** PID file name (relative to data directory or container) */
  pidFileName: string
  /** Subdirectory for data files within container */
  dataSubdir: string
  /** Client tools required for this engine */
  clientTools: string[]
}

export const engineDefaults: Record<string, EngineDefaults> = {
  postgresql: {
    defaultVersion: '16',
    defaultPort: 5432,
    portRange: { start: 5432, end: 5500 },
    supportedVersions: ['14', '15', '16', '17'],
    superuser: 'postgres',
    connectionScheme: 'postgresql',
    logFileName: 'postgres.log',
    pidFileName: 'postmaster.pid',
    dataSubdir: 'data',
    clientTools: ['psql', 'pg_dump', 'pg_restore', 'pg_basebackup'],
  },
  mysql: {
    defaultVersion: '9.0',
    defaultPort: 3306,
    portRange: { start: 3306, end: 3400 },
    supportedVersions: ['5.7', '8.0', '8.4', '9.0'],
    superuser: 'root',
    connectionScheme: 'mysql',
    logFileName: 'mysql.log',
    pidFileName: 'mysql.pid',
    dataSubdir: 'data',
    clientTools: ['mysql', 'mysqldump', 'mysqlpump'],
  },
}

/**
 * Get engine defaults by name
 * @throws Error if engine is not found
 */
export function getEngineDefaults(engine: string): EngineDefaults {
  const normalized = engine.toLowerCase()
  const defaults = engineDefaults[normalized]
  if (!defaults) {
    const available = Object.keys(engineDefaults).join(', ')
    throw new Error(
      `Unknown engine "${engine}". Available engines: ${available}`,
    )
  }
  return defaults
}

/**
 * Check if an engine is supported
 */
export function isEngineSupported(engine: string): boolean {
  return engine.toLowerCase() in engineDefaults
}

/**
 * Get list of all supported engine names
 */
export function getSupportedEngines(): string[] {
  return Object.keys(engineDefaults)
}
