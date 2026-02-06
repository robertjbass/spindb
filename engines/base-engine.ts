import type {
  ContainerConfig,
  ProgressCallback,
  BackupFormat,
  BackupOptions,
  BackupResult,
  RestoreResult,
  DumpResult,
  StatusResult,
  QueryResult,
  QueryOptions,
  CreateUserOptions,
  UserCredentials,
} from '../types'
import { UnsupportedOperationError } from '../core/error-handler'

/**
 * Base class for database engines
 * All engines (PostgreSQL, MySQL, SQLite) should extend this class
 */
export abstract class BaseEngine {
  abstract name: string
  abstract displayName: string
  abstract defaultPort: number
  abstract supportedVersions: string[]

  // Get the download URL for binaries
  abstract getBinaryUrl(version: string, platform: string, arch: string): string

  // Verify that the binaries are working correctly
  abstract verifyBinary(binPath: string): Promise<boolean>

  // Initialize a new data directory
  abstract initDataDir(
    containerName: string,
    version: string,
    options?: Record<string, unknown>,
  ): Promise<string>

  // Start the database server
  abstract start(
    container: ContainerConfig,
    onProgress?: ProgressCallback,
  ): Promise<{ port: number; connectionString: string }>

  // Stop the database server
  abstract stop(container: ContainerConfig): Promise<void>

  // Get the status of the database server
  abstract status(container: ContainerConfig): Promise<StatusResult>

  // Detect the format of a backup file
  abstract detectBackupFormat(filePath: string): Promise<BackupFormat>

  // Restore a backup to the database
  abstract restore(
    container: ContainerConfig,
    backupPath: string,
    options?: Record<string, unknown>,
  ): Promise<RestoreResult>

  // Get the connection string for a container
  abstract getConnectionString(
    container: ContainerConfig,
    database?: string,
  ): string

  /**
   * Get the path to the psql client if available
   * Default implementation throws; engines that can provide a bundled or
   * configured psql should override this method.
   */
  async getPsqlPath(): Promise<string> {
    throw new Error('psql not found')
  }

  /**
   * Get the path to the mysql client if available
   * Default implementation throws; engines that can provide a bundled or
   * configured mysql should override this method.
   */
  async getMysqlClientPath(): Promise<string> {
    throw new Error('mysql client not found')
  }

  /**
   * Get the path to the mariadb client if available
   * Default implementation throws; MariaDB engine overrides this method.
   */
  async getMariadbClientPath(): Promise<string> {
    throw new Error('mariadb client not found')
  }

  /**
   * Get the path to the mysqladmin client if available
   * Default implementation throws; engines that can provide a bundled or
   * configured mysqladmin should override this method.
   */
  async getMysqladminPath(): Promise<string> {
    throw new Error('mysqladmin not found')
  }

  /**
   * Get the path to the mongosh client if available
   * Default implementation throws; engines that can provide a bundled or
   * configured mongosh should override this method.
   */
  async getMongoshPath(): Promise<string> {
    throw new Error('mongosh not found')
  }

  /**
   * Get the path to the redis-cli client if available
   * Default implementation throws; engines that can provide a bundled or
   * configured redis-cli should override this method.
   */
  async getRedisCliPath(): Promise<string> {
    throw new Error('redis-cli not found')
  }

  /**
   * Get the path to the valkey-cli client if available
   * Default implementation throws; engines that can provide a bundled or
   * configured valkey-cli should override this method.
   */
  async getValkeyCliPath(): Promise<string> {
    throw new Error('valkey-cli not found')
  }

  /**
   * Get the path to the clickhouse client if available
   * Default implementation throws; engines that can provide a bundled or
   * configured clickhouse should override this method.
   */
  async getClickHouseClientPath(): Promise<string> {
    throw new Error('clickhouse client not found')
  }

  /**
   * Get the path to the cockroach binary if available
   * Default implementation throws; CockroachDB engine overrides this method.
   */
  async getCockroachPath(_version?: string): Promise<string> {
    throw new Error('cockroach not found')
  }

