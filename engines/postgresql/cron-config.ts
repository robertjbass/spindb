import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readFile, writeFile, rename, rm } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { logDebug } from '../../core/error-handler'
import { getLibraryEnv } from '../../core/library-env'
import type { QueryResult } from '../../types'

const execFileAsync = promisify(execFile)

export function mergeCronPreload(value: string): string {
  // Keep PostgreSQL's quoting of other library names intact.
  const libraries = value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
  if (
    libraries.some((library) =>
      ['pg_cron', '"pg_cron"'].includes(library.trim()),
    )
  )
    return value
  return value.trim() ? `${value},pg_cron` : 'pg_cron'
}

function configString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

export function updatePostgresSettings(
  content: string,
  settings: Record<string, string>,
): string {
  const keys = new Set(Object.keys(settings))
  const lines = content.split(/\r?\n/).filter((line) => {
    const key = /^\s*([a-zA-Z_][a-zA-Z_0-9.]*)\s*=/.exec(line)?.[1]
    return !key || !keys.has(key.toLowerCase())
  })
  return `${lines.join('\n').trimEnd()}\n${Object.entries(settings)
    .map(([key, value]) => `${key} = ${configString(value)}`)
    .join('\n')}\n`
}

export async function persistPostgresSettings(
  dataDir: string,
  settings: Record<string, string>,
): Promise<void> {
  const path = join(dataDir, 'postgresql.auto.conf')
  const original = existsSync(path) ? await readFile(path, 'utf8') : ''
  const updated = updatePostgresSettings(original, settings)
  if (updated === original) return
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, updated, { mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export const CRON_MARKER_FILE = '.spindb-pg-cron.json'

const CRON_LIBRARY_FILES = ['pg_cron.so', 'pg_cron.dylib', 'pg_cron.dll']
const CRON_EXTENSION_FILES = [
  'pg_cron.control',
  'pg_cron--1.0.sql',
  'pg_cron--1.5--1.6.sql',
]

/**
 * Whether a PostgreSQL binary directory contains pg_cron: its shared library
 * plus the extension control and install scripts. This is the capability
 * check; the version name of the binary says nothing about it, because hostdb
 * ships pg_cron inside standard builds on some platforms only, and a version
 * cached before its rebuild lacks it.
 */
export function hasPgCron(binPath: string): boolean {
  return (
    CRON_LIBRARY_FILES.some((file) => existsSync(join(binPath, 'lib', file))) &&
    CRON_EXTENSION_FILES.every((file) =>
      existsSync(join(binPath, 'share', 'extension', file)),
    )
  )
}

/**
 * Actionable reason used when an opted-in database's binary lacks pg_cron.
 * hostdb builds pg_cron into its Linux x64 PostgreSQL builds only, so a
 * refresh is suggested there and nowhere else.
 */
export function missingCronReason(
  binPath: string,
  options: { version?: string; platformKey?: string } = {},
): string {
  const { version } = options
  const platformKey =
    options.platformKey ?? `${process.platform}-${process.arch}`
  const label = version ? `PostgreSQL ${version}` : 'PostgreSQL'
  const missing = `the ${label} binary at ${binPath} does not include pg_cron`
  if (platformKey !== 'linux-x64') {
    return `${missing}. hostdb includes pg_cron only in its Linux x64 PostgreSQL builds, not ${platformKey}`
  }
  return (
    `${missing}. A version downloaded before hostdb added pg_cron to its build stays cached without it: ` +
    `stop the database and run \`spindb engines download postgresql ${version ?? '<version>'} --refresh\` to replace the cached copy with the current build ` +
    `(if the refreshed build still lacks pg_cron, that version does not ship it)`
  )
}

function splitPreloads(value: string): string[] {
  return value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
}

function isCron(library: string): boolean {
  return /(?:^|\/)pg_cron(?:\.so)?$/.test(library.trim().replace(/^"|"$/g, ''))
}

function lastConfiguredPreloads(content: string): string | null {
  let value: string | null = null
  for (const line of content.split(/\r?\n/)) {
    const match =
      /^\s*shared_preload_libraries\s*=?\s*(?:'((?:[^']|'')*)'|([^\s#]*))/i.exec(
        line,
      )
    if (match) value = (match[1] ?? match[2] ?? '').replace(/''/g, "'")
  }
  return value
}

/**
 * Whether a stopped data directory is opted into pg_cron, read from files
 * without running a binary: the marker SpinDB writes once pg_cron is
 * configured, or pg_cron in the configured preload list (postgresql.auto.conf
 * takes precedence over postgresql.conf, as in PostgreSQL). Used to keep an
 * opted-in database off binaries that lack pg_cron when its own binary is
 * missing; the per-start probe in configurePostgresCron stays authoritative.
 */
