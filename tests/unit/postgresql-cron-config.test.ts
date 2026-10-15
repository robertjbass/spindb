import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configurePostgresCron,
  hasPgCron,
  isPostgresCronOptedIn,
  mergeCronPreload,
  missingCronReason,
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
        version: '18.6.0',
        onWarning: (message) => warnings.push(message),
      })
      assert.match(
        warnings[1],
        /PostgreSQL 18\.6\.0 binary at .* does not include pg_cron/,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test(
  'a failing preload probe does not block start and leaves cron state untouched',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cron-probe-'))
    try {
      await mkdir(join(root, 'bin'), { recursive: true })
      await writeFile(
        join(root, 'bin/postgres'),
        '#!/bin/sh\necho "probe failed" >&2\nexit 1\n',
        { mode: 0o755 },
      )
      const markerPath = join(root, '.spindb-pg-cron.json')
      const autoConfPath = join(root, 'postgresql.auto.conf')
      const marker = JSON.stringify({ database: 'postgres' })
      const autoConf = "shared_preload_libraries = 'pg_cron'\n"
      await writeFile(markerPath, marker)
      await writeFile(autoConfPath, autoConf)
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
      assert.equal(await readFile(markerPath, 'utf8'), marker)
      assert.equal(await readFile(autoConfPath, 'utf8'), autoConf)
      assert.deepEqual(warnings, [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

test('pg_cron support is detected from the binary contents, not its version name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cron-probe-files-'))
  try {
    assert.equal(hasPgCron(root), false)
    await mkdir(join(root, 'lib'), { recursive: true })
    await mkdir(join(root, 'share/extension'), { recursive: true })
    await writeFile(join(root, 'lib/pg_cron.so'), '')
    assert.equal(hasPgCron(root), false, 'library without extension files')
    for (const file of [
      'pg_cron.control',
      'pg_cron--1.0.sql',
      'pg_cron--1.5--1.6.sql',
    ])
      await writeFile(join(root, 'share/extension', file), '')
    assert.equal(hasPgCron(root), true)
    await rm(join(root, 'share/extension/pg_cron.control'))
    assert.equal(hasPgCron(root), false, 'control file is required')
    await writeFile(join(root, 'share/extension/pg_cron.control'), '')
    await rm(join(root, 'lib/pg_cron.so'))
    await writeFile(join(root, 'lib/pg_cron.dylib'), '')
    assert.equal(hasPgCron(root), true, 'macOS library suffix')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a binary without pg_cron gets platform-specific recovery instructions', () => {
  const linux = missingCronReason('/bin/postgresql-18.6.0-linux-x64', {
    version: '18.6.0',
    platformKey: 'linux-x64',
  })
  assert.match(
    linux,
    /PostgreSQL 18\.6\.0 binary at \/bin\/postgresql-18\.6\.0-linux-x64/,
  )
  assert.match(linux, /spindb engines download postgresql 18\.6\.0 --refresh/)
  const mac = missingCronReason('/bin/postgresql-18.6.0-darwin-arm64', {
    version: '18.6.0',
    platformKey: 'darwin-arm64',
  })
  assert.match(mac, /only in its Linux x64 PostgreSQL builds, not darwin-arm64/)
  assert.doesNotMatch(mac, /--refresh/)
})

test('opt-in is read from the marker or the configured preload list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cron-opt-in-'))
  try {
    assert.equal(await isPostgresCronOptedIn(root), false, 'empty data dir')
    await writeFile(
      join(root, 'postgresql.conf'),
      "#shared_preload_libraries = 'pg_cron'\nshared_preload_libraries = 'pg_stat_statements'\n",
    )
    assert.equal(await isPostgresCronOptedIn(root), false, 'commented line')
    await writeFile(
      join(root, 'postgresql.conf'),
      'shared_preload_libraries = \'pg_stat_statements,"pg_cron"\'\n',
    )
    assert.equal(await isPostgresCronOptedIn(root), true, 'postgresql.conf')
    await writeFile(
      join(root, 'postgresql.auto.conf'),
      "shared_preload_libraries = 'pg_cron'\nshared_preload_libraries = 'pg_stat_statements'\n",
    )
    assert.equal(
      await isPostgresCronOptedIn(root),
      false,
      'last postgresql.auto.conf assignment wins over postgresql.conf',
    )
    await writeFile(join(root, '.spindb-pg-cron.json'), '{}')
    assert.equal(await isPostgresCronOptedIn(root), true, 'marker')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
