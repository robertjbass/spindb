import { Engine, type ContainerConfig } from '../types'

/** Pinned dblab version — single source of truth for download URL */
export const DBLAB_VERSION = '0.34.2'

/** Engines that support dblab (PostgreSQL, MySQL, or SQLite wire protocol) */
export const DBLAB_ENGINES = new Set([
  Engine.PostgreSQL,
  Engine.MySQL,
  Engine.MariaDB,
  Engine.CockroachDB,
  Engine.SQLite,
  Engine.QuestDB,
])

/**
 * Get the platform suffix for the dblab download URL.
 * Returns e.g. 'darwin_arm64', 'linux_amd64', 'windows_amd64'
 */
export function getDblabPlatformSuffix(): string {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin' && arch === 'arm64') return 'darwin_arm64'
  if (platform === 'darwin' && arch === 'x64') return 'darwin_amd64'
  if (platform === 'linux' && arch === 'arm64') return 'linux_arm64'
  if (platform === 'linux' && arch === 'x64') return 'linux_amd64'
  if (platform === 'win32' && arch === 'x64') return 'windows_amd64'

  throw new Error(`Unsupported platform: ${platform} ${arch}`)
}

/**
 * Build the CLI args array for launching dblab against a container.
 * Uses flag-based approach to avoid MySQL tcp() URL wrapper issues.
 */
export function getDblabArgs(
  config: ContainerConfig,
  database: string,
): string[] {
  switch (config.engine) {
    case Engine.PostgreSQL:
      return [
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        '--user',
        'postgres',
        '--db',
        database,
        '--driver',
        'postgres',
        '--ssl',
        'disable',
      ]

    case Engine.MySQL:
    case Engine.MariaDB:
      return [
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        '--user',
        'root',
        '--db',
        database,
        '--driver',
        'mysql',
      ]

    case Engine.CockroachDB:
      return [
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        '--user',
        'root',
        '--db',
        database,
        '--driver',
        'postgres',
        '--ssl',
        'disable',
      ]

    case Engine.QuestDB:
      return [
        '--host',
        '127.0.0.1',
        '--port',
        String(config.port),
        '--user',
        'admin',
        '--pass',
        'quest',
        '--db',
        database || 'qdb',
        '--driver',
        'postgres',
        '--ssl',
        'disable',
      ]

    case Engine.SQLite:
      return ['--db', config.database, '--driver', 'sqlite3']

    default:
      throw new Error(`dblab is not supported for engine: ${config.engine}`)
  }
}
