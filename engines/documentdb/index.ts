import { join } from 'path'
import { randomBytes } from 'crypto'
import { setTimeout as delay } from 'timers/promises'
import { MongoDBEngine } from '../mongodb'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'
import { saveCredentials } from '../../core/credential-manager'
import { spawnAsync } from '../../core/spawn-utils'
import {
  Engine,
  type ContainerConfig,
  type CreateUserOptions,
  type UserCredentials,
  type ProgressCallback,
  type Platform,
  type Arch,
  type RestoreResult,
  type StatusResult,
} from '../../types'
import { restoreBackup } from '../mongodb/restore'
import { documentdbBinaryManager } from './binary-manager'
import {
  DocumentDBNativeRuntime,
  verifyDocumentDBBundle,
} from './native-runtime'
import { getBinaryUrl } from './binary-urls'
import { normalizeVersion, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { fetchAvailableVersions } from './hostdb-releases'

export class DocumentDBEngine extends MongoDBEngine {
  override name = 'documentdb'
  override displayName = 'DocumentDB'
  protected override credentialEngine = Engine.DocumentDB
  override supportedVersions = SUPPORTED_MAJOR_VERSIONS

  override resolveFullVersion(version: string): string {
    return normalizeVersion(version)
  }
  override getBinaryUrl(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return getBinaryUrl(version, platform, arch)
  }
  override getBinaryPath(version: string): string {
    const { platform, arch } = platformService.getPlatformInfo()
    return paths.getBinaryPath({
      engine: this.name,
      version: normalizeVersion(version),
      platform,
      arch,
    })
  }
  override async fetchAvailableVersions(): Promise<Record<string, string[]>> {
    return fetchAvailableVersions()
  }
  override async verifyBinary(
    binPath: string,
    version?: string,
  ): Promise<boolean> {
    if (!version)
      throw new Error(
        'An exact DocumentDB version is required to verify a bundle',
      )
    await verifyDocumentDBBundle(binPath, normalizeVersion(version))
    return true
  }
  override async isBinaryInstalled(version: string): Promise<boolean> {
    const { platform, arch } = platformService.getPlatformInfo()
    return documentdbBinaryManager.isInstalled(version, platform, arch)
  }
  override async ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const { platform, arch } = platformService.getPlatformInfo()
    return documentdbBinaryManager.ensureInstalled(
      version,
      platform,
      arch,
      onProgress,
    )
  }
  private runtime(
    container: Pick<
      ContainerConfig,
      'name' | 'version' | 'port' | 'bindAddress'
    >,
  ): DocumentDBNativeRuntime {
    return new DocumentDBNativeRuntime({
      bundlePath: this.getBinaryPath(container.version),
      containerPath: paths.getContainerPath(container.name, {
        engine: this.name,
      }),
      version: normalizeVersion(container.version),
      port: container.port,
      bindAddress: container.bindAddress,
    })
  }
  override async createUser(
    container: ContainerConfig,
    options: CreateUserOptions,
  ): Promise<UserCredentials> {
    if (options.database !== 'admin') {
      throw new Error(
        'DocumentDB user provisioning currently requires --database admin and grants administrator access; database-scoped grants are unsupported',
      )
    }
    await this.runtime(container).provisionAdministrator(
      options.username,
      options.password,
    )
    return {
      username: options.username,
      password: options.password,
      connectionString: `mongodb://${encodeURIComponent(options.username)}:${encodeURIComponent(options.password)}@127.0.0.1:${container.port}/admin?authSource=admin`,
      engine: Engine.DocumentDB,
      container: container.name,
      database: 'admin',
      authSource: 'admin',
    }
  }

  override async initDataDir(
    containerName: string,
    version: string,
    options?: Record<string, unknown>,
  ): Promise<string> {
    const port =
      typeof options?.port === 'number' ? options.port : this.defaultPort
    const runtime = this.runtime({ name: containerName, version, port })
    const username = 'spindb'
    const password = randomBytes(24).toString('hex')
    await runtime.initialize({ username, password })
    await saveCredentials(containerName, Engine.DocumentDB, {
      username,
      password,
      engine: Engine.DocumentDB,
      container: containerName,
      database: 'admin',
      authSource: 'admin',
      connectionString: `mongodb://${username}:${password}@127.0.0.1:${port}/?authSource=admin`,
    })
    return runtime.dataPath
  }
  override async start(
    container: ContainerConfig,
  ): Promise<{ port: number; connectionString: string }> {
    if (container.authEnabled === false)
      throw new Error(
        'DocumentDB requires authentication; --no-auth is unsupported',
      )
    await this.getMongoshPath()
    const runtime = this.runtime(container)
    await runtime.start()
    try {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        try {
          await this.runLocalMongosh(container, 'admin', {
            eval: 'if (db.runCommand({ping: 1}).ok !== 1) quit(1)',
            timeoutMs: 5000,
          })
          return {
            port: container.port,
            connectionString: this.getConnectionString(container),
          }
        } catch {
          await delay(500)
        }
      }
      throw new Error(
        'DocumentDB did not accept authenticated queries; inspect its container log',
      )
    } catch (error) {
      await runtime.stop()
      throw error
    }
  }
  override async stop(container: ContainerConfig): Promise<void> {
    await this.runtime(container).stop()
  }
  override async status(container: ContainerConfig): Promise<StatusResult> {
    try {
      await spawnAsync(
        join(this.getBinaryPath(container.version), 'bin/pg_ctl'),
        ['status', '-D', this.runtime(container).dataPath],
        { timeout: 5000 },
      )
      await this.runLocalMongosh(container, 'admin', {
        eval: 'if (db.runCommand({ping: 1}).ok !== 1) quit(1)',
        timeoutMs: 5000,
      })
      return {
        running: true,
        message: 'DocumentDB gateway and backend are running',
      }
    } catch {
      return {
        running: false,
        message: 'DocumentDB gateway or backend is unavailable',
      }
    }
  }
  override async restore(
    container: ContainerConfig,
    backupPath: string,
    options: Record<string, unknown> = {},
  ): Promise<RestoreResult> {
    return restoreBackup(backupPath, {
      engine: Engine.DocumentDB,
      containerName: container.name,
      port: container.port,
      database:
        typeof options.database === 'string'
          ? options.database
          : container.database,
      drop: options.drop !== false,
      validateVersion: false,
    })
  }
}
export const documentdbEngine = new DocumentDBEngine()
