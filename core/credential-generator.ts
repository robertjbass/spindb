/**
 * Credential Generator
 *
 * Generates secure random credentials for Docker exports.
 * Uses Node.js crypto module for cryptographically secure random values.
 */

import { randomBytes } from 'crypto'

// Character sets for password generation
const LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'
const UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
// Shell-safe symbols only (no # $ & * ? \ ' " ` ! | ; < > etc.)
const SYMBOLS = '%+-=@^_'

// Default character set (alphanumeric + shell-safe symbols)
const DEFAULT_CHARSET = LOWERCASE + UPPERCASE + DIGITS + SYMBOLS

// Alphanumeric only (for systems that don't support special chars)
const ALPHANUMERIC_CHARSET = LOWERCASE + UPPERCASE + DIGITS

// Canonical length for a generated database credential.
//
// Shared credential spec (ADR-001,
// layerbase-cloud/docs/decisions/001-credential-charsets.md): the standard
// generated DB password is 24 alphanumeric characters. The same spec is
// implemented in layerbase-cloud's `src/lib/credentials.ts`; both repos run
// conformance tests so the two cannot re-drift.
export const DEFAULT_PASSWORD_LENGTH = 24

export type PasswordOptions = {
  // Length of the password (default: 16)
  length?: number
  // Use alphanumeric only (no special characters)
  alphanumericOnly?: boolean
  // Custom character set to use
  charset?: string
}

/**
 * Generate a cryptographically secure random password
 * @param options Password generation options
 * @returns Generated password string
 */
export function generatePassword(options: PasswordOptions = {}): string {
  const { length = 16, alphanumericOnly = false, charset } = options

  const chars =
    charset || (alphanumericOnly ? ALPHANUMERIC_CHARSET : DEFAULT_CHARSET)

  // Rejection sampling: discard bytes >= maxValid to eliminate modulo bias.
  // Without this, characters at indices 0..(256 % chars.length - 1) would
  // appear slightly more often than the rest. Over-allocate each draw by 16
  // bytes so a charset length that rejects many bytes still finishes quickly.
  const maxValid = 256 - (256 % chars.length)
  let password = ''
  while (password.length < length) {
    const bytes = randomBytes(length - password.length + 16)
    for (let i = 0; i < bytes.length && password.length < length; i++) {
      if (bytes[i] < maxValid) {
        password += chars[bytes[i] % chars.length]
      }
    }
  }

  return password
}

/**
 * Generate a random hex string (for API keys, tokens, etc.)
 * @param byteLength Number of random bytes (output will be 2x this length in hex)
 * @returns Hex string
 */
export function generateHexToken(byteLength: number = 32): string {
  return randomBytes(byteLength).toString('hex')
}

/**
 * Generate a random alphanumeric ID (for container names, etc.)
 * @param length Length of the ID
 * @returns Alphanumeric string
 */
export function generateId(length: number = 8): string {
  return generatePassword({ length, alphanumericOnly: true }).toLowerCase()
}

export type Credentials = {
  username: string
  password: string
}

/**
 * Generate standard credentials for a Docker export
 * Uses alphanumeric only to avoid issues with special characters in:
 * - Connection strings (@ is a separator, % needs URL encoding)
 * - Environment variable parsing (= can cause issues)
 * - SQL/shell commands (quotes, backslashes need escaping)
 * @returns Object with username and password
 */
export function generateCredentials(): Credentials {
  return {
    username: 'spindb',
    password: generatePassword({
      length: DEFAULT_PASSWORD_LENGTH,
      alphanumericOnly: true,
    }),
  }
}
