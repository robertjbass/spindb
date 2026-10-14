import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configurePostgresCron,
  mergeCronPreload,
  persistPostgresSettings,
  updatePostgresSettings,
} from '../../engines/postgresql/cron-config'

test('cron configuration preserves other preload libraries and quoted names', () => {
  assert.equal(mergeCronPreload(''), 'pg_cron')
  assert.equal(
    mergeCronPreload('"prefix,pg_cron,suffix"'),
    '"prefix,pg_cron,suffix",pg_cron',
  )
  assert.equal(
    mergeCronPreload('"library,with,commas",pg_stat_statements'),
    '"library,with,commas",pg_stat_statements,pg_cron',
  )
  assert.equal(
    mergeCronPreload('pg_stat_statements, "pg_cron"'),
    'pg_stat_statements, "pg_cron"',
  )
})

test('auto configuration replaces effective assignments without dropping unrelated settings', () => {
  const settings = {
    'cron.launch_active_jobs': 'off',
    'cron.database_name': "tenant's db",
  }
  const value = updatePostgresSettings(
    '# retained\nCRON.LAUNCH_ACTIVE_JOBS = on\nmax_connections = 123\ncron.launch_active_jobs = on\n',
    settings,
  )
  assert.match(value, /max_connections = 123/)
  assert.match(value, /cron.database_name = 'tenant''s db'/)
  assert.equal(value.match(/cron.launch_active_jobs/gi)?.length, 1)
  assert.equal(updatePostgresSettings(value, settings), value)
})

test('unsupported artifacts do not modify configuration; pause persistence is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spindb-cron-'))
  try {
    const path = join(root, 'postgresql.auto.conf')
    await writeFile(path, '# original\n')
    assert.equal(
      await configurePostgresCron({
        binPath: root,
        dataDir: root,
        database: 'postgres',
      }),
      false,
    )
    assert.equal(await readFile(path, 'utf8'), '# original\n')
    await persistPostgresSettings(root, { 'cron.launch_active_jobs': 'off' })
    const paused = await readFile(path, 'utf8')
    await persistPostgresSettings(root, { 'cron.launch_active_jobs': 'off' })
    assert.equal(await readFile(path, 'utf8'), paused)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
