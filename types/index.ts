export type ContainerConfig = {
  name: string
  engine: string
  version: string
  port: number
  database: string
  created: string
  status: 'created' | 'running' | 'stopped'
  clonedFrom?: string
}

export type ProgressCallback = (progress: {
  stage: string
  message: string
}) => void

export type InstalledBinary = {
  engine: string
  version: string
  platform: string
  arch: string
}

export type PortResult = {
  port: number
  isDefault: boolean
}

export type ProcessResult = {
  stdout: string
  stderr: string
  code?: number
}

export type StatusResult = {
  running: boolean
  message: string
}

export type BackupFormat = {
  format: string
  description: string
  restoreCommand: string
}

export type RestoreResult = {
  format: string
  stdout?: string
  stderr?: string
  code?: number
}

export type EngineInfo = {
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
export type BinaryConfig = {
  tool: BinaryTool
  path: string
  source: BinarySource
  version?: string
}

/**
 * Global spindb configuration stored in ~/.spindb/config.json
 */
export type SpinDBConfig = {
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
