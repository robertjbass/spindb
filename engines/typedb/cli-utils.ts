/**
 * TypeDB CLI utilities
 *
 * Helper functions for working with TypeDB command-line tools.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../../config/paths'
import { configManager } from '../../core/config-manager'
import { platformService } from '../../core/platform-service'
import { normalizeVersion } from './version-maps'

export const TYPEDB_NOT_FOUND_ERROR =
  'TypeDB binary not found. Run: spindb engines download typedb <version>'

/**
 * Classify a TypeQL query into the TypeDB transaction type it requires.
 *
 * TypeDB 3.x has three transaction types and rejects a query run under the
 * wrong one (`[TSV8]` for schema, `[TSV9]` for data). The whole query buffer
 * is one transaction, so the classification must look at the *entire* query,
 * not just the leading keyword - a `match $x ...; insert (...) isa rel;`
 * pipeline starts with `match` but is a write.
 *
 *   - schema: contains define / undefine / redefine
 *   - write:  contains a data-mutation clause (insert / delete / update / put)
 *   - read:   anything else (match / fetch / reduce / sort / ...)
 *
 * Schema wins over write, and write wins over read. Line comments (`#` and
 * `//`) and string literals are stripped first, so keywords inside a comment or
 * a value (e.g. `insert ... has title "define the roadmap"`) don't trigger a
 * false match.
 *
 * This mirrors layerbase-cloud's `detectTypedbTxType` - the two must stay in
 * lockstep so the desktop (via spindb) and the cloud classify identically.
 */
