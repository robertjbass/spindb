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
  type RedisFormat,
  type ValkeyFormat,
  type ClickHouseFormat,
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
  [Engine.Redis]: EngineBackupFormats<RedisFormat>
  [Engine.Valkey]: EngineBackupFormats<ValkeyFormat>
  [Engine.ClickHouse]: EngineBackupFormats<ClickHouseFormat>
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
}

/**
 * Legacy format aliases for backward compatibility
 * Maps old format names (sql/dump) to new semantic format names
 * TODO: Remove after v1.1 release once legacy code has been updated
 */
const LEGACY_FORMAT_ALIASES: Record<Engine, Record<string, string>> = {
  [Engine.PostgreSQL]: { dump: 'custom' },
  [Engine.MySQL]: { dump: 'compressed' },
  [Engine.MariaDB]: { dump: 'compressed' },
  [Engine.SQLite]: { dump: 'binary' },
  [Engine.DuckDB]: { dump: 'binary' },
  [Engine.MongoDB]: { sql: 'bson', dump: 'archive' },
  [Engine.Redis]: { sql: 'text', dump: 'rdb' },
  [Engine.Valkey]: { sql: 'text', dump: 'rdb' },
  [Engine.ClickHouse]: {}, // No aliases needed
}

/**
 * Type guard to validate if a string is a valid Engine
 */
export function isEngine(value: string): value is Engine {
  return Object.values(Engine).includes(value as Engine)
}

/**
 * Normalize a format name, converting legacy aliases to new semantic names
 *
 * Note: This function returns a string, not BackupFormatType, because it does
 * not validate the input. Callers should use isValidFormat() to verify the
 * result is a valid format before treating it as BackupFormatType.
 *
 * @param engine - The database engine
 * @param format - The format name (may be legacy or new)
 * @returns The normalized format name (string, not validated)
 */
export function normalizeFormat(engine: Engine, format: string): string {
  const aliases = LEGACY_FORMAT_ALIASES[engine]
  return aliases[format] ?? format
}

/**
 * Check if a format is valid for a given engine
 * Handles both legacy (sql/dump) and new semantic format names
 * @param engine - The database engine
 * @param format - The format name to validate
 * @returns true if the format is valid for this engine
 */
export function isValidFormat(engine: Engine, format: string): boolean {
  const normalized = normalizeFormat(engine, format)
  const engineFormats = BACKUP_FORMATS[engine]
  return normalized in engineFormats.formats
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
  const normalized = normalizeFormat(engine, format)
  // Type assertion needed because TypeScript can't narrow the union to the specific engine's format
  const formatInfo =
    engineFormats.formats[normalized as keyof typeof engineFormats.formats]

  if (!formatInfo) {
    const validFormats = Object.keys(engineFormats.formats).join(', ')
    throw new Error(
      `Invalid backup format "${normalized}" for ${engine}. Valid formats: ${validFormats}`,
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
