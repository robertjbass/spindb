import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

test(
  'low worker capacity pauses cron without blocking SQL startup and reports recovery',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cron-workers-'))
    try {
      for (const dir of ['bin', 'lib', 'share/extension'])
        await mkdir(join(root, dir), { recursive: true })
      for (const file of [
        'lib/pg_cron.so',
        'share/extension/pg_cron.control',
        'share/extension/pg_cron--1.0.sql',
        'share/extension/pg_cron--1.5--1.6.sql',
      ])
        await writeFile(join(root, file), '')
      await writeFile(
        join(root, 'bin/postgres'),
        `#!/bin/sh
case "$4" in
shared_preload_libraries) echo 'pg_stat_statements,pg_cron' ;;
max_worker_processes) echo 1 ;;
esac
`,
        { mode: 0o755 },
      )
      const warnings: string[] = []
      assert.equal(
        await configurePostgresCron({
          binPath: root,
          dataDir: root,
          database: 'postgres',
          onWarning: (message) => warnings.push(message),
        }),
        false,
      )
      const conf = await readFile(join(root, 'postgresql.auto.conf'), 'utf8')
      assert.match(conf, /shared_preload_libraries = 'pg_stat_statements'/)
      assert.match(conf, /cron.launch_active_jobs = 'off'/)
      assert.match(warnings[0], /max_worker_processes must be at least 2/)
      await rm(join(root, 'lib/pg_cron.so'))
      await configurePostgresCron({
        binPath: root,
        dataDir: root,
        database: 'postgres',
        onWarning: (message) => warnings.push(message),
      })
      assert.match(warnings[1], /installed binary lacks pg_cron/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
