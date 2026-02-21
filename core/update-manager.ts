import { exec } from 'child_process'
import { promisify } from 'util'
import { configManager } from './config-manager'
import { logDebug } from './error-handler'
import { VERSION } from '../config/version'

const execAsync = promisify(exec)

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/spindb'
const CHECK_THROTTLE_MS = 24 * 60 * 60 * 1000 // 24 hours

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const KNOWN_PACKAGE_MANAGERS: PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm']

export function parseUserAgent(
  userAgent: string | undefined,
): PackageManager | null {
  if (!userAgent) return null
  const firstToken = userAgent.split('/')[0]?.toLowerCase().trim()
  if (!firstToken) return null
  return KNOWN_PACKAGE_MANAGERS.find((pm) => pm === firstToken) ?? null
}

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
    return VERSION
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

  // Checks all PMs in parallel, falls back to npm_config_user_agent, then npm
  async detectPackageManager(): Promise<PackageManager> {
    const checks = await Promise.all([
      this.checkGlobalInstall(
        'pnpm',
        'pnpm list -g spindb --json',
        (stdout) => {
          const data = JSON.parse(stdout) as Array<{
            dependencies?: { spindb?: unknown }
          }>
          return !!data[0]?.dependencies?.spindb
        },
      ),
      this.checkGlobalInstall('yarn', 'yarn global list --json', (stdout) => {
        return stdout.includes('"spindb@')
      }),
      this.checkGlobalInstall('bun', 'bun pm ls -g', (stdout) => {
        return stdout.includes('spindb@')
      }),
      this.checkGlobalInstall('npm', 'npm list -g spindb --json', (stdout) => {
        const data = JSON.parse(stdout) as {
          dependencies?: { spindb?: unknown }
        }
        return !!data.dependencies?.spindb
      }),
    ])

    const globalPm = checks.find((result) => result !== null)
    if (globalPm) {
      logDebug(`Detected global install via ${globalPm}`)
      return globalPm
    }

    const agentPm = parseUserAgent(process.env.npm_config_user_agent)
    if (agentPm) {
      logDebug(`Detected package manager from user agent: ${agentPm}`)
      return agentPm
    }

    return 'npm'
  }

  private async checkGlobalInstall(
    pm: PackageManager,
    command: string,
    checkOutput: (stdout: string) => boolean,
  ): Promise<PackageManager | null> {
    try {
      const { stdout } = await execAsync(command, { timeout: 5000, cwd: '/' })
      return checkOutput(stdout) ? pm : null
    } catch {
      return null
    }
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

    // Run install command
    try {
      await execAsync(installCmd, { timeout: 60000, cwd: '/' })
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

    // Verify new version - use explicit cwd to avoid stale directory issues
    // (fnm and other version managers can invalidate the cwd during global installs)
    let newVersion = previousVersion
    try {
      const { stdout } = await execAsync(this.getListCommand(pm), {
        timeout: 10000,
        cwd: '/',
      })
      newVersion = this.parseVersionFromListOutput(pm, stdout, previousVersion)
    } catch {
      // Verification failed but install likely succeeded - fetch from registry instead
      try {
        newVersion = await this.fetchLatestVersion()
      } catch {
        // Fall back to previous version (install still succeeded)
      }
    }

    return {
      success: true,
      previousVersion,
      newVersion,
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
