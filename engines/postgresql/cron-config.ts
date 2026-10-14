import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { readFile, writeFile, rename, rm } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { getLibraryEnv } from '../../core/library-env'

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

/** Only call while PostgreSQL is stopped, before its first postmaster starts. */
export async function configurePostgresCron(options: {
  binPath: string
  dataDir: string
  database: string
}): Promise<boolean> {
  const { binPath, dataDir, database } = options
  // Old and unsupported artifacts keep their existing startup behavior.
  if (
    !existsSync(join(binPath, 'lib', 'pg_cron.so')) ||
    !existsSync(join(binPath, 'share', 'extension', 'pg_cron.control')) ||
    !existsSync(join(binPath, 'share', 'extension', 'pg_cron--1.0.sql')) ||
    !existsSync(join(binPath, 'share', 'extension', 'pg_cron--1.5--1.6.sql'))
  )
    return false

  async function setting(key: string): Promise<string> {
    const { stdout } = await execFileAsync(
      join(binPath, 'bin', 'postgres'),
      ['-D', dataDir, '-C', key],
      { timeout: 10000, env: { ...process.env, ...getLibraryEnv(binPath) } },
    )
    return stdout.trim()
  }

  const preloads = await setting('shared_preload_libraries')
  const workers = Number(await setting('max_worker_processes'))
  if (!Number.isInteger(workers) || workers < 2) {
    if (mergeCronPreload(preloads) === preloads) {
      throw new Error(
        'pg_cron needs a launcher and a job worker. Set max_worker_processes to at least 2 before starting.',
      )
    }
    return false
  }
  const settings: Record<string, string> = {
    shared_preload_libraries: mergeCronPreload(preloads),
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
  return true
}