  /**
   * Get the path to the surreal binary if available
   * Default implementation throws; SurrealDB engine overrides this method.
   */
  async getSurrealPath(_version?: string): Promise<string> {
    throw new Error('surreal not found')
  }

  /**
   * Get the path to the sqlite3 client if available
   * Default implementation returns null; SQLite engine overrides this method.
   */
  async getSqlite3Path(_version?: string): Promise<string | null> {
    return null
  }

  /**
   * Get the path to the duckdb client if available
   * Default implementation returns null; DuckDB engine overrides this method.
   */
  async getDuckDBPath(_version?: string): Promise<string | null> {
    return null
  }

  // Open an interactive shell/CLI connection
  abstract connect(container: ContainerConfig, database?: string): Promise<void>

  // Create a new database within the container
  abstract createDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void>

  // Drop a database within the container
  abstract dropDatabase(
    container: ContainerConfig,
    database: string,
  ): Promise<void>

  // Check if binaries are installed
  abstract isBinaryInstalled(version: string): Promise<boolean>

  // Ensure binaries are available, downloading if necessary
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

  // Create a dump from a remote database using a connection string
  abstract dumpFromConnectionString(
    connectionString: string,
    outputPath: string,
  ): Promise<DumpResult>

  /**
   * Get the size of a database in bytes
   * Returns null if the container is not running or size cannot be determined
   */
  abstract getDatabaseSize(container: ContainerConfig): Promise<number | null>

  /**
   * Create a backup of a database
   * @param container - The container configuration
   * @param outputPath - Path to write the backup file
   * @param options - Backup options including database name and format
   */
  abstract backup(
    container: ContainerConfig,
    outputPath: string,
    options: BackupOptions,
  ): Promise<BackupResult>

  /**
   * Run a SQL file or inline SQL statement against the database
   * @param container - The container configuration
   * @param options - Options including file path or SQL statement, and target database
   */
  abstract runScript(
    container: ContainerConfig,
    options: { file?: string; sql?: string; database?: string },
  ): Promise<void>

  /**
   * Terminate all active connections to a database.
   * Required before dropping a database that may have active connections.
   * Default implementation is a no-op - engines that need it should override.
   * @param container - The container configuration
   * @param database - The database name to terminate connections for
   */
  async terminateConnections(
    _container: ContainerConfig,
    _database: string,
  ): Promise<void> {
    // Default: no-op. Override in engines that support connection termination.
  }

  /**
   * Execute a query and return results in a structured format.
   * @param container - The container configuration
   * @param query - The query to execute (SQL, JavaScript, Redis commands, or REST API request)
   * @param options - Query options including target database
   * @returns QueryResult with columns, rows, and row count
   */
  abstract executeQuery(
    container: ContainerConfig,
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult>

  /**
   * List all user databases on the server, excluding system databases.
   * Used to sync the registry with actual databases on the server.
   *
   * System databases excluded by default:
   * - PostgreSQL: template0, template1, postgres
   * - MySQL/MariaDB: information_schema, mysql, performance_schema, sys
   * - CockroachDB: defaultdb, postgres, system
   *
   * @param container - The container configuration
   * @returns Array of database names (excluding system databases)
   * @throws Error if the engine doesn't support multiple databases or listing
   */
  async listDatabases(_container: ContainerConfig): Promise<string[]> {
    throw new UnsupportedOperationError('listDatabases', this.displayName)
  }

  /**
   * Create a database user with the given credentials.
   * Returns credentials including connection string.
   *
   * @param container - The container configuration
   * @param options - Username, password, and optional target database
   * @returns UserCredentials with connection info
   * @throws UnsupportedOperationError for engines that don't support users (SQLite, DuckDB, QuestDB)
   */
  async createUser(
    _container: ContainerConfig,
    _options: CreateUserOptions,
  ): Promise<UserCredentials> {
    throw new UnsupportedOperationError('createUser', this.displayName)
  }
}
