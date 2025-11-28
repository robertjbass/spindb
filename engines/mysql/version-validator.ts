/**
 * MySQL/MariaDB Version Validator
 *
 * Validates compatibility between mysql client version and dump file version.
 * MySQL is generally more lenient than PostgreSQL, but we still warn about:
 * - MariaDB dumps being restored to MySQL (and vice versa)
 * - Newer dumps being restored to older clients
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import {
  SpinDBError,
  ErrorCodes,
  logWarning,
  logDebug,
} from '../../core/error-handler'
import { getMysqlClientPath } from './binary-detection'

const execAsync = promisify(exec)

// =============================================================================
// Types
// =============================================================================

export type VersionInfo = {
  major: number
  minor: number
  patch: number
  full: string
}

export type MySQLVariant = 'mysql' | 'mariadb' | 'unknown'

export type DumpInfo = {
  version: VersionInfo | null
  variant: MySQLVariant
  serverVersion?: string
}

export type CompatibilityResult = {
  compatible: boolean
  dumpInfo: DumpInfo
  toolVersion: VersionInfo
  toolVariant: MySQLVariant
  warning?: string
  error?: string
}

// =============================================================================
// Version Parsing
// =============================================================================

/**
 * Parse version from mysql --version output
 * Examples:
 *   "mysql  Ver 8.0.35 for macos14.0 on arm64 (Homebrew)"
 *   "mysql  Ver 14.14 Distrib 5.7.44, for Linux (x86_64)" (MySQL 5.7)
 *   "mysql  Ver 15.1 Distrib 10.11.6-MariaDB, for osx10.19 (arm64)"
 *   "mysql from 11.4.3-MariaDB, client 15.2 for osx10.20 (arm64)"
 */
export function parseToolVersion(output: string): {
  version: VersionInfo
  variant: MySQLVariant
} {
  // Check for MariaDB - must explicitly contain "mariadb" in the string
  // Note: Both MySQL 5.7 and MariaDB use "Distrib", but only MariaDB includes "-MariaDB"
  const isMariaDB = output.toLowerCase().includes('mariadb')

  let match: RegExpMatchArray | null = null

  if (isMariaDB) {
    // MariaDB: "Distrib 10.11.6-MariaDB" or "from 11.4.3-MariaDB"
    match = output.match(/(?:Distrib|from)\s+(\d+)\.(\d+)\.(\d+)/)
  }

  if (!match) {
    // MySQL with Distrib: "Distrib 5.7.44" (MySQL 5.7 style)
    match = output.match(/Distrib\s+(\d+)\.(\d+)\.(\d+)/)
  }

  if (!match) {
    // MySQL: "Ver 8.0.35"
    match = output.match(/Ver\s+(\d+)\.(\d+)(?:\.(\d+))?/)
  }

  if (!match) {
    // Generic fallback
    match = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  }

  if (!match) {
    throw new Error(`Cannot parse version from: ${output}`)
  }

  return {
    version: {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3] || '0', 10),
      full: match[0].replace(/^(Ver|Distrib|from)\s+/, ''),
    },
    variant: isMariaDB ? 'mariadb' : 'mysql',
  }
}

/**
 * Read the first N lines of a file
 */
async function readFirstLines(
  filePath: string,
  lineCount: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const rl = createInterface({ input: stream })

    rl.on('line', (line) => {
      lines.push(line)
      if (lines.length >= lineCount) {
        rl.close()
        stream.destroy()
      }
    })

    rl.on('close', () => {
      resolve(lines.join('\n'))
    })

    rl.on('error', reject)
    stream.on('error', reject)
  })
}

/**
 * Parse version from dump file header
 *
 * MySQL dump header:
 *   -- MySQL dump 10.13  Distrib 8.0.35, for macos14.0 (arm64)
 *   -- Server version   8.0.35
 *
 * MariaDB dump header:
 *   -- MariaDB dump 10.19-11.4.3-MariaDB, for osx10.20 (arm64)
 *   -- Server version   11.4.3-MariaDB
 */
export async function parseDumpVersion(dumpPath: string): Promise<DumpInfo> {
  try {
    const header = await readFirstLines(dumpPath, 30)

    // Detect variant
    let variant: MySQLVariant = 'unknown'
    if (header.includes('MariaDB dump') || header.includes('-MariaDB')) {
      variant = 'mariadb'
    } else if (header.includes('MySQL dump')) {
      variant = 'mysql'
    }

    // Try to get server version (more accurate than dump tool version)
    // "-- Server version   8.0.35" or "-- Server version   11.4.3-MariaDB"
    const serverMatch = header.match(
      /--\s*Server version\s+(\d+)\.(\d+)(?:\.(\d+))?/,
    )
    if (serverMatch) {
      return {
        version: {
          major: parseInt(serverMatch[1], 10),
          minor: parseInt(serverMatch[2], 10),
          patch: parseInt(serverMatch[3] || '0', 10),
          full: `${serverMatch[1]}.${serverMatch[2]}${serverMatch[3] ? `.${serverMatch[3]}` : ''}`,
        },
        variant,
        serverVersion: header.match(/--\s*Server version\s+([^\n]+)/)?.[1],
      }
    }

    // Fall back to Distrib version in header
    // "Distrib 8.0.35" or "10.19-11.4.3-MariaDB"
    let distribMatch = header.match(/Distrib\s+(\d+)\.(\d+)(?:\.(\d+))?/)
    if (!distribMatch && variant === 'mariadb') {
      // MariaDB format: "dump 10.19-11.4.3-MariaDB"
      distribMatch = header.match(/dump\s+[\d.]+-(\d+)\.(\d+)\.(\d+)/)
    }

    if (distribMatch) {
      return {
        version: {
          major: parseInt(distribMatch[1], 10),
          minor: parseInt(distribMatch[2], 10),
          patch: parseInt(distribMatch[3] || '0', 10),
          full: `${distribMatch[1]}.${distribMatch[2]}${distribMatch[3] ? `.${distribMatch[3]}` : ''}`,
        },
        variant,
      }
    }

    return { version: null, variant }
  } catch (err) {
    logDebug('Failed to parse dump version', {
      dumpPath,
      error: err instanceof Error ? err.message : String(err),
    })
    return { version: null, variant: 'unknown' }
  }
}

