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

  // Connection errors
  CONNECTION_FAILED: 'CONNECTION_FAILED',

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

  // Create SpinDBError from an unknown error
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

/**
 * Error thrown when a required CLI tool is missing (e.g., psql, pg_dump, mysql).
 * Used to trigger installation prompts in the interactive menu.
 */
export class MissingToolError extends Error {
  public readonly tool: string

  constructor(tool: string, message?: string) {
    super(message ?? `${tool} not found`)
    this.name = 'MissingToolError'
    this.tool = tool
    Error.captureStackTrace(this, MissingToolError)
  }
}

function getLogPath(): string {
  return join(getSpinDBRoot(), 'spindb.log')
}

function ensureLogDirectory(): void {
  const logPath = getLogPath()
  const logDir = dirname(logPath)
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true })
  }
}

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

// Logs an error to console and log file (non-blocking for CLI commands).
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

export function logSpinDBError(error: SpinDBError): void {
  logError({
    code: error.code,
    message: error.message,
    severity: error.severity,
    suggestion: error.suggestion,
    context: error.context,
  })
}

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

// Logs a debug message (only to file, not console).
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

export function createContainerNotFoundError(name: string): SpinDBError {
  return new SpinDBError(
    ErrorCodes.CONTAINER_NOT_FOUND,
    `Container "${name}" not found`,
    'error',
    'Run "spindb list" to see available containers',
    { containerName: name },
  )
}

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

// Validates a database name to prevent SQL injection.
// Hyphens are excluded because they require quoted identifiers in SQL.
export function isValidDatabaseName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)
}

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

/**
 * Check if the current process is running in an interactive terminal.
 * Returns true if stdin is a TTY (user can interact with prompts).
 */
export function isInteractiveMode(): boolean {
  return Boolean(process.stdin.isTTY)
}

/**
 * Wait for user to press Enter before continuing.
 * Only shows the prompt in interactive mode.
 */
async function waitForEnter(): Promise<void> {
  if (!isInteractiveMode()) {
    return
  }

  return new Promise((resolve) => {
    process.stdout.write(chalk.gray('\nPress Enter to continue...'))
    try {
      // Disable raw mode so Enter key works normally (not just any keypress)
      // setRawMode may fail if stdin is not a TTY (already checked above, but guard anyway)
      process.stdin.setRawMode?.(false)
      process.stdin.resume()
      process.stdin.once('data', () => {
        process.stdin.pause()
        resolve()
      })
    } catch {
      // If stdin operations fail (e.g., stdin closed), just resolve immediately
      resolve()
    }
  })
}

/**
 * Exit the process with an error, optionally waiting for user input in interactive mode.
 * This provides a better UX for interactive CLI usage while maintaining
 * proper exit codes for scripts and CI pipelines.
 *
 * @param options.message - Error message to display
 * @param options.code - Exit code (default: 1)
 * @param options.json - If true, output error as JSON and skip interactive prompt
 */
export async function exitWithError(options: {
  message: string
  code?: number
  json?: boolean
}): Promise<never> {
  const { message, code = 1, json = false } = options

  if (json) {
    console.log(JSON.stringify({ error: message }))
  } else {
    console.error(chalk.red(`\n  ✕ ${message}`))

    // In interactive mode, wait for user to press Enter before exiting
    // This gives users time to read the error message
    if (isInteractiveMode()) {
      await waitForEnter()
    }
  }

  process.exit(code)
}
