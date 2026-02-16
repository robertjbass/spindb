/**
 * Library environment utilities for dynamically-linked engine binaries.
 *
 * MariaDB, Redis, and Valkey hostdb binaries are linked against Homebrew's
 * OpenSSL at absolute paths (e.g. /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib).
 * On systems without that library, they fail with cryptic dyld errors.
 *
 * This module provides:
 * - getLibraryEnv(): sets DYLD_FALLBACK_LIBRARY_PATH / LD_LIBRARY_PATH so
 *   the dynamic linker checks {binPath}/lib first (preparing for when hostdb
 *   bundles dylibs alongside binaries).
 * - detectLibraryError(): scans process output for library-loading patterns
 *   and returns an actionable error message.
 */

import { platform as osPlatform } from 'os'
import { join } from 'path'

/**
 * Returns env vars that point the dynamic linker at {binPath}/lib.
 * On macOS: DYLD_FALLBACK_LIBRARY_PATH
 * On Linux: LD_LIBRARY_PATH
 * On Windows: returns undefined (not applicable).
 *
 * Usage: spread into spawn env: `{ ...process.env, ...getLibraryEnv(binPath) }`
 */
export function getLibraryEnv(
  binPath: string,
): Record<string, string> | undefined {
  const plat = osPlatform()
  const libDir = join(binPath, 'lib')

  if (plat === 'darwin') {
    return { DYLD_FALLBACK_LIBRARY_PATH: libDir }
  }
  if (plat === 'linux') {
    return { LD_LIBRARY_PATH: libDir }
  }
  return undefined
}

/**
 * Scans stderr/log output for dynamic library loading errors and returns
 * an actionable message, or null if no library error was detected.
 */
export function detectLibraryError(
  output: string,
  engineName: string,
): string | null {
  if (!output) return null

  const plat = osPlatform()
  const lower = output.toLowerCase()

  // macOS dyld errors
  if (
    lower.includes('library not loaded') ||
    lower.includes('dyld:') ||
    lower.includes('dyld[')
  ) {
    const needsOpenssl = lower.includes('libssl') || lower.includes('libcrypto')

    if (needsOpenssl && plat === 'darwin') {
      return (
        `${engineName} failed to start: missing OpenSSL libraries.\n` +
        `The downloaded binary requires OpenSSL 3 which is not installed.\n` +
        `Fix: brew install openssl@3\n` +
        `Alternatively, re-download binaries after hostdb ships relocatable builds.`
      )
    }

    return (
      `${engineName} failed to start: a required dynamic library could not be loaded.\n` +
      `This typically means the hostdb binary was built against libraries not present on this system.\n` +
      (plat === 'darwin'
        ? `Try: brew install openssl@3\n`
        : `Try: sudo apt-get install libssl-dev  (or the equivalent for your distro)\n`) +
      `See: https://github.com/robertjbass/hostdb/issues`
    )
  }

  // Linux GLIBC version errors
  if (lower.includes('glibc') || lower.includes('libc.so')) {
    return (
      `${engineName} failed to start: incompatible system C library (GLIBC).\n` +
      `The downloaded binary requires a newer GLIBC version than is installed.\n` +
      `Options:\n` +
      `  - Upgrade your OS to a newer version\n` +
      `  - Use Docker: spindb can run inside containers with newer GLIBC\n` +
      `See: https://github.com/robertjbass/hostdb/issues`
    )
  }

  // Generic shared library errors on Linux
  if (
    lower.includes('error while loading shared libraries') ||
    lower.includes('cannot open shared object file')
  ) {
    const needsOpenssl = lower.includes('libssl') || lower.includes('libcrypto')

    if (needsOpenssl) {
      return (
        `${engineName} failed to start: missing OpenSSL libraries.\n` +
        `Fix: sudo apt-get install libssl-dev  (Debian/Ubuntu)\n` +
        `     sudo dnf install openssl-devel   (Fedora/RHEL)\n` +
        `See: https://github.com/robertjbass/hostdb/issues`
      )
    }

    return (
      `${engineName} failed to start: a required shared library is missing.\n` +
      `Check the error output above for the specific library name and install it.\n` +
      `See: https://github.com/robertjbass/hostdb/issues`
    )
  }

  return null
}
