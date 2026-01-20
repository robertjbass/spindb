import { exec } from 'child_process'
import { promisify } from 'util'
import { createRequire } from 'module'
import { configManager } from './config-manager'

const execAsync = promisify(exec)
const require = createRequire(import.meta.url)

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/spindb'
const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24 hours

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

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
  getCurrentVersion(): string {
    const pkg = require('../package.json') as { version: string }
    return pkg.version
  }

  // Throttled to once per 24 hours unless force=true
  async checkForUpdate(force = false): Promise<UpdateCheckResult | null> {
    const config = await configManager.load()
    const lastCheck = config.update?.lastCheck

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

  // Checks pnpm, yarn, bun first since npm is the fallback
  async detectPackageManager(): Promise<PackageManager> {
    try {
      const { stdout } = await execAsync('pnpm list -g spindb --json', {
        timeout: 5000,
      })
      const data = JSON.parse(stdout) as Array<{ dependencies?: { spindb?: unknown } }>
      if (data[0]?.dependencies?.spindb) {
        return 'pnpm'
      }
    } catch {
      // pnpm not installed or spindb not found
    }

    try {
      const { stdout } = await execAsync('yarn global list --json', {
        timeout: 5000,
      })
      // yarn outputs newline-delimited JSON, look for spindb in any line
      if (stdout.includes('"spindb@')) {
        return 'yarn'
      }
    } catch {
      // yarn not installed or spindb not found
    }

    try {
      const { stdout } = await execAsync('bun pm ls -g', {
        timeout: 5000,
      })
      if (stdout.includes('spindb@')) {
        return 'bun'
      }
    } catch {
      // bun not installed or spindb not found
    }

    return 'npm'
  }

  getInstallCommand(pm: PackageManager): string {
    switch (pm) {
      case 'pnpm':
        return 'pnpm add -g spindb@latest'
      case 'yarn':
        return 'yarn global add spindb@latest'
      case 'bun':
        return 'bun add -g spindb@latest'
      case 'npm':
        return 'npm install -g spindb@latest'
    }
  }

  private getListCommand(pm: PackageManager): string {
    switch (pm) {
      case 'pnpm':
        return 'pnpm list -g spindb --json'
      case 'yarn':
        return 'yarn global list --json'
      case 'bun':
        return 'bun pm ls -g'
      case 'npm':
        return 'npm list -g spindb --json'
    }
  }

  private parseVersionFromListOutput(
    pm: PackageManager,
    stdout: string,
    fallback: string,
  ): string {
    try {
      switch (pm) {
        case 'pnpm': {
          const data = JSON.parse(stdout) as Array<{
            dependencies?: { spindb?: { version?: string } }
          }>
          return data[0]?.dependencies?.spindb?.version || fallback
        }
        case 'npm': {
          const data = JSON.parse(stdout) as {
            dependencies?: { spindb?: { version?: string } }
          }
          return data.dependencies?.spindb?.version || fallback
        }
        case 'yarn':
        case 'bun': {
          // Extract version from "spindb@x.y.z" pattern
          const match = stdout.match(/spindb@(\d+\.\d+\.\d+)/)
          return match?.[1] || fallback
        }
      }
    } catch {
      return fallback
    }
  }

  async performUpdate(): Promise<UpdateResult> {
    const previousVersion = this.getCurrentVersion()
    const pm = await this.detectPackageManager()
    const installCmd = this.getInstallCommand(pm)

    try {
      await execAsync(installCmd, { timeout: 60000 })

      const { stdout } = await execAsync(this.getListCommand(pm), {
        timeout: 10000,
      })
      const newVersion = this.parseVersionFromListOutput(
        pm,
        stdout,
        previousVersion,
      )

      return {
        success: true,
        previousVersion,
        newVersion,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      if (message.includes('EACCES') || message.includes('permission')) {
        const sudoCmd = pm === 'npm' ? `sudo ${installCmd}` : installCmd
        return {
          success: false,
          previousVersion,
          newVersion: previousVersion,
          error: `Permission denied. Try: ${sudoCmd}`,
        }
      }

      return {
        success: false,
        previousVersion,
        newVersion: previousVersion,
        error: `${message}\nManual update: ${installCmd}`,
      }
    }
  }

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

  async setAutoCheckEnabled(enabled: boolean): Promise<void> {
    const config = await configManager.load()
    config.update = {
      ...config.update,
      autoCheckEnabled: enabled,
    }
    await configManager.save()
  }

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
