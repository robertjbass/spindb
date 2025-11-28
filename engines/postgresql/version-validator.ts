/**
 * PostgreSQL Version Validator
 *
 * Validates compatibility between pg_restore tool version and dump file version.
 * PostgreSQL is backwards compatible - we only fail when dump_version > tool_version.
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

export type CompatibilityResult = {
  compatible: boolean
  dumpVersion: VersionInfo | null
  toolVersion: VersionInfo
  warning?: string
  error?: string
}

// =============================================================================
// Version Parsing
// =============================================================================

/**
 * Parse version from pg_dump/pg_restore --version output
 * Examples:
 *   "pg_restore (PostgreSQL) 16.1"
 *   "pg_restore (PostgreSQL) 14.9 (Homebrew)"
 *   "pg_dump (PostgreSQL) 17.0"
 */
export function parseToolVersion(output: string): VersionInfo {
  const match = output.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) {
    throw new Error(`Cannot parse version from: ${output}`)
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3] || '0', 10),
    full: match[0],
  }
}

/**
 * Read the first N lines of a file
 */
async function readFirstLines(filePath: string, lineCount: number): Promise<string> {
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
 * Plain SQL format: "-- Dumped from database version 16.1"
 * Archive format: Uses `pg_restore -l` to read TOC header
 */
export async function parseDumpVersion(
  dumpPath: string,
  format: string,
  pgRestorePath?: string,
): Promise<VersionInfo | null> {
  try {
    if (format === 'custom' || format === 'directory') {
      // Use pg_restore -l to get archive info
      const restorePath = pgRestorePath || 'pg_restore'
      const { stdout } = await execAsync(
        `"${restorePath}" -l "${dumpPath}" 2>&1 | head -20`,
      )
      // Look for: "; Dumped from database version 16.1"
      const match = stdout.match(/Dumped from database version (\d+)\.(\d+)(?:\.(\d+))?/)
      if (match) {
        return {
          major: parseInt(match[1], 10),
          minor: parseInt(match[2], 10),
          patch: parseInt(match[3] || '0', 10),
          full: `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`,
        }
      }
    } else {
      // Plain SQL format - read first 50 lines
      const header = await readFirstLines(dumpPath, 50)
      const match = header.match(/Dumped from database version (\d+)\.(\d+)(?:\.(\d+))?/)
      if (match) {
        return {
          major: parseInt(match[1], 10),
          minor: parseInt(match[2], 10),
          patch: parseInt(match[3] || '0', 10),
          full: `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`,
        }
      }
    }
  } catch (err) {
    logDebug('Failed to parse dump version', {
      dumpPath,
      format,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  return null // Version not found in dump
}

/**
 * Get the version of pg_restore
 */
export async function getPgRestoreVersion(pgRestorePath: string): Promise<VersionInfo> {
  const { stdout } = await execAsync(`"${pgRestorePath}" --version`)
  return parseToolVersion(stdout)
}

// =============================================================================
// Compatibility Checking
// =============================================================================

/**
 * Check version compatibility - ONLY fails when dump is NEWER than tool
 *
 * | Scenario | Result |
 * |----------|--------|
 * | pg_restore v16 + dump from v14 | ✅ Works (backwards compatible) |
 * | pg_restore v16 + dump from v16 | ✅ Works (same version) |
 * | pg_restore v14 + dump from v16 | ❌ Fails (dump newer than tool) |
 * | pg_restore v16 + dump from v10 | ⚠️ Works with warning (very old) |
 */
export function checkVersionCompatibility(
  dumpVersion: VersionInfo | null,
  toolVersion: VersionInfo,
): CompatibilityResult {
  // If we couldn't parse dump version, proceed with warning
  if (!dumpVersion) {
    return {
      compatible: true,
      dumpVersion: null,
      toolVersion,
      warning: 'Could not detect dump version. Proceeding anyway.',
    }
  }

  // FAIL: Dump is newer than tool (e.g., pg_restore 14 + dump from 16)
  if (dumpVersion.major > toolVersion.major) {
    return {
      compatible: false,
      dumpVersion,
      toolVersion,
      error:
        `Backup was created with PostgreSQL ${dumpVersion.major}, ` +
        `but your pg_restore is version ${toolVersion.major}. ` +
        `Install PostgreSQL ${dumpVersion.major} client tools to restore this backup.`,
    }
  }

  // WARN: Dump is very old (3+ major versions behind)
  if (dumpVersion.major < toolVersion.major - 2) {
    return {
      compatible: true,
      dumpVersion,
      toolVersion,
      warning:
        `Backup was created with PostgreSQL ${dumpVersion.major}. ` +
        `Some features may not restore correctly.`,
    }
  }

  // OK: Same version or dump is older (backwards compatible)
  return { compatible: true, dumpVersion, toolVersion }
}

// =============================================================================
// Main Validation Function
// =============================================================================

/**
 * Validate that a dump file can be restored with the available pg_restore
 *
 * @throws SpinDBError if versions are incompatible
 */
export async function validateRestoreCompatibility(options: {
  dumpPath: string
  format: string
  pgRestorePath: string
}): Promise<{ dumpVersion: VersionInfo | null; toolVersion: VersionInfo }> {
  const { dumpPath, format, pgRestorePath } = options

  // Get tool version
  const toolVersion = await getPgRestoreVersion(pgRestorePath)
  logDebug('pg_restore version detected', { version: toolVersion.full })

  // Get dump version
  const dumpVersion = await parseDumpVersion(dumpPath, format, pgRestorePath)
  if (dumpVersion) {
    logDebug('Dump version detected', { version: dumpVersion.full })
  } else {
    logDebug('Could not detect dump version')
  }

  // Check compatibility
  const result = checkVersionCompatibility(dumpVersion, toolVersion)

  if (!result.compatible) {
    throw new SpinDBError(
      ErrorCodes.VERSION_MISMATCH,
      result.error!,
      'fatal',
      `Install PostgreSQL ${dumpVersion!.major} client tools: brew install postgresql@${dumpVersion!.major}`,
      { dumpVersion, toolVersion },
    )
  }

  if (result.warning) {
    logWarning(result.warning)
  }

  return { dumpVersion, toolVersion }
}
