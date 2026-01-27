/**
 * Centralized backup format configuration for all engines
 *
 * This provides consistent format metadata across:
 * - CLI prompts
 * - File extensions
 * - Format descriptions
 * - Spinner messages
 */

import {
  Engine,
  type PostgreSQLFormat,
  type MySQLFormat,
  type MariaDBFormat,
  type SQLiteFormat,
  type DuckDBFormat,
  type MongoDBFormat,
  type FerretDBFormat,
  type RedisFormat,
  type ValkeyFormat,
  type ClickHouseFormat,
  type QdrantFormat,
  type MeilisearchFormat,
  type CouchDBFormat,
  type CockroachDBFormat,
  type SurrealDBFormat,
  type QuestDBFormat,
  type BackupFormatType,
} from '../types'

export type BackupFormatInfo = {
  extension: string
  label: string
  description: string
  spinnerLabel: string
}

// Generic type for engine backup formats
export type EngineBackupFormats<F extends string = string> = {
  formats: Record<F, BackupFormatInfo>
  supportsFormatChoice: boolean
  defaultFormat: F
}

// Backup format configuration by engine with semantic format names
export const BACKUP_FORMATS: {
  [Engine.PostgreSQL]: EngineBackupFormats<PostgreSQLFormat>
  [Engine.MySQL]: EngineBackupFormats<MySQLFormat>
  [Engine.MariaDB]: EngineBackupFormats<MariaDBFormat>
  [Engine.SQLite]: EngineBackupFormats<SQLiteFormat>
  [Engine.DuckDB]: EngineBackupFormats<DuckDBFormat>
  [Engine.MongoDB]: EngineBackupFormats<MongoDBFormat>
  [Engine.FerretDB]: EngineBackupFormats<FerretDBFormat>
  [Engine.Redis]: EngineBackupFormats<RedisFormat>
  [Engine.Valkey]: EngineBackupFormats<ValkeyFormat>
  [Engine.ClickHouse]: EngineBackupFormats<ClickHouseFormat>
  [Engine.Qdrant]: EngineBackupFormats<QdrantFormat>
  [Engine.Meilisearch]: EngineBackupFormats<MeilisearchFormat>
  [Engine.CouchDB]: EngineBackupFormats<CouchDBFormat>
  [Engine.CockroachDB]: EngineBackupFormats<CockroachDBFormat>
  [Engine.SurrealDB]: EngineBackupFormats<SurrealDBFormat>
  [Engine.QuestDB]: EngineBackupFormats<QuestDBFormat>
} = {
  [Engine.PostgreSQL]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'Plain SQL - human-readable, larger file',
        spinnerLabel: 'SQL',
      },
      custom: {
        extension: '.dump',
        label: '.dump',
        description: 'Custom format - smaller file, faster restore',
        spinnerLabel: 'custom',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'sql',
  },
  [Engine.MySQL]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'Plain SQL - human-readable, larger file',
        spinnerLabel: 'SQL',
      },
      compressed: {
        extension: '.sql.gz',
        label: '.sql.gz',
        description: 'Compressed SQL - smaller file',
        spinnerLabel: 'compressed SQL',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'sql',
  },
  [Engine.MariaDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'Plain SQL - human-readable, larger file',
        spinnerLabel: 'SQL',
      },
      compressed: {
        extension: '.sql.gz',
        label: '.sql.gz',
        description: 'Compressed SQL - smaller file',
        spinnerLabel: 'compressed SQL',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'sql',
  },
  [Engine.SQLite]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL dump - human-readable, portable',
        spinnerLabel: 'SQL',
      },
      binary: {
        extension: '.sqlite',
        label: '.sqlite',
        description: 'Binary copy - exact replica, faster',
        spinnerLabel: 'binary',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'binary',
  },
  [Engine.DuckDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL dump - human-readable, portable',
        spinnerLabel: 'SQL',
      },
      binary: {
        extension: '.duckdb',
        label: '.duckdb',
        description: 'Binary copy - exact replica, faster',
        spinnerLabel: 'binary',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'binary',
  },
  [Engine.MongoDB]: {
    formats: {
      bson: {
        extension: '', // Directory, no extension
        label: '.bson',
        description: 'Directory dump - BSON files per collection',
        spinnerLabel: 'BSON directory',
      },
      archive: {
        extension: '.archive',
        label: '.archive',
        description: 'Compressed archive - single file, smaller',
        spinnerLabel: 'archive',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'archive',
  },
  [Engine.FerretDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'Plain SQL - human-readable, larger file',
        spinnerLabel: 'SQL',
      },
      custom: {
        extension: '.dump',
        label: '.dump',
        description: 'Custom format - smaller file, faster restore',
        spinnerLabel: 'custom',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'sql',
  },
  [Engine.Redis]: {
    formats: {
      text: {
        extension: '.redis',
        label: '.redis',
        description: 'Text commands - human-readable, editable',
        spinnerLabel: 'text',
      },
      rdb: {
        extension: '.rdb',
        label: '.rdb',
        description: 'RDB snapshot - binary format, faster restore',
        spinnerLabel: 'RDB',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'rdb',
  },
  [Engine.Valkey]: {
    formats: {
      text: {
        extension: '.valkey',
        label: '.valkey',
        description: 'Text commands - human-readable, editable',
        spinnerLabel: 'text',
      },
      rdb: {
        extension: '.rdb',
        label: '.rdb',
        description: 'RDB snapshot - binary format, faster restore',
        spinnerLabel: 'RDB',
      },
    },
    supportsFormatChoice: true,
    defaultFormat: 'rdb',
  },
  [Engine.ClickHouse]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL dump - DDL + INSERT statements',
        spinnerLabel: 'SQL',
      },
    },
    supportsFormatChoice: false, // Only SQL format supported
    defaultFormat: 'sql',
  },
  [Engine.Qdrant]: {
    formats: {
      snapshot: {
        extension: '.snapshot',
        label: '.snapshot',
        description: 'Qdrant snapshot - full database backup',
        spinnerLabel: 'snapshot',
      },
    },
    supportsFormatChoice: false, // Only snapshot format supported
    defaultFormat: 'snapshot',
  },
  [Engine.Meilisearch]: {
    formats: {
      snapshot: {
        extension: '.snapshot',
        label: '.snapshot',
        description: 'Meilisearch snapshot - full database backup',
        spinnerLabel: 'snapshot',
      },
    },
    supportsFormatChoice: false, // Only snapshot format supported
    defaultFormat: 'snapshot',
  },
  [Engine.CouchDB]: {
    formats: {
      json: {
        extension: '.json',
        label: '.json',
        description: 'JSON backup - all documents exported as JSON',
        spinnerLabel: 'JSON',
      },
    },
    supportsFormatChoice: false, // Only JSON format supported
    defaultFormat: 'json',
  },
  [Engine.CockroachDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL dump - DDL + INSERT statements',
        spinnerLabel: 'SQL',
      },
    },
    supportsFormatChoice: false, // Only SQL format supported
    defaultFormat: 'sql',
  },
  [Engine.SurrealDB]: {
    formats: {
      surql: {
        extension: '.surql',
        label: '.surql',
        description: 'SurrealQL dump - schema and data as SurrealQL statements',
        spinnerLabel: 'SurrealQL',
      },
    },
    supportsFormatChoice: false, // Only SurrealQL format supported
    defaultFormat: 'surql',
  },
  [Engine.QuestDB]: {
    formats: {
      sql: {
        extension: '.sql',
        label: '.sql',
        description: 'SQL dump - time-series data as SQL statements',
        spinnerLabel: 'SQL',
      },
    },
    supportsFormatChoice: false, // Only SQL format supported
    defaultFormat: 'sql',
  },
}

