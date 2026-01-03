/**
 * Centralized backup format configuration for all engines
 *
 * This provides consistent format metadata across:
 * - CLI prompts
 * - File extensions
 * - Format descriptions
 * - Spinner messages
 */

export type BackupFormatInfo = {
  extension: string
  label: string
  description: string
  spinnerLabel: string
}

export type EngineBackupFormats = {
  sql: BackupFormatInfo
  dump: BackupFormatInfo
  // Whether this engine supports format selection (false = only one format)
  supportsFormatChoice: boolean
  // Default format when not specified
  defaultFormat: 'sql' | 'dump'
}

/**
 * Backup format configuration by engine
 */
export const BACKUP_FORMATS: Record<string, EngineBackupFormats> = {
  postgresql: {
    sql: {
      extension: '.sql',
      label: '.sql',
      description: 'Plain SQL - human-readable, larger file',
      spinnerLabel: 'SQL',
    },
    dump: {
      extension: '.dump',
      label: '.dump',
      description: 'Custom format - smaller file, faster restore',
      spinnerLabel: 'dump',
    },
    supportsFormatChoice: true,
    defaultFormat: 'sql',
  },
  mysql: {
    sql: {
      extension: '.sql',
      label: '.sql',
      description: 'Plain SQL - human-readable, larger file',
      spinnerLabel: 'SQL',
    },
    dump: {
      extension: '.sql.gz',
      label: '.sql.gz',
      description: 'Compressed SQL - smaller file',
      spinnerLabel: 'compressed SQL',
    },
    supportsFormatChoice: true,
    defaultFormat: 'sql',
  },
  sqlite: {
    sql: {
      extension: '.sql',
      label: '.sql',
      description: 'SQL dump - human-readable, portable',
      spinnerLabel: 'SQL',
    },
    dump: {
      extension: '.sqlite',
      label: '.sqlite',
      description: 'Binary copy - exact replica, faster',
      spinnerLabel: 'binary',
    },
    supportsFormatChoice: true,
    defaultFormat: 'dump',
  },
  mongodb: {
    sql: {
      extension: '', // Directory, no extension
      label: '.bson',
      description: 'Directory dump - BSON files per collection',
      spinnerLabel: 'BSON directory',
    },
    dump: {
      extension: '.archive',
      label: '.archive',
      description: 'Compressed archive - single file, smaller',
      spinnerLabel: 'archive',
    },
    supportsFormatChoice: true,
    defaultFormat: 'dump',
  },
  redis: {
    sql: {
      extension: '.redis',
      label: '.redis',
      description: 'Text commands - human-readable, editable',
      spinnerLabel: 'text',
    },
    dump: {
      extension: '.rdb',
      label: '.rdb',
      description: 'RDB snapshot - binary format, faster restore',
      spinnerLabel: 'RDB',
    },
    supportsFormatChoice: true,
    defaultFormat: 'dump',
  },
}

/**
 * Get backup format info for an engine
 */
export function getBackupFormatInfo(
  engine: string,
  format: 'sql' | 'dump',
): BackupFormatInfo {
  const engineFormats = BACKUP_FORMATS[engine] || BACKUP_FORMATS.postgresql
  return engineFormats[format]
}

/**
 * Get file extension for a backup format
 */
export function getBackupExtension(
  engine: string,
  format: 'sql' | 'dump',
): string {
  return getBackupFormatInfo(engine, format).extension
}

/**
 * Get spinner label for a backup format
 */
export function getBackupSpinnerLabel(
  engine: string,
  format: 'sql' | 'dump',
): string {
  return getBackupFormatInfo(engine, format).spinnerLabel
}

/**
 * Check if an engine supports format selection
 */
export function supportsFormatChoice(engine: string): boolean {
  const engineFormats = BACKUP_FORMATS[engine]
  return engineFormats?.supportsFormatChoice ?? true
}

/**
 * Get default format for an engine
 */
export function getDefaultFormat(engine: string): 'sql' | 'dump' {
  const engineFormats = BACKUP_FORMATS[engine]
  return engineFormats?.defaultFormat ?? 'sql'
}

/**
 * Large backup threshold (100MB) - warn user before restoring
 */
export const LARGE_BACKUP_THRESHOLD = 100 * 1024 * 1024

/**
 * Very large backup threshold (1GB) - require confirmation
 */
export const VERY_LARGE_BACKUP_THRESHOLD = 1024 * 1024 * 1024
