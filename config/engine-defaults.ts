/**
 * Engine-specific default configurations
 * Extracted for dependency injection pattern - allows each engine to define its own defaults
 */

export type EngineDefaults = {
  // Default version to use when not specified
  defaultVersion: string
  // Default port for this engine
  defaultPort: number
  // Port range to scan if default is busy
  portRange: { start: number; end: number }
  // Supported major versions
  supportedVersions: string[]
  // Latest major version (used for Homebrew package names like postgresql@17)
  latestVersion: string
  // Default superuser name
  superuser: string
  // Connection string scheme (e.g., 'postgresql', 'mysql')
  connectionScheme: string
  // Log file name within container directory
  logFileName: string
  // PID file name (relative to data directory or container)
  pidFileName: string
  // Subdirectory for data files within container
  dataSubdir: string
  // Client tools required for this engine
  clientTools: string[]
  // Default max connections (higher than PostgreSQL default of 100 for parallel builds)
  maxConnections: number
}

export const engineDefaults: Record<string, EngineDefaults> = {
  postgresql: {
    defaultVersion: '18',
    defaultPort: 5432,
    portRange: { start: 5432, end: 5500 },
    supportedVersions: ['14', '15', '16', '17', '18'], // update edb-binary-urls.ts when adding new versions
    latestVersion: '18',
    superuser: 'postgres',
    connectionScheme: 'postgresql',
    logFileName: 'postgres.log',
    pidFileName: 'postmaster.pid',
    dataSubdir: 'data',
    clientTools: ['psql', 'pg_dump', 'pg_restore', 'pg_basebackup'],
    maxConnections: 200, // Higher than default 100 for parallel builds (Next.js, etc.)
  },
  mysql: {
    defaultVersion: '9.0',
    defaultPort: 3306,
    portRange: { start: 3306, end: 3400 },
    supportedVersions: ['5.7', '8.0', '8.4', '9.0'],
    latestVersion: '9.0', // MySQL doesn't use versioned Homebrew packages, but kept for consistency
    superuser: 'root',
    connectionScheme: 'mysql',
    logFileName: 'mysql.log',
    pidFileName: 'mysql.pid',
    dataSubdir: 'data',
    clientTools: ['mysql', 'mysqldump', 'mysqlpump'],
    maxConnections: 200, // Higher than default 151 for parallel builds
  },
  sqlite: {
    defaultVersion: '3',
    defaultPort: 0, // File-based, no port
    portRange: { start: 0, end: 0 }, // N/A
    supportedVersions: ['3'],
    latestVersion: '3',
    superuser: '', // No authentication
    connectionScheme: 'sqlite',
    logFileName: '', // No log file
    pidFileName: '', // No PID file (no server process)
    dataSubdir: '', // File is the data
    clientTools: ['sqlite3'],
    maxConnections: 0, // N/A - file-based
  },
  mongodb: {
    defaultVersion: '8.0',
    defaultPort: 27017,
    portRange: { start: 27017, end: 27100 },
    supportedVersions: ['6.0', '7.0', '8.0'],
    latestVersion: '8.0',
    superuser: '', // No auth by default for local dev
    connectionScheme: 'mongodb',
    logFileName: 'mongodb.log',
    pidFileName: 'mongod.pid',
    dataSubdir: 'data',
    clientTools: ['mongosh', 'mongodump', 'mongorestore'],
    maxConnections: 0, // Not applicable for MongoDB
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

/**
 * Get Homebrew package name for PostgreSQL client tools
 * Returns 'postgresql@17' format for versioned installs
 */
export function getPostgresHomebrewPackage(): string {
  const version = engineDefaults.postgresql.latestVersion
  return `postgresql@${version}`
}

/**
 * Get the PostgreSQL Homebrew bin path for a given architecture
 * @param arch - 'arm64' or 'x64'
 */
export function getPostgresHomebrewBinPath(arch: 'arm64' | 'x64'): string {
  const pkg = getPostgresHomebrewPackage()
  const prefix = arch === 'arm64' ? '/opt/homebrew' : '/usr/local'
  return `${prefix}/opt/${pkg}/bin`
}