/**
 * Type guard to validate if a string is a valid Engine
 */
export function isEngine(value: string): value is Engine {
  return Object.values(Engine).includes(value as Engine)
}

/**
 * Check if a format is valid for a given engine
 * @param engine - The database engine
 * @param format - The format name to validate
 * @returns true if the format is valid for this engine
 */
export function isValidFormat(engine: Engine, format: string): boolean {
  const engineFormats = BACKUP_FORMATS[engine]
  return format in engineFormats.formats
}

/**
 * Get valid format names for an engine
 * @param engine - The database engine
 * @returns Array of valid format names
 */
export function getValidFormats(engine: Engine): string[] {
  return Object.keys(BACKUP_FORMATS[engine].formats)
}

// Get backup format info for an engine
export function getBackupFormatInfo(
  engine: Engine,
  format: BackupFormatType,
): BackupFormatInfo {
  const engineFormats = BACKUP_FORMATS[engine]
  // Type assertion needed because TypeScript can't narrow the union to the specific engine's format
  const formatInfo =
    engineFormats.formats[format as keyof typeof engineFormats.formats]

  if (!formatInfo) {
    const validFormats = Object.keys(engineFormats.formats).join(', ')
    throw new Error(
      `Invalid backup format "${format}" for ${engine}. Valid formats: ${validFormats}`,
    )
  }

  return formatInfo
}

// Get file extension for a backup format
export function getBackupExtension(
  engine: Engine,
  format: BackupFormatType,
): string {
  return getBackupFormatInfo(engine, format).extension
}

// Get spinner label for a backup format
export function getBackupSpinnerLabel(
  engine: Engine,
  format: BackupFormatType,
): string {
  return getBackupFormatInfo(engine, format).spinnerLabel
}

// Check if an engine supports format selection
export function supportsFormatChoice(engine: Engine): boolean {
  return BACKUP_FORMATS[engine].supportsFormatChoice
}

// Get default format for an engine
export function getDefaultFormat(engine: Engine): BackupFormatType {
  return BACKUP_FORMATS[engine].defaultFormat
}

// Large backup threshold (100MB) - warn user before restoring
export const LARGE_BACKUP_THRESHOLD = 100 * 1024 * 1024

// Very large backup threshold (1GB) - require confirmation
export const VERY_LARGE_BACKUP_THRESHOLD = 1024 * 1024 * 1024