export function detectTypedbTxType(query: string): 'read' | 'write' | 'schema' {
  const stripped = query
    .replace(/#[^\n]*/g, '') // strip `#` line comments
    .replace(/\/\/[^\n]*/g, '') // strip `//` line comments
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // blank string literals so keywords
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // inside values don't trigger a match
    .toUpperCase()

  if (/\b(?:DEFINE|UNDEFINE|REDEFINE)\b/.test(stripped)) return 'schema'
  if (/\b(?:INSERT|DELETE|UPDATE|PUT)\b/.test(stripped)) return 'write'
  return 'read'
}

/** Default TypeDB credentials (TypeDB 3.x requires authentication) */
export const TYPEDB_DEFAULT_USERNAME = 'admin'
export const TYPEDB_DEFAULT_PASSWORD = 'password'

/**
 * Offset from the gRPC (main) port to TypeDB's HTTP API port. Defaults to
 * 6271 so the stock 1729 gRPC maps to TypeDB's default 8000 HTTP.
 *
 * Override with SPINDB_TYPEDB_HTTP_OFFSET (a positive integer). Layerbase
 * cloud sets a small in-block offset so the HTTP port can be published to
 * the host alongside gRPC inside the user's port block - the default 6271
 * lands far outside a published block and is unreachable from the host
 * (which is why cloud otherwise has to shell HTTP calls through
 * `docker exec`). Like detectTypedbTxType, the default must stay in
 * lockstep with layerbase-cloud's TYPEDB_HTTP_PORT_OFFSET.
 */
export const DEFAULT_TYPEDB_HTTP_OFFSET = 6271

export function typedbHttpOffset(): number {
  const raw = process.env.SPINDB_TYPEDB_HTTP_OFFSET
  if (!raw) return DEFAULT_TYPEDB_HTTP_OFFSET
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TYPEDB_HTTP_OFFSET
}

/**
 * The HTTP API port for a TypeDB server whose gRPC (main) port is
 * `basePort`. All spindb code paths that talk to the HTTP API - config.yml
 * generation, the start-time port-availability check, the status probe, and
 * the HTTP query client - derive the port through this one function so they
 * stay consistent under an SPINDB_TYPEDB_HTTP_OFFSET override.
 */
export function typedbHttpPort(basePort: number): number {
  return basePort + typedbHttpOffset()
}

/**
 * Recover the HTTP offset a TypeDB container was created with by reading its
 * existing config.yml. spindb regenerates config.yml on every start, so the
 * offset must persist across restarts as a property of the container -
 * otherwise a container created with a non-default SPINDB_TYPEDB_HTTP_OFFSET
 * would silently move its HTTP port the next time it starts (re-reading the
 * process env, which may differ or be unset), breaking any caller that
 * expects the original port. This matters when one host runs many TypeDB
 * containers with different offsets: each config.yml is its own source of
 * truth.
 *
 * config.yml lists the gRPC `server.address` first, then the
 * `http.address`, so the offset is simply (http port - gRPC port). Returns
 * null when the config can't be parsed (e.g. a fresh create, before any
 * config exists), so callers fall back to the env/default offset.
 */
export function parseTypedbHttpOffsetFromConfig(
  configYml: string,
): number | null {
  const ports = [...configYml.matchAll(/address:\s*[\d.]+:(\d+)/g)].map((m) =>
    Number.parseInt(m[1], 10),
  )
  const [grpcPort, httpPort] = ports
  if (!Number.isInteger(grpcPort) || !Number.isInteger(httpPort)) return null
  const offset = httpPort - grpcPort
  return offset > 0 ? offset : null
}

/**
 * Get standard TypeDB console connection arguments including authentication.
 * TypeDB 3.x requires --username and --password for all console operations.
 *
 * @param tlsDisabled - When true (the default for local dev), appends --tls-disabled.
 *   Pass false when connecting to a TLS-enabled TypeDB server.
 */
export function getConsoleBaseArgs(
  port: number,
  host = '127.0.0.1',
  tlsDisabled = true,
  auth?: { username?: string; password?: string },
): string[] {
  const args = [
    '--address',
    `${host}:${port}`,
    ...(tlsDisabled ? ['--tls-disabled'] : []),
    '--username',
    auth?.username || TYPEDB_DEFAULT_USERNAME,
    '--password',
    auth?.password || TYPEDB_DEFAULT_PASSWORD,
  ]
  return args
}

/**
 * Get the path to the typedb launcher binary
 *
 * First checks the config cache, then scans the downloaded binaries directory.
 * Returns null if not found.
 */
export async function getTypeDBPath(): Promise<string | null> {
  // Check config cache first
  const cached = await configManager.getBinaryPath('typedb')
  if (cached && existsSync(cached)) {
    return cached
  }

  // Fall back to filesystem scan using the same logic as getTypeDBPathForVersion
  const { TYPEDB_VERSION_MAP } = await import('./version-maps')
  for (const version of Object.values(TYPEDB_VERSION_MAP)) {
    const found = await getTypeDBPathForVersion(version)
    if (found) {
      await configManager.setBinaryPath('typedb', found, 'bundled')
      return found
    }
  }

  return null
}

/**
 * Get the typedb binary path for a specific version
 */
export async function getTypeDBPathForVersion(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  // TypeDB launcher is a .bat script on Windows, no extension on other platforms
  const batExt = platform === 'win32' ? '.bat' : ''

  const binPath = paths.getBinaryPath({
    engine: 'typedb',
    version: fullVersion,
    platform,
    arch,
  })

  const typedbPath = join(binPath, 'bin', `typedb${batExt}`)
  if (existsSync(typedbPath)) {
    return typedbPath
  }

  return null
}

/**
 * Get the typedb_console_bin path for a specific version
 */
export async function getTypeDBConsolePath(
  version: string,
): Promise<string | null> {
  const { platform, arch } = platformService.getPlatformInfo()
  const fullVersion = normalizeVersion(version)
  const ext = platformService.getExecutableExtension()

  const binPath = paths.getBinaryPath({
    engine: 'typedb',
    version: fullVersion,
    platform,
    arch,
  })

  const consolePath = join(
    binPath,
    'bin',
    'console',
    `typedb_console_bin${ext}`,
  )
  if (existsSync(consolePath)) {
    return consolePath
  }

  return null
}

/**
 * Require the typedb binary path, throwing if not found
 */
export async function requireTypeDBPath(version?: string): Promise<string> {
  // If version provided, look for that specific version
  if (version) {
    const path = await getTypeDBPathForVersion(version)
    if (path) {
      return path
    }
  }

  // Try config cache
  const cached = await getTypeDBPath()
  if (cached) {
    return cached
  }

  throw new Error(TYPEDB_NOT_FOUND_ERROR)
}

/**
 * Require the typedb_console_bin path, throwing if not found
 */
export async function requireTypeDBConsolePath(
  version?: string,
): Promise<string> {
  if (version) {
    const path = await getTypeDBConsolePath(version)
    if (path) {
      return path
    }
  }

  // Try config cache
  const cached = await configManager.getBinaryPath('typedb_console_bin')
  if (cached && existsSync(cached)) {
    return cached
  }

  // Fall back to scanning all installed versions (same pattern as requireTypeDBPath)
  const { TYPEDB_VERSION_MAP } = await import('./version-maps')
  for (const ver of Object.values(TYPEDB_VERSION_MAP)) {
    const found = await getTypeDBConsolePath(ver)
    if (found) {
      return found
    }
  }

  throw new Error(
    'TypeDB console binary not found. Run: spindb engines download typedb <version>',
  )
}

/**
 * Validate a TypeDB identifier (database name)
 * TypeDB identifiers follow specific rules:
 * - Start with letter or underscore
 * - Contain letters, digits, underscores, dashes
 * - Max 63 characters
 *
 * @throws Error if identifier is invalid
 */
export function validateTypeDBIdentifier(
  identifier: string,
  type: 'database' = 'database',
): void {
  if (!identifier) {
    throw new Error(`${type} name cannot be empty`)
  }

  if (identifier.length > 63) {
    throw new Error(`${type} name cannot exceed 63 characters`)
  }

  // TypeDB allows alphanumeric, underscores, and dashes
  const validPattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/
  if (!validPattern.test(identifier)) {
    throw new Error(
      `Invalid ${type} name "${identifier}". ` +
        `Must start with a letter or underscore and contain only letters, digits, underscores, and dashes.`,
    )
  }
}
