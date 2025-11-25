import type {
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  RestoreResult,
  StatusResult,
} from '@/types'

/**
 * Base class for database engines
 * All engines (PostgreSQL, MySQL, SQLite) should extend this class
 */
export abstract class BaseEngine {
  abstract name: string
  abstract displayName: string
  abstract defaultPort: number
  abstract supportedVersions: string[]

  /**
   * Get the download URL for binaries
   */
  abstract getBinaryUrl(version: string, platform: string, arch: string): string

  /**
   * Verify that the binaries are working correctly
   */
  abstract verifyBinary(binPath: string): Promise<boolean>

  /**
   * Initialize a new data directory
   */
  abstract initDataDir(
    containerName: string,
    version: string,
    options?: Record<string, unknown>,
  ): Promise<string>

  /**
   * Start the database server
   */
  abstract start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }>

  /**
   * Stop the database server
   */
  abstract stop(container: ContainerConfig): Promise<void>

  /**
   * Get the status of the database server
   */
  abstract status(container: ContainerConfig): Promise<StatusResult>

  /**
   * Detect the format of a backup file
   */
  abstract detectBackupFormat(filePath: string): Promise<BackupFormat>

  /**
   * Restore a backup to the database
   */
  abstract restore(
    container: ContainerConfig,
    backupPath: string,
    options?: Record<string, unknown>,
  ): Promise<RestoreResult>

  /**
   * Get the connection string for a container
   */
  abstract getConnectionString(
    container: ContainerConfig,
    database?: string,
  ): string

  /**
   * Open an interactive shell/CLI connection
   */
  abstract connect(container: ContainerConfig, database?: string): Promise<void>

  /**
   * Create a new database within the container
   */
  abstract createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void>

  /**
   * Check if binaries are installed
   */
  abstract isBinaryInstalled(version: string): Promise<boolean>

  /**
   * Ensure binaries are available, downloading if necessary
   */
  abstract ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string>

  /**
   * Fetch all available versions from remote source (grouped by major version)
   * Returns a map of major version -> array of full versions (sorted latest first)
   * Falls back to hardcoded versions if network fails
   */
  async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    // Default implementation returns supported versions as single-item arrays
    const versions: Record<string, string[]> = {}
    for (const v of this.supportedVersions) {
      versions[v] = [v]
    }
    return versions
  }
}
