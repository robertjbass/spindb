/**
 * Error Handler
 *
 * Centralized error handling with proper logging and user feedback.
 * - CLI commands log and exit (no blocking for scripts/CI)
 * - Interactive menu uses "Press Enter to continue" pattern
 * - All errors are logged to ~/.spindb/spindb.log for debugging
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import chalk from 'chalk'

// Get SpinDB home directory without circular import
function getSpinDBRoot(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return join(home, '.spindb')
}

export type ErrorSeverity = 'fatal' | 'error' | 'warning' | 'info'

export type SpinDBErrorInfo = {
  code: string
  message: string
  severity: ErrorSeverity
  suggestion?: string
  context?: Record<string, unknown>
}

export const ErrorCodes = {
  // Port errors
  PORT_IN_USE: 'PORT_IN_USE',
  PORT_PERMISSION_DENIED: 'PORT_PERMISSION_DENIED',
  PORT_RANGE_EXHAUSTED: 'PORT_RANGE_EXHAUSTED',

  // Process errors
  PROCESS_START_FAILED: 'PROCESS_START_FAILED',
  PROCESS_STOP_TIMEOUT: 'PROCESS_STOP_TIMEOUT',
  PROCESS_ALREADY_RUNNING: 'PROCESS_ALREADY_RUNNING',
  PROCESS_NOT_RUNNING: 'PROCESS_NOT_RUNNING',
  PID_FILE_CORRUPT: 'PID_FILE_CORRUPT',
  PID_FILE_STALE: 'PID_FILE_STALE',
  PID_FILE_READ_FAILED: 'PID_FILE_READ_FAILED',

  // Restore errors
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  RESTORE_PARTIAL_FAILURE: 'RESTORE_PARTIAL_FAILURE',
  RESTORE_COMPLETE_FAILURE: 'RESTORE_COMPLETE_FAILURE',
  BACKUP_FORMAT_UNKNOWN: 'BACKUP_FORMAT_UNKNOWN',
  WRONG_ENGINE_DUMP: 'WRONG_ENGINE_DUMP',

  // Container errors
  CONTAINER_NOT_FOUND: 'CONTAINER_NOT_FOUND',
  CONTAINER_ALREADY_EXISTS: 'CONTAINER_ALREADY_EXISTS',
  CONTAINER_RUNNING: 'CONTAINER_RUNNING',
  CONTAINER_CREATE_FAILED: 'CONTAINER_CREATE_FAILED',
  INIT_FAILED: 'INIT_FAILED',
  DATABASE_CREATE_FAILED: 'DATABASE_CREATE_FAILED',
  INVALID_DATABASE_NAME: 'INVALID_DATABASE_NAME',

  // Dependency errors
  DEPENDENCY_MISSING: 'DEPENDENCY_MISSING',
  DEPENDENCY_VERSION_INCOMPATIBLE: 'DEPENDENCY_VERSION_INCOMPATIBLE',

  // Rollback errors
  ROLLBACK_FAILED: 'ROLLBACK_FAILED',

  // Clipboard errors
  CLIPBOARD_FAILED: 'CLIPBOARD_FAILED',

  // General errors
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export class SpinDBError extends Error {
  public readonly code: string
  public readonly severity: ErrorSeverity
  public readonly suggestion?: string
  public readonly context?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    severity: ErrorSeverity = 'error',
    suggestion?: string,
    context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'SpinDBError'
    this.code = code
    this.severity = severity
    this.suggestion = suggestion
    this.context = context

    // Capture proper stack trace
    Error.captureStackTrace(this, SpinDBError)
  }

  /**
   * Create SpinDBError from an unknown error
   */
  static from(
    error: unknown,
    code: string = ErrorCodes.UNKNOWN_ERROR,
    suggestion?: string,
  ): SpinDBError {
    if (error instanceof SpinDBError) {
      return error
    }

    const message = error instanceof Error ? error.message : String(error)

    return new SpinDBError(code, message, 'error', suggestion, {
      originalError: error instanceof Error ? error.stack : undefined,
    })
  }
}

function getLogPath(): string {
  return join(getSpinDBRoot(), 'spindb.log')
}

/**
 * Ensure the log directory exists
 */
function ensureLogDirectory(): void {
  const logPath = getLogPath()
  const logDir = dirname(logPath)
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }
}

/**
 * Append a structured log entry to the log file
 */
function appendToLogFile(entry: SpinDBErrorInfo): void {
  try {
    ensureLogDirectory()
    const logPath = getLogPath()
    const logEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    }
    appendFileSync(logPath, JSON.stringify(logEntry) + '\n')
  } catch {
    // If we can't write to log file, don't fail the operation
    // This could happen if ~/.spindb doesn't exist yet
  }
}