export async function isPostgresCronOptedIn(dataDir: string): Promise<boolean> {
  if (existsSync(join(dataDir, CRON_MARKER_FILE))) return true
  for (const file of ['postgresql.auto.conf', 'postgresql.conf']) {
    const path = join(dataDir, file)
    if (!existsSync(path)) continue
    const preloads = lastConfiguredPreloads(await readFile(path, 'utf8'))
    if (preloads !== null) return splitPreloads(preloads).some(isCron)
  }
  return false
}

/**
 * After `ALTER SYSTEM SET cron.launch_active_jobs = off` and pg_reload_conf(),
 * wait until the pause is in effect: new sessions report it and no pg_cron job
 * worker is still running. Workers that were already mid-run are terminated,
 * as a server stop would; client sessions are left connected.
 */
export async function waitForCronPause(
  query: (sql: string) => Promise<QueryResult>,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10000
  const pollMs = options.pollMs ?? 250
  const deadline = Date.now() + timeoutMs
  // pg_reload_conf() only signals the postmaster; each query is a new session.
  let paused = false
  let idleChecks = 0
  while (Date.now() <= deadline) {
    if (!paused) {
      const { rows } = await query(
        "SELECT current_setting('cron.launch_active_jobs') AS enabled",
      )
      paused = String(rows[0]?.enabled) === 'off'
    }
    if (paused) {
      const { rows } = await query(
        "SELECT count(pg_terminate_backend(pid)) AS running FROM pg_stat_activity WHERE backend_type = 'pg_cron'",
      )
      idleChecks = String(rows[0]?.running) === '0' ? idleChecks + 1 : 0
      // Two clean polls cover a job the launcher started just before reloading.
      if (idleChecks >= 2) return
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(
    `pg_cron did not pause within ${timeoutMs / 1000}s. cron.launch_active_jobs = off is saved in postgresql.auto.conf, so jobs stay paused once it applies. Restore has not begun; inspect the server log before retrying.`,
  )
}

/** Only call while PostgreSQL is stopped, before its first postmaster starts. */
export async function configurePostgresCron(options: {
  binPath: string
  dataDir: string
  database: string
  /** Version of the binary at binPath, used in the refresh instructions. */
  version?: string
  onWarning?: (message: string) => void
}): Promise<boolean> {
  const { binPath, dataDir, database } = options
  const markerPath = join(dataDir, CRON_MARKER_FILE)
  const hasCronFiles = hasPgCron(binPath)
  if (!existsSync(join(binPath, 'bin', 'postgres'))) return false

  async function setting(key: string): Promise<string> {
    const { stdout } = await execFileAsync(
      join(binPath, 'bin', 'postgres'),
      ['-D', dataDir, '-C', key],
      { timeout: 10000, env: { ...process.env, ...getLibraryEnv(binPath) } },
    )
    return stdout.trim()
  }

  // This probe runs on every start, including for databases that never opted
  // in, so a failure or timeout must not block the start. State is left as
  // is: an opted-in database keeps its marker and auto.conf untouched.
  let preloads: string
  try {
    preloads = await setting('shared_preload_libraries')
  } catch (error) {
    logDebug('pg_cron preload probe failed; starting without changes', {
      dataDir,
      error: String(error),
    })
    return false
  }
  const libraries = splitPreloads(preloads)
  if (!libraries.some(isCron)) {
    await rm(markerPath, { force: true })
    return false
  }
  async function disableCron(reason: string): Promise<false> {
    await persistPostgresSettings(dataDir, {
      shared_preload_libraries: libraries
        .filter((library) => !isCron(library))
        .join(','),
      'cron.launch_active_jobs': 'off',
    })
    await rm(markerPath, { force: true })
    const message = `pg_cron disabled: ${reason}. Jobs are paused and definitions retained. Fix the cause, add pg_cron back to shared_preload_libraries, restart, then explicitly resume jobs.`
    logDebug(message, { dataDir })
    options.onWarning?.(message)
    return false
  }
  if (!hasCronFiles)
    return disableCron(missingCronReason(binPath, { version: options.version }))
  const workers = Number(await setting('max_worker_processes'))
  if (!Number.isInteger(workers) || workers < 2) {
    return disableCron('max_worker_processes must be at least 2')
  }

  const settings: Record<string, string> = {
    'cron.use_background_workers': 'on',
    'cron.max_running_jobs': String(Math.min(2, workers - 1)),
  }
  // An existing installation may keep its catalog in another logical database.
  try {
    settings['cron.database_name'] =
      (await setting('cron.database_name')) || database
  } catch (error) {
    if (!String(error).includes('unrecognized configuration parameter'))
      throw error
    settings['cron.database_name'] = database
  }
  // Deliberately preserve cron.launch_active_jobs, including a copied database's pause.
  await persistPostgresSettings(dataDir, settings)
  await writeFile(
    markerPath,
    JSON.stringify({ database: settings['cron.database_name'] }),
    { mode: 0o600 },
  )
  return true
}
