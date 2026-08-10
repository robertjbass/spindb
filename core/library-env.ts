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
 * {binPath}/lib is PREPENDED to any value the caller already has, never
 * substituted for it. Callers spread the result over process.env
 * (`{ ...process.env, ...getLibraryEnv(binPath) }`), so returning a bare
 * value silently dropped a user's own LD_LIBRARY_PATH / DYLD_FALLBACK_LIBRARY_PATH
 * for the spawned engine - which breaks anyone who relies on it to resolve
 * their own libraries. Prepending keeps our bundled copy winning while
 * leaving their search path intact behind it.
 *
 * Usage: spread into spawn env: `{ ...process.env, ...getLibraryEnv(binPath) }`
 */
export function getLibraryEnv(
  binPath: string,
): Record<string, string> | undefined {
  const plat = osPlatform()
  const libDir = join(binPath, 'lib')

  if (plat === 'darwin') {
    return {
      DYLD_FALLBACK_LIBRARY_PATH: prependPath(
        libDir,
        process.env.DYLD_FALLBACK_LIBRARY_PATH,
        ':',
      ),
    }
  }
  if (plat === 'linux') {
    return {
      LD_LIBRARY_PATH: prependPath(libDir, process.env.LD_LIBRARY_PATH, ':'),
    }
  }
  return undefined
}

/**
 * Puts `dir` at the front of an existing search path, preserving whatever was
 * already there. An absent or empty existing value yields just `dir`, so no
 * caller ever gets a stray leading or trailing separator.
 *
 * Exported for tests: it is the whole of the prepend-not-replace behavior, and
 * testing it directly is the only way to cover the Windows separator on a
 * non-Windows CI runner.
 */
export function prependPath(
  dir: string,
  existing: string | undefined,
  separator: string,
): string {
  return existing ? `${dir}${separator}${existing}` : dir
}

/**
 * Returns env vars that add a directory to the Windows DLL search path.
 * PREPENDS the directory to the existing PATH environment variable.
 * Returns undefined on non-Windows platforms (not needed).
 *
 * Use for engines that bundle DLLs in subdirectories that aren't on the
 * default search path (e.g., InfluxDB's python/ directory containing
 * python313.dll needed at load time).
 *
 * Prepend rather than append: this exists to make OUR bundled DLL resolve,
 * and appending loses to any same-named DLL already reachable on PATH. A
 * stray python313.dll of a different build then wins, which produces a
 * second, harder-to-read failure than the missing-DLL one this fixes.
 *
 * Usage: spread into spawn env: `{ ...process.env, ...getWindowsDllEnv(dllDir) }`
 */
export function getWindowsDllEnv(
  dllDir: string,
): Record<string, string> | undefined {
  if (osPlatform() !== 'win32') return undefined
  return { PATH: prependPath(dllDir, process.env.PATH, ';') }
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
