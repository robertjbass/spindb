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
  onWarning?: (message: string) => void
}): Promise<boolean> {
  const { binPath, dataDir, database } = options
  const markerPath = join(dataDir, '.spindb-pg-cron.json')
  const hasCronFiles = !(
    !existsSync(join(binPath, 'lib', 'pg_cron.so')) ||
    !existsSync(join(binPath, 'share', 'extension', 'pg_cron.control')) ||
    !existsSync(join(binPath, 'share', 'extension', 'pg_cron--1.0.sql')) ||
    !existsSync(join(binPath, 'share', 'extension', 'pg_cron--1.5--1.6.sql'))
  )
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
  const libraries = preloads.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
  function isCron(library: string): boolean {
    return /(?:^|\/)pg_cron(?:\.so)?$/.test(
      library.trim().replace(/^"|"$/g, ''),
    )
  }
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
  if (!hasCronFiles) return disableCron('the installed binary lacks pg_cron')
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
