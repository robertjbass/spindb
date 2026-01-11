/**
 * MariaDB Version Validator
 *
 * Validates version compatibility for MariaDB dump files and databases.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { open } from 'fs/promises'
import { logDebug } from '../../core/error-handler'

const execAsync = promisify(exec)

/**
 * Parse version string into components
 */
export function parseVersion(version: string): {
  major: number
  minor: number
  patch: number
  full: string
} {
  const parts = version.split('.').map(Number)
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    full: version,
  }
}

/**
 * Extract MariaDB version from dump file header
 */
export async function extractDumpVersion(
  dumpPath: string,
): Promise<{ version: string; isMariaDB: boolean } | null> {
  try {
    const file = await open(dumpPath, 'r')
    const buffer = Buffer.alloc(2048)
    await file.read(buffer, 0, 2048, 0)
    await file.close()

    const header = buffer.toString('utf8')

    // Look for MariaDB dump header
    // Example: "-- MariaDB dump 10.19  Distrib 11.8.5-MariaDB"
    const mariadbMatch = header.match(
      /MariaDB dump \S+\s+Distrib (\d+\.\d+\.\d+)/,
    )
    if (mariadbMatch) {
      return { version: mariadbMatch[1], isMariaDB: true }
    }

    // Look for MySQL dump header (MariaDB dumps sometimes say MySQL)
    // Example: "-- MySQL dump 10.19  Distrib 11.8.5-MariaDB"
    const mysqlMatch = header.match(/MySQL dump \S+\s+Distrib (\d+\.\d+\.\d+)/)
    if (mysqlMatch) {
      // Check if it's actually MariaDB
      const isMariaDB = header.includes('MariaDB')
      return { version: mysqlMatch[1], isMariaDB }
    }

    // Try server version comment
    // Example: "-- Server version: 11.8.5-MariaDB"
    const serverMatch = header.match(/Server version:\s+(\d+\.\d+\.\d+)/)
    if (serverMatch) {
      const isMariaDB = header.includes('MariaDB')
      return { version: serverMatch[1], isMariaDB }
    }

    return null
  } catch (error) {
    logDebug('Failed to extract dump version', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Get the installed MariaDB server version
 */
export async function getInstalledVersion(
  binaryPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${binaryPath}" --version`)
    // Parse output like "mariadbd  Ver 11.8.5-MariaDB"
    const match = stdout.match(/Ver\s+(\d+\.\d+\.\d+)/)
    if (match) {
      return match[1]
    }
    return null
  } catch {
    return null
  }
}

/**
 * Get the installed mysql client version
 */
export async function getMysqlClientVersion(
  binaryPath: string,
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`"${binaryPath}" --version`)
    // Parse output like "mysql  Ver 15.1 Distrib 11.8.5-MariaDB"
    const match = stdout.match(/Distrib (\d+\.\d+\.\d+)/)
    if (match) {
      return match[1]
    }
    return null
  } catch {
    return null
  }
}

/**
 * Validate dump compatibility options
 */
export type ValidateOptions = {
  dumpPath: string
  targetVersion?: string
  strict?: boolean
}

/**
 * Validate that a dump file is compatible with a target MariaDB version
 *
 * MariaDB is generally backward compatible within major versions.
 */
export async function validateRestoreCompatibility(
  options: ValidateOptions,
): Promise<{ compatible: boolean; warning?: string }> {
  const { dumpPath, targetVersion, strict = false } = options

  const dumpInfo = await extractDumpVersion(dumpPath)

  if (!dumpInfo) {
    // Can't determine version - allow restore with warning
    return {
      compatible: true,
      warning: 'Could not determine dump version. Proceeding anyway.',
    }
  }

  // If no target version specified, just validate the dump is readable
  if (!targetVersion) {
    return { compatible: true }
  }

  const dumpVer = parseVersion(dumpInfo.version)
  const targetVer = parseVersion(targetVersion)

  // MariaDB is backward compatible - newer versions can restore older dumps
  if (targetVer.major > dumpVer.major) {
    return { compatible: true }
  }

  // Same major version - should be compatible
  if (targetVer.major === dumpVer.major) {
    if (targetVer.minor >= dumpVer.minor) {
      return { compatible: true }
    }
    // Restoring newer minor to older minor
    if (strict) {
      return {
        compatible: false,
        warning:
          `Dump is from MariaDB ${dumpInfo.version} but target is ${targetVersion}. ` +
          `Newer dumps may use features not available in older versions.`,
      }
    }
    return {
      compatible: true,
      warning:
        `Dump is from MariaDB ${dumpInfo.version} but target is ${targetVersion}. ` +
        `This may work but some features might not be supported.`,
    }
  }

  // Restoring dump from newer major version to older major version
  if (strict) {
    return {
      compatible: false,
      warning:
        `Dump is from MariaDB ${dumpInfo.version} but target is ${targetVersion}. ` +
        `Cross-major-version restore may fail.`,
    }
  }

  return {
    compatible: true,
    warning:
      `Dump is from MariaDB ${dumpInfo.version} but target is ${targetVersion}. ` +
      `Cross-major-version restore may have compatibility issues.`,
  }
}
