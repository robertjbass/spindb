/**
 * Credential Manager
 *
 * Manages saved database credentials on disk.
 * Credentials are stored as .env files in the container's credentials/ directory.
 */

import { existsSync } from 'fs'
import { readFile, writeFile, readdir, mkdir } from 'fs/promises'
import { join } from 'path'
import { paths } from '../config/paths'
import { Engine, type UserCredentials } from '../types'

/**
 * Get the credentials directory for a container.
 */
function getCredentialsDir(containerName: string, engine: Engine): string {
  const containerPath = paths.getContainerPath(containerName, { engine })
  return join(containerPath, 'credentials')
}

/**
 * Get the credential file path for a specific username.
 */
function getCredentialFilePath(
  containerName: string,
  engine: Engine,
  username: string,
): string {
  return join(getCredentialsDir(containerName, engine), `.env.${username}`)
}

/**
 * Format credentials as .env file content.
 */
function formatCredentials(credentials: UserCredentials): string {
  const lines: string[] = []

  if (credentials.apiKey) {
    lines.push(`API_KEY_NAME=${credentials.username}`)
    lines.push(`API_KEY=${credentials.apiKey}`)
    lines.push(`API_URL=${credentials.connectionString}`)
  } else {
    lines.push(`DB_USER=${credentials.username}`)
    lines.push(`DB_PASSWORD=${credentials.password}`)
    lines.push(`DB_HOST=127.0.0.1`)
    const portMatch = credentials.connectionString.match(/:(\d+)/)
    if (portMatch) {
      lines.push(`DB_PORT=${portMatch[1]}`)
    }
    if (credentials.database) {
      lines.push(`DB_NAME=${credentials.database}`)
    }
    lines.push(`DB_URL=${credentials.connectionString}`)
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
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
  }

  if (vars.API_KEY) {
    return {
      username: vars.API_KEY_NAME || '',
      password: '',
      connectionString: vars.API_URL || '',
      engine,
      container: containerName,
      apiKey: vars.API_KEY,
    }
  }

  return {
    username: vars.DB_USER || '',
    password: vars.DB_PASSWORD || '',
    connectionString: vars.DB_URL || '',
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
    await mkdir(credDir, { recursive: true })
  }

  const filePath = getCredentialFilePath(
    containerName,
    engine,
    credentials.username,
  )
  await writeFile(filePath, formatCredentials(credentials), 'utf-8')
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
  if (!existsSync(filePath)) {
    return null
  }

  const content = await readFile(filePath, 'utf-8')
  return parseCredentialFile(content, containerName, engine)
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
