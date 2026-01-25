/**
 * Filesystem Error Utilities
 *
 * Shared error detection and file operation functions for filesystem operations.
 */

import { rename, cp, rm } from 'fs/promises'
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
