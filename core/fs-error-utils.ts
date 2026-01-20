/**
 * Filesystem Error Utilities
 *
 * Shared error detection functions for filesystem and network operations.
 */

/**
 * Check if an error is a filesystem error that should trigger cp fallback
 * - EXDEV: cross-device link (rename across filesystems)
 * - EPERM: permission error (Windows filesystem operations)
 */
export function isRenameFallbackError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && ['EXDEV', 'EPERM'].includes(code)
}

/**
 * Check if an error indicates a port is already in use
 */
export function isPortInUseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('address already in use') ||
    message.includes('eaddrinuse') ||
    (message.includes('port') && message.includes('in use')) ||
    message.includes('could not bind') ||
    message.includes('socket already in use')
  )
}
