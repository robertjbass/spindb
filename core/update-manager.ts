import { exec } from 'child_process'
import { promisify } from 'util'
import { createRequire } from 'module'
import { configManager } from './config-manager'

const execAsync = promisify(exec)
const require = createRequire(import.meta.url)

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/spindb'
const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24 hours

export type UpdateCheckResult = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  lastChecked: string
}

export type UpdateResult = {
  success: boolean
  previousVersion: string
  newVersion: string
  error?: string
}

export class UpdateManager {
  // Get currently installed version from package.json
  getCurrentVersion(): string {
    const pkg = require('../package.json') as { version: string }
    return pkg.version
  }

  /**
   * Check npm registry for latest version
   * Throttled to once per 24 hours unless force=true
   */
  async checkForUpdate(force = false): Promise<UpdateCheckResult | null> {
    const config = await configManager.load()
    const lastCheck = config.update?.lastCheck

    // Return cached result if within throttle period
    if (!force && lastCheck) {
      const elapsed = Date.now() - new Date(lastCheck).getTime()
      if (elapsed < CHECK_THROTTLE_MS && config.update?.latestVersion) {
        const currentVersion = this.getCurrentVersion()
        return {
          currentVersion,
          latestVersion: config.update.latestVersion,
          updateAvailable:
            this.compareVersions(config.update.latestVersion, currentVersion) >
            0,
          lastChecked: lastCheck,
        }
      }
    }

    try {
      const latestVersion = await this.fetchLatestVersion()
      const currentVersion = this.getCurrentVersion()

      // Update cache
      config.update = {
        ...config.update,
        lastCheck: new Date().toISOString(),
        latestVersion,
      }
      await configManager.save()

      return {
        currentVersion,
        latestVersion,
        updateAvailable:
          this.compareVersions(latestVersion, currentVersion) > 0,
        lastChecked: new Date().toISOString(),
      }
    } catch {
      // Offline or registry error - return null
      return null
    }
  }

  // Perform self-update via npm
  async performUpdate(): Promise<UpdateResult> {
    const previousVersion = this.getCurrentVersion()

    try {
      // Execute npm install globally
      await execAsync('npm install -g spindb@latest', { timeout: 60000 })

      // Verify new version by checking what npm reports
      const { stdout } = await execAsync('npm list -g spindb --json')
      const npmData = JSON.parse(stdout) as {
        dependencies?: { spindb?: { version?: string } }
      }
      const newVersion =
        npmData.dependencies?.spindb?.version || previousVersion

      return {
        success: true,
        previousVersion,
        newVersion,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      // Detect permission issues
      if (message.includes('EACCES') || message.includes('permission')) {
        return {
          success: false,
          previousVersion,
          newVersion: previousVersion,
          error: 'Permission denied. Try: sudo npm install -g spindb@latest',
        }
      }

      return {
        success: false,
        previousVersion,
        newVersion: previousVersion,
        error: message,
      }
    }
  }

  // Get cached update info (for showing notification without network call)
  async getCachedUpdateInfo(): Promise<{
    latestVersion?: string
    autoCheckEnabled: boolean
  }> {
    const config = await configManager.load()
    return {
      latestVersion: config.update?.latestVersion,
      autoCheckEnabled: config.update?.autoCheckEnabled !== false,
    }
  }

  // Set whether auto-update checks are enabled
  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    const config = await configManager.load()
    config.update = {
      ...config.update,
      autoCheckEnabled: enabled,
    }
    await configManager.save()
  }

  // Fetch latest version from npm registry
  private async fetchLatestVersion(): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)

    try {
      const response = await fetch(NPM_REGISTRY_URL, {
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`Registry returned ${response.status}`)
      }
      const data = (await response.json()) as {
        'dist-tags': { latest: string }
      }
      return data['dist-tags'].latest
    } finally {
      clearTimeout(timeout)
    }
  }

  /**
   * Compare semver versions
   * Returns >0 if a > b, <0 if a < b, 0 if equal
   */
  compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map((n) => parseInt(n, 10) || 0)
    const partsB = b.split('.').map((n) => parseInt(n, 10) || 0)

    for (let i = 0; i < 3; i++) {
      const diff = (partsA[i] || 0) - (partsB[i] || 0)
      if (diff !== 0) return diff
    }
    return 0
  }
}

export const updateManager = new UpdateManager()
