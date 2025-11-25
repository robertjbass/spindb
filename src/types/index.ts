export interface ContainerConfig {
  name: string
  engine: string
  version: string
  port: number
  created: string
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string
}

export interface ProgressCallback {
  (progress: { stage: string; message: string }): void
}

export interface InstalledBinary {
  engine: string
  version: string
  platform: string
  arch: string
}

export interface PortResult {
  port: number
  isDefault: boolean
}

export interface ProcessResult {
  stdout: string
  stderr: string
  code?: number
}

export interface StatusResult {
  running: boolean
  message: string
}

export interface BackupFormat {
  format: string
  description: string
  restoreCommand: string
}

export interface RestoreResult {
  format: string
  stdout?: string
  stderr?: string
  code?: number
}

export interface EngineInfo {
  name: string
  displayName: string
  defaultPort: number
  supportedVersions: string[]
}

/**
 * Binary tool types
 */
export type BinaryTool = 'psql' | 'pg_dump' | 'pg_restore' | 'pg_basebackup'

/**
 * Source of a binary - bundled (downloaded by spindb) or system (found on PATH)
 */
export type BinarySource = 'bundled' | 'system' | 'custom'

/**
 * Configuration for a single binary tool
 */
export interface BinaryConfig {
  tool: BinaryTool
  path: string
  source: BinarySource
  version?: string
}

/**
 * Global spindb configuration stored in ~/.spindb/config.json
 */
export interface SpinDBConfig {
  // Binary paths for client tools
  binaries: {
    psql?: BinaryConfig
    pg_dump?: BinaryConfig
    pg_restore?: BinaryConfig
    pg_basebackup?: BinaryConfig
  }
  // Default settings
  defaults?: {
    engine?: string
    version?: string
    port?: number
  }
  // Last updated timestamp
  updatedAt?: string
}
