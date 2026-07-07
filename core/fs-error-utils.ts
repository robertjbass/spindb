/**
 * Filesystem Error Utilities
 *
 * Shared error detection and file operation functions for filesystem operations.
 */

import { rename, cp, rm, stat, chmod, access } from 'fs/promises'
import { constants } from 'fs'
import { logDebug } from './error-handler'

/**
 * Check if an error is a filesystem error that should trigger cp fallback
 * - EXDEV: cross-device link (rename across filesystems)
 * - EPERM: permission error (Windows filesystem operations)
 * - ENOTEMPTY: directory not empty (target exists with content)
 */
export function isRenameFallbackError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return (
    typeof code === 'string' && ['EXDEV', 'EPERM', 'ENOTEMPTY'].includes(code)
  )
}

/**
 * Move a file or directory from source to destination.
 * Uses rename() for efficiency, with fallback to cp() + rm() for cross-device
 * moves, permission issues, or non-empty target directories (EXDEV, EPERM, ENOTEMPTY).
 *
 * @param sourcePath - Source file or directory path
 * @param destPath - Destination file or directory path
 */
export async function moveEntry(
  sourcePath: string,
  destPath: string,
): Promise<void> {
  try {
    await rename(sourcePath, destPath)
  } catch (error) {
    if (isRenameFallbackError(error)) {
      await cp(sourcePath, destPath, { recursive: true, force: true })
      // Attempt cleanup of source, but don't fail if it doesn't work
      // (the destination was successfully created)
      try {
        await rm(sourcePath, { recursive: true, force: true })
      } catch (cleanupError) {
        logDebug('Failed to clean up source after copy', {
          sourcePath,
          destPath,
          error:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        })
      }
    } else {
      throw error
    }
  }
}

/**
 * Injectable fs operations for ensureExecutable (used by tests to simulate
 * read-only filesystems without touching real mount options).
 */
export type EnsureExecutableOptions = {
  /** Target mode when a chmod is needed (default 0o755) */
  mode?: number
  /** Override for fs.promises.stat (tests) */
  statFn?: (path: string) => Promise<{ mode: number }>
  /** Override for fs.promises.chmod (tests) */
  chmodFn?: (path: string, mode: number) => Promise<void>
  /** Override for fs.promises.access (tests) */
  accessFn?: (path: string, mode?: number) => Promise<void>
}

/**
 * Ensure a file has its executable bits set, without writing to filesystems
 * that are already correct.
 *
 * Invariant: post-extract setup must be a no-op against an already-correct
 * read-only binary store. Layerbase cloud mounts a shared binary store
 * read-only at ~/.spindb/bin inside user containers; an unconditional chmod
 * against a file that is already 0o755 throws EROFS there and fails the
 * whole create (seen with QuestDB's questdb.sh).
 *
 * Behavior:
 * 1. If all executable bits are already set, return without writing.
 * 2. Otherwise attempt chmod(mode).
 * 3. If chmod fails with EROFS/EPERM/EACCES (read-only or unwritable store),
 *    tolerate the failure ONLY when an access(X_OK) check confirms the file
 *    is already executable; otherwise rethrow the original error loudly.
 */
export async function ensureExecutable(
  filePath: string,
  options: EnsureExecutableOptions = {},
): Promise<void> {
  const {
    mode = 0o755,
    statFn = stat,
    chmodFn = chmod,
    accessFn = access,
  } = options

  const stats = await statFn(filePath)
  const execBits = 0o111
  if ((stats.mode & execBits) === execBits) {
    // Already executable everywhere - never write (the store may be read-only)
    return
  }

  try {
    await chmodFn(filePath, mode)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const unwritableCodes = ['EROFS', 'EPERM', 'EACCES']
    if (typeof code === 'string' && unwritableCodes.includes(code)) {
      try {
        await accessFn(filePath, constants.X_OK)
        logDebug(
          `chmod failed with ${code} but file is already executable, continuing`,
          { filePath },
        )
        return
      } catch {
        // Not executable and we cannot make it so - fall through and fail loudly
      }
    }
    throw error
  }
}

/**
 * Check if an error indicates a port is already in use
 */
export function isPortInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  // Check error code first (more reliable than message parsing)
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') {
    return true
  }

  // Fall back to message-based detection
  const message = error.message.toLowerCase()
  return (
    message.includes('address already in use') ||
    message.includes('eaddrinuse') ||
    (message.includes('port') && message.includes('in use')) ||
    message.includes('could not bind') ||
    message.includes('socket already in use')
  )
}
