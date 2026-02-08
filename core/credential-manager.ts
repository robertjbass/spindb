/**
 * Credential Manager
 *
 * Manages saved database credentials on disk.
 * Credentials are stored as .env files in the container's credentials/ directory.
 */

import { existsSync } from 'fs'
import { readFile, writeFile, readdir, mkdir, chmod } from 'fs/promises'
import { join } from 'path'
import { paths } from '../config/paths'
import { Engine, type UserCredentials } from '../types'
import { isValidUsername } from './error-handler'

/**
 * Get the credentials directory for a container.
 */
function getCredentialsDir(containerName: string, engine: Engine): string {
  const containerPath = paths.getContainerPath(containerName, { engine })
  return join(containerPath, 'credentials')
}

/**
 * Get the credential file path for a specific username.
 * Validates the username to prevent path traversal (same rules as assertValidUsername).
 */
function getCredentialFilePath(
  containerName: string,
  engine: Engine,
  username: string,
): string {
  if (!isValidUsername(username)) {
    throw new Error(
      `Invalid username for credential file: "${username}". Must match ^[a-zA-Z][a-zA-Z0-9_]{0,62}$`,
    )
  }
  return join(getCredentialsDir(containerName, engine), `.env.${username}`)
}

/**
 * Format credentials as .env file content.
 */
function encodeEnvValue(value: string): string {
  if (/[\n\r=\\]/.test(value)) {
    return JSON.stringify(value)
  }
  return value
}

function decodeEnvValue(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string
    } catch {
      return raw
    }
  }
  return raw
}

function formatCredentials(credentials: UserCredentials): string {
  const lines: string[] = []

  if (credentials.apiKey) {
    lines.push(`API_KEY_NAME=${encodeEnvValue(credentials.username)}`)
    lines.push(`API_KEY=${encodeEnvValue(credentials.apiKey)}`)
    lines.push(`API_URL=${encodeEnvValue(credentials.connectionString)}`)
  } else {
    lines.push(`DB_USER=${encodeEnvValue(credentials.username)}`)
    lines.push(`DB_PASSWORD=${encodeEnvValue(credentials.password)}`)
    // Extract host and port from the connection string.
    // Use URL parsing when possible; fall back to a regex targeting host:port.
    let extractedHost: string | undefined
    let extractedPort: string | undefined
    try {
      const url = new URL(credentials.connectionString)
      if (url.hostname) {
        extractedHost = url.hostname
      }
      if (url.port) {
        extractedPort = url.port
      }
    } catch {
      // Not a valid URL (e.g. custom scheme). Use regex targeting host:port segment.
      const hostPortMatch = credentials.connectionString.match(
        /@(\[[^\]]+\]|[^:/?#]+):(\d+)(?:\/|$)/,
      )
      if (hostPortMatch) {
        extractedHost = hostPortMatch[1].replace(/^\[|\]$/g, '')
        extractedPort = hostPortMatch[2]
      }
    }
    lines.push(`DB_HOST=${extractedHost || '127.0.0.1'}`)
    if (extractedPort) {
      lines.push(`DB_PORT=${extractedPort}`)
    }
    if (credentials.database) {
      lines.push(`DB_NAME=${encodeEnvValue(credentials.database)}`)
    }
    lines.push(`DB_URL=${encodeEnvValue(credentials.connectionString)}`)
  }

  return lines.join('\n') + '\n'
}

/**
 * Parse a .env credential file back into UserCredentials.
 */
function parseCredentialFile(
  content: string,
  containerName: string,
  engine: Engine,
): UserCredentials {
  const vars: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = line.indexOf('=')
    if (eqIdx === -1) continue
    const key = line.slice(0, eqIdx).trim()
    const rawValue = line.slice(eqIdx + 1).trim()
    vars[key] = decodeEnvValue(rawValue)
  }

  // API key credentials: password is intentionally empty (auth uses API key, not password)
  if (vars.API_KEY) {
    if (!vars.API_KEY_NAME || !vars.API_URL) {
      throw new Error(
        `Corrupt credential file for container "${containerName}": missing API_KEY_NAME or API_URL`,
      )
    }
    return {
      username: vars.API_KEY_NAME,
      password: '', // API-based auth does not use a password
      connectionString: vars.API_URL,
      engine,
      container: containerName,
      apiKey: vars.API_KEY,
    }
  }

  // Empty string DB_PASSWORD is intentionally allowed (some DBs permit passwordless connections)
  if (!vars.DB_USER || vars.DB_PASSWORD === undefined || !vars.DB_URL) {
    throw new Error(
      `Corrupt credential file for container "${containerName}": missing DB_USER, DB_PASSWORD, or DB_URL`,
    )
  }

  return {
    username: vars.DB_USER,
    password: vars.DB_PASSWORD,
    connectionString: vars.DB_URL,
    engine,
    container: containerName,
    database: vars.DB_NAME,
  }
}

/**
 * Save credentials to disk as a .env file.
 * Creates the credentials/ directory if it doesn't exist.
 * @returns The path to the saved credential file.
 */
export async function saveCredentials(
  containerName: string,
  engine: Engine,
  credentials: UserCredentials,
): Promise<string> {
  const credDir = getCredentialsDir(containerName, engine)
  if (!existsSync(credDir)) {
    await mkdir(credDir, { recursive: true, mode: 0o700 })
  }

  const filePath = getCredentialFilePath(
    containerName,
    engine,
    credentials.username,
  )
  await writeFile(filePath, formatCredentials(credentials), {
    encoding: 'utf-8',
    mode: 0o600,
  })

  // POSIX file permissions are no-ops on Windows
  if (process.platform !== 'win32') {
    await chmod(credDir, 0o700)
    await chmod(filePath, 0o600)
  }
  return filePath
}

/**
 * Load credentials for a specific username from disk.
 * Returns null if the credential file doesn't exist.
 */
export async function loadCredentials(
  containerName: string,
  engine: Engine,
  username: string,
): Promise<UserCredentials | null> {
  const filePath = getCredentialFilePath(containerName, engine, username)
  try {
    const content = await readFile(filePath, 'utf-8')
    return parseCredentialFile(content, containerName, engine)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * List all saved credential usernames for a container.
 * Returns an empty array if no credentials directory exists.
 */
export async function listCredentials(
  containerName: string,
  engine: Engine,
): Promise<string[]> {
  const credDir = getCredentialsDir(containerName, engine)
  if (!existsSync(credDir)) {
    return []
  }

  const files = await readdir(credDir)
  return files
    .filter((f) => f.startsWith('.env.'))
    .map((f) => f.slice(5)) // Remove '.env.' prefix
    .sort()
}

/**
 * Check if credentials exist for a specific username.
 */
export function credentialsExist(
  containerName: string,
  engine: Engine,
  username: string,
): boolean {
  return existsSync(getCredentialFilePath(containerName, engine, username))
}

/**
 * Get the default username for a given engine.
 * API key engines use 'search_key' or 'api_key', all others use 'spindb'.
 */
export function getDefaultUsername(engine: Engine): string {
  switch (engine) {
    case Engine.Meilisearch:
      return 'search_key'
    case Engine.Qdrant:
      return 'api_key'
    default:
      return 'spindb'
  }
}