/**
 * Get the version of the mysql client
 */
export async function getMysqlClientVersion(): Promise<{
  version: VersionInfo
  variant: MySQLVariant
}> {
  const mysqlPath = await getMysqlClientPath()
  if (!mysqlPath) {
    throw new Error('mysql client not found')
  }

  const { stdout } = await execAsync(`"${mysqlPath}" --version`)
  return parseToolVersion(stdout)
}

// =============================================================================
// Compatibility Checking
// =============================================================================

/**
 * Check version compatibility
 *
 * MySQL/MariaDB compatibility matrix:
 * | Scenario | Result |
 * |----------|--------|
 * | MySQL 8 client + MySQL 8 dump | ✅ Works |
 * | MySQL 8 client + MySQL 5.7 dump | ✅ Works (backwards compatible) |
 * | MySQL 5.7 client + MySQL 8 dump | ⚠️ May have issues |
 * | MariaDB client + MySQL dump | ⚠️ Warning (mostly compatible) |
 * | MySQL client + MariaDB dump | ⚠️ Warning (mostly compatible) |
 */
export function checkVersionCompatibility(
  dumpInfo: DumpInfo,
  toolVersion: VersionInfo,
  toolVariant: MySQLVariant,
): CompatibilityResult {
  const result: CompatibilityResult = {
    compatible: true,
    dumpInfo,
    toolVersion,
    toolVariant,
  }

  // If we couldn't parse dump version, proceed with warning
  if (!dumpInfo.version) {
    result.warning = 'Could not detect dump version. Proceeding anyway.'
    return result
  }

  // Check for variant mismatch (MySQL vs MariaDB)
  if (
    dumpInfo.variant !== 'unknown' &&
    toolVariant !== 'unknown' &&
    dumpInfo.variant !== toolVariant
  ) {
    result.warning =
      `Dump was created with ${dumpInfo.variant === 'mariadb' ? 'MariaDB' : 'MySQL'}, ` +
      `but restoring with ${toolVariant === 'mariadb' ? 'MariaDB' : 'MySQL'}. ` +
      `This usually works, but some features may not be compatible.`
    return result
  }

  // MySQL 8 introduced significant changes
  // Restoring MySQL 8+ dump with MySQL 5.x client may fail
  if (dumpInfo.version.major >= 8 && toolVersion.major < 8) {
    result.compatible = false
    result.error =
      `Dump was created with MySQL ${dumpInfo.version.major}, ` +
      `but your mysql client is version ${toolVersion.major}. ` +
      `MySQL 8 dumps may contain syntax not supported by older clients.`
    return result
  }

  // MariaDB 10.x to MySQL may have issues with specific features
  if (
    dumpInfo.variant === 'mariadb' &&
    toolVariant === 'mysql' &&
    dumpInfo.version.major >= 10
  ) {
    result.warning =
      `Dump was created with MariaDB ${dumpInfo.version.full}. ` +
      `Some MariaDB-specific features may not restore correctly to MySQL.`
    return result
  }

  // Warn if dump is newer than tool (any variant)
  if (dumpInfo.version.major > toolVersion.major) {
    result.warning =
      `Dump was created with version ${dumpInfo.version.full}, ` +
      `but your client is version ${toolVersion.full}. ` +
      `Some features may not restore correctly.`
    return result
  }

  // Warn if dump is very old (5+ years)
  if (
    dumpInfo.version.major < 5 ||
    (dumpInfo.version.major === 5 && dumpInfo.version.minor < 7)
  ) {
    result.warning =
      `Dump was created with MySQL ${dumpInfo.version.full}. ` +
      `This is a very old version; some data types may not import correctly.`
    return result
  }

  return result
}

// =============================================================================
// Main Validation Function
// =============================================================================

/**
 * Validate that a dump file can be restored with the available mysql client
 *
 * @throws SpinDBError if versions are incompatible
 */
export async function validateRestoreCompatibility(options: {
  dumpPath: string
}): Promise<{
  dumpInfo: DumpInfo
  toolVersion: VersionInfo
  toolVariant: MySQLVariant
}> {
  const { dumpPath } = options

  // Get tool version
  const { version: toolVersion, variant: toolVariant } =
    await getMysqlClientVersion()
  logDebug('mysql client version detected', {
    version: toolVersion.full,
    variant: toolVariant,
  })

  // Get dump version
  const dumpInfo = await parseDumpVersion(dumpPath)
  if (dumpInfo.version) {
    logDebug('Dump version detected', {
      version: dumpInfo.version.full,
      variant: dumpInfo.variant,
    })
  } else {
    logDebug('Could not detect dump version')
  }

  // Check compatibility
  const result = checkVersionCompatibility(dumpInfo, toolVersion, toolVariant)

  if (!result.compatible) {
    throw new SpinDBError(
      ErrorCodes.VERSION_MISMATCH,
      result.error!,
      'fatal',
      'Install a newer version of MySQL client tools',
      { dumpInfo, toolVersion, toolVariant },
    )
  }

  if (result.warning) {
    logWarning(result.warning)
  }

  return { dumpInfo, toolVersion, toolVariant }
}