/**
 * Format severity for console output
 */
function formatSeverity(severity: ErrorSeverity): string {
  switch (severity) {
    case 'fatal':
      return chalk.red.bold('[FATAL]')
    case 'error':
      return chalk.red('[ERROR]')
    case 'warning':
      return chalk.yellow('[WARN]')
    case 'info':
      return chalk.blue('[INFO]')
  }
}

/**
 * Log an error to console and log file
 * This is for CLI commands - displays error and returns (no blocking)
 */
export function logError(error: SpinDBErrorInfo): void {
  // Console output with colors
  const prefix = formatSeverity(error.severity)
  console.error(`${prefix} [${error.code}] ${error.message}`)

  if (error.suggestion) {
    console.error(chalk.yellow(`  Suggestion: ${error.suggestion}`))
  }

  // Also append to log file for headless debugging
  appendToLogFile(error)
}

/**
 * Log a SpinDBError instance
 */
export function logSpinDBError(error: SpinDBError): void {
  logError({
    code: error.code,
    message: error.message,
    severity: error.severity,
    suggestion: error.suggestion,
    context: error.context,
  })
}

/**
 * Log a warning (non-blocking, yellow output)
 */
export function logWarning(
  message: string,
  context?: Record<string, unknown>,
): void {
  console.warn(chalk.yellow(`  ⚠ ${message}`))

  appendToLogFile({
    code: 'WARNING',
    message,
    severity: 'warning',
    context,
  })
}

/**
 * Log an info message
 */
export function logInfo(
  message: string,
  context?: Record<string, unknown>,
): void {
  appendToLogFile({
    code: 'INFO',
    message,
    severity: 'info',
    context,
  })
}

/**
 * Log a debug message (only to file, not console)
 */
export function logDebug(
  message: string,
  context?: Record<string, unknown>,
): void {
  appendToLogFile({
    code: 'DEBUG',
    message,
    severity: 'info',
    context,
  })
}

export function createPortInUseError(port: number): SpinDBError {
  return new SpinDBError(
    ErrorCodes.PORT_IN_USE,
    `Port ${port} is already in use`,
    'error',
    `Use a different port with -p flag, or stop the process using port ${port}`,
    { port },
  )
}

/**
 * Create a container-not-found error
 */
export function createContainerNotFoundError(name: string): SpinDBError {
  return new SpinDBError(
    ErrorCodes.CONTAINER_NOT_FOUND,
    `Container "${name}" not found`,
    'error',
    'Run "spindb list" to see available containers',
    { containerName: name },
  )
}

/**
 * Create a version mismatch error for pg_restore
 */
export function createVersionMismatchError(
  dumpVersion: string,
  toolVersion: string,
): SpinDBError {
  return new SpinDBError(
    ErrorCodes.VERSION_MISMATCH,
    `Backup was created with PostgreSQL ${dumpVersion}, but your pg_restore is version ${toolVersion}`,
    'fatal',
    `Install PostgreSQL ${dumpVersion} client tools: brew install postgresql@${dumpVersion}`,
    { dumpVersion, toolVersion },
  )
}

/**
 * Create a dependency missing error
 */
export function createDependencyMissingError(
  toolName: string,
  engine: string,
): SpinDBError {
  const suggestions: Record<string, string> = {
    psql: 'brew install libpq && brew link --force libpq',
    pg_dump: 'brew install libpq && brew link --force libpq',
    pg_restore: 'brew install libpq && brew link --force libpq',
    mysql: 'brew install mysql-client',
    mysqldump: 'brew install mysql-client',
    mysqld: 'brew install mysql',
  }

  return new SpinDBError(
    ErrorCodes.DEPENDENCY_MISSING,
    `${toolName} not found`,
    'error',
    suggestions[toolName] || `Install ${engine} client tools`,
    { toolName, engine },
  )
}

/**
 * Validate a database name to prevent SQL injection.
 * Database names must start with a letter and contain only
 * alphanumeric characters and underscores.
 *
 * Note: Hyphens are excluded because they require quoted identifiers
 * in SQL, which is error-prone for users.
 */
export function isValidDatabaseName(name: string): boolean {
  // Must start with a letter to be valid in all database systems
  // Hyphens excluded to avoid requiring quoted identifiers in SQL
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)
}

/**
 * Assert that a database name is valid, throwing SpinDBError if not.
 * Use this at the entry points where database names are accepted.
 */
export function assertValidDatabaseName(name: string): void {
  if (!isValidDatabaseName(name)) {
    throw new SpinDBError(
      ErrorCodes.INVALID_DATABASE_NAME,
      `Invalid database name: "${name}"`,
      'error',
      'Database names must start with a letter and contain only letters, numbers, and underscores',
      { databaseName: name },
    )
  }
}
