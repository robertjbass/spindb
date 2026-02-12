/**
 * List backups command
 *
 * Scans the current directory (or specified directory) for backup files
 * and displays them with metadata.
 */

import { Command } from 'commander'
import { readdirSync, statSync } from 'fs'
import { join, extname } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'
import { formatBytes } from '../ui/theme'
import { getEngineIcon } from '../constants'

type BackupInfo = {
  filename: string
  path: string
  size: number
  modified: Date
  engine: string | null
  format: string
}

// Detect engine and format from file extension
function detectBackupType(filename: string): {
  engine: string | null
  format: string
} {
  const ext = extname(filename).toLowerCase()

  // Check for double extensions like .sql.gz
  if (filename.endsWith('.sql.gz')) {
    return { engine: 'mysql', format: 'Compressed SQL' }
  }

  switch (ext) {
    case '.sql':
      // Could be PostgreSQL, MySQL, or SQLite
      return { engine: null, format: 'SQL dump' }
    case '.dump':
      return { engine: 'postgresql', format: 'pg_dump custom' }
    case '.sqlite':
    case '.db':
    case '.sqlite3':
      return { engine: 'sqlite', format: 'Binary copy' }
    case '.duckdb':
    case '.ddb':
      return { engine: 'duckdb', format: 'Binary copy' }
    case '.archive':
      return { engine: 'mongodb', format: 'BSON archive' }
    case '.rdb':
      return { engine: 'redis', format: 'RDB snapshot' }
    case '.redis':
      return { engine: 'redis', format: 'Text commands' }
    case '.bson':
      return { engine: 'mongodb', format: 'BSON' }
    default:
      return { engine: null, format: 'Unknown' }
  }
}

// Check if a file looks like a backup file
function isBackupFile(filename: string): boolean {
  const backupExtensions = [
    '.sql',
    '.dump',
    '.sqlite',
    '.sqlite3',
    '.db',
    '.duckdb',
    '.ddb',
    '.archive',
    '.rdb',
    '.redis',
    '.bson',
  ]

  // Check for .sql.gz
  if (filename.endsWith('.sql.gz')) return true

  const ext = extname(filename).toLowerCase()
  return backupExtensions.includes(ext)
}

// Scan directory for backup files
function findBackups(directory: string): BackupInfo[] {
  const backups: BackupInfo[] = []

  try {
    const files = readdirSync(directory)

    for (const file of files) {
      if (!isBackupFile(file)) continue

      const filePath = join(directory, file)
      try {
        const stats = statSync(filePath)
        if (!stats.isFile()) continue

        const { engine, format } = detectBackupType(file)

        backups.push({
          filename: file,
          path: filePath,
          size: stats.size,
          modified: stats.mtime,
          engine,
          format,
        })
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }

  // Sort by modified date, newest first
  backups.sort((a, b) => b.modified.getTime() - a.modified.getTime())

  return backups
}

// Format a relative time string
function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`

  return date.toLocaleDateString()
}

// Get engine icon - wraps the shared function with fallback for null/unknown engines
function getBackupEngineIcon(engine: string | null): string {
  if (!engine) return '📦 '
  return getEngineIcon(engine)
}

export const backupsCommand = new Command('backups')
  .description('List backup files in current directory')
  .argument('[directory]', 'Directory to scan (defaults to current directory)')
  .option('-a, --all', 'Include backups from ~/.spindb/backups as well')
  .option('-n, --limit <count>', 'Limit number of results', '20')
  .option('-j, --json', 'Output as JSON')
  .action(
    async (
      directory: string | undefined,
      options: {
        all?: boolean
        limit?: string
        json?: boolean
      },
    ) => {
      const searchDirs = [directory || process.cwd()]

      if (options.all) {
        const homeBackups = join(homedir(), '.spindb', 'backups')
        searchDirs.push(homeBackups)
      }

      const allBackups: BackupInfo[] = []

      for (const dir of searchDirs) {
        const backups = findBackups(dir)
        allBackups.push(...backups)
      }

      // Sort all backups by date
      allBackups.sort((a, b) => b.modified.getTime() - a.modified.getTime())

      // Apply limit
      const limit = parseInt(options.limit || '20', 10)
      const limitedBackups = allBackups.slice(0, limit)

      if (options.json) {
        console.log(
          JSON.stringify(
            limitedBackups.map((b) => ({
              filename: b.filename,
              path: b.path,
              size: b.size,
              modified: b.modified.toISOString(),
              engine: b.engine,
              format: b.format,
            })),
            null,
            2,
          ),
        )
        return
      }

      if (limitedBackups.length === 0) {
        console.log()
        console.log(chalk.gray('  No backup files found'))
        console.log()
        console.log(chalk.gray('  Backup files are identified by extensions:'))
        console.log(
          chalk.gray('    .sql, .dump, .sqlite, .archive, .rdb, .sql.gz'),
        )
        console.log()
        return
      }

      console.log()
      console.log(chalk.bold(`  Found ${allBackups.length} backup(s)`))
      if (allBackups.length > limit) {
        console.log(chalk.gray(`  (showing ${limit} most recent)`))
      }
      console.log()

      // Calculate column widths
      const maxFilename = Math.min(
        50,
        Math.max(...limitedBackups.map((b) => b.filename.length)),
      )

      for (const backup of limitedBackups) {
        const icon = getBackupEngineIcon(backup.engine)
        const filename =
          backup.filename.length > maxFilename
            ? backup.filename.slice(0, maxFilename - 3) + '...'
            : backup.filename.padEnd(maxFilename)

        const size = formatBytes(backup.size).padStart(10)
        const time = formatRelativeTime(backup.modified).padStart(10)
        const format = chalk.gray(backup.format)

        console.log(
          `  ${icon} ${chalk.cyan(filename)} ${chalk.white(size)} ${chalk.gray(time)} ${format}`,
        )
      }

      console.log()
      console.log(chalk.gray('  Restore with:'))
      console.log(chalk.cyan('    spindb restore <container> <backup-file>'))
      console.log()
    },
  )
