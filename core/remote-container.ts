/**
 * Remote Container Utilities
 *
 * Utility functions for parsing, detecting, and managing remote database connections.
 * Used by the `spindb link` command and remote container operations.
 */

import { Engine, assertExhaustive } from '../types'
import type { RemoteConnectionConfig } from '../types'

export type ParsedConnectionString = {
  scheme: string
  host: string
  port: number | null
  database: string
  username: string
  password: string
  params: Record<string, string>
  raw: string
}

/**
 * Parse a database connection string into its components.
 * Supports postgresql://, mysql://, mongodb://, mongodb+srv://, redis://, rediss://, http://, https://
 */
export function parseConnectionString(url: string): ParsedConnectionString {
  const raw = url.trim()

  // Handle mongodb+srv:// by temporarily replacing for URL parsing
  const normalizedUrl = raw.replace(
    /^mongodb\+srv:\/\//,
    'mongodb+srv-placeholder://',
  )

  let parsed: URL
  try {
    // For schemes URL doesn't understand, replace with http for parsing
    const parseableUrl = normalizedUrl
      .replace(/^postgresql:\/\//, 'http://')
      .replace(/^postgres:\/\//, 'http://')
      .replace(/^mysql:\/\//, 'http://')
      .replace(/^mongodb:\/\//, 'http://')
      .replace(/^mongodb\+srv-placeholder:\/\//, 'http://')
      .replace(/^redis:\/\//, 'http://')
      .replace(/^rediss:\/\//, 'http://')

    parsed = new URL(parseableUrl)
  } catch {
    throw new Error(
      `Invalid connection string: "${raw}". Expected format: scheme://[user:pass@]host[:port]/database`,
    )
  }

  // Extract the original scheme
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//)
  const scheme = schemeMatch ? schemeMatch[1].toLowerCase() : ''

  // Extract params
  const params: Record<string, string> = {}
  parsed.searchParams.forEach((value, key) => {
    params[key] = value
  })

  // Remove leading slash from pathname for database name
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''))

  return {
    scheme,
    host: decodeURIComponent(parsed.hostname),
    port: parsed.port ? parseInt(parsed.port, 10) : null,
    database,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    params,
    raw,
  }
}

/**
 * Detect the database engine from a connection string's scheme.
 * Returns null if the scheme is ambiguous (http/https) or unknown.
 */
export function detectEngineFromConnectionString(url: string): Engine | null {
  const scheme = url.trim().split('://')[0]?.toLowerCase()

  switch (scheme) {
    case 'postgresql':
    case 'postgres':
      return Engine.PostgreSQL
    case 'mysql':
      return Engine.MySQL
    case 'mongodb':
    case 'mongodb+srv':
      return Engine.MongoDB
    case 'redis':
    case 'rediss':
      return Engine.Redis
    default:
      return null
  }
}

type ProviderPattern = {
  pattern: RegExp
  name: string
}

const PROVIDER_PATTERNS: ProviderPattern[] = [
  { pattern: /\.neon\.tech$/i, name: 'neon' },
  { pattern: /\.supabase\.(co|com)$/i, name: 'supabase' },
  { pattern: /\.planetscale\.com$/i, name: 'planetscale' },
  { pattern: /\.cockroachlabs\.cloud$/i, name: 'cockroachdb-cloud' },
  { pattern: /\.upstash\.io$/i, name: 'upstash' },
  { pattern: /\.railway\.app$/i, name: 'railway' },
  { pattern: /\.aiven\.io$/i, name: 'aiven' },
]

/**
 * Detect the cloud provider from a hostname.
 * Returns null if no known provider pattern matches.
 */
export function detectProvider(host: string): string | null {
  for (const { pattern, name } of PROVIDER_PATTERNS) {
    if (pattern.test(host)) {
      return name
    }
  }
  return null
}

/**
 * Check if a host is localhost (127.0.0.1, localhost, ::1)
 */
export function isLocalhost(host: string): boolean {
  return (
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]'
  )
}

/**
 * Generate a container name for a remote database.
 * Uses provider and database name, or falls back to host-based naming.
 */
export function generateRemoteContainerName(options: {
  engine: Engine
  host: string
  database: string
  provider?: string | null
}): string {
  const { engine, host, database, provider } = options

  // Use provider + database if available
  if (provider && database) {
    return sanitizeName(`${provider}-${database}`)
  }

  // Use provider + engine if no database
  if (provider) {
    return sanitizeName(`${provider}-${engine}`)
  }

  // Use database + remote prefix
  if (database) {
    return sanitizeName(`remote-${database}`)
  }

  // Fallback: extract host prefix
  const hostPrefix = host.split('.')[0]
  return sanitizeName(`remote-${hostPrefix}`)
}

/**
 * Sanitize a string to be a valid container name.
 * Must start with a letter and contain only alphanumeric, hyphens, underscores.
 */
function sanitizeName(name: string): string {
  // Replace any non-alphanumeric characters with hyphens
  let sanitized = name.replace(/[^a-zA-Z0-9-_]/g, '-')

  // Remove consecutive hyphens
  sanitized = sanitized.replace(/-+/g, '-')

  // Remove leading/trailing hyphens
  sanitized = sanitized.replace(/^-+|-+$/g, '')

  // Ensure starts with a letter
  if (!/^[a-zA-Z]/.test(sanitized)) {
    sanitized = `db-${sanitized}`
  }

  // Truncate to reasonable length
  if (sanitized.length > 50) {
    sanitized = sanitized.slice(0, 50)
  }

  return sanitized || 'remote-db'
}

/**
 * Redact a connection string by replacing the password with ***.
 * Handles both standard URL-encoded passwords and edge cases.
 */
export function redactConnectionString(url: string): string {
  try {
    const parsed = parseConnectionString(url)
    if (!parsed.password) {
      return url
    }
    // Replace the password in the raw URL
    const encodedPassword = encodeURIComponent(parsed.password)
    return url
      .replace(`:${encodedPassword}@`, ':***@')
      .replace(`:${parsed.password}@`, ':***@')
  } catch {
    // If parsing fails, try a regex-based approach
    return url.replace(/:([^@/:]+)@/, ':***@')
  }
}

/**
 * Build a RemoteConnectionConfig from parsed connection info.
 */
export function buildRemoteConfig(options: {
  host: string
  connectionString: string
  provider?: string | null
  ssl?: boolean
}): RemoteConnectionConfig {
  const { host, connectionString, provider } = options

  // Default SSL to true for non-localhost connections
  const ssl = options.ssl ?? !isLocalhost(host)

  return {
    host,
    connectionString: redactConnectionString(connectionString),
    ssl,
    ...(provider && { provider }),
  }
}

/**
 * Get the default port for an engine (used when connection string omits port).
 */
export function getDefaultPortForEngine(engine: Engine): number {
  switch (engine) {
    case Engine.PostgreSQL:
      return 5432
    case Engine.MySQL:
    case Engine.MariaDB:
      return 3306
    case Engine.MongoDB:
    case Engine.FerretDB:
      return 27017
    case Engine.Redis:
    case Engine.Valkey:
      return 6379
    case Engine.ClickHouse:
      return 8123
    case Engine.CockroachDB:
      return 26257
    case Engine.SurrealDB:
      return 8000
    case Engine.Qdrant:
      return 6333
    case Engine.Meilisearch:
      return 7700
    case Engine.CouchDB:
      return 5984
    case Engine.QuestDB:
      return 8812
    case Engine.InfluxDB:
      return 8086
    case Engine.Weaviate:
      return 8080
    case Engine.TypeDB:
      return 1729
    case Engine.TigerBeetle:
      return 3001
    case Engine.SQLite:
    case Engine.DuckDB:
      return 0
    default:
      assertExhaustive(engine, `Unknown engine: ${engine}`)
  }
}
