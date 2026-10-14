import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, appendFile, readFile, rm, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import {
  configurePostgresCron,
  persistPostgresSettings,
} from '../../engines/postgresql/cron-config'

const exec = promisify(execFile)
const binPath = process.env.SPINDB_CRON_TEST_ROOT

test(
  'real pg_cron preserves configuration and pauses copied and temporary servers',
  {
    skip: !binPath,
    timeout: 120_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'spindb-cron-live-'))
    const dataDir = join(root, 'source')
    const copyDir = join(root, 'copy')
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: join(binPath!, 'lib'),
      PGHOST: root,
      PGPORT: '55439',
      PGUSER: 'postgres',
      PGDATABASE: 'postgres',
    }
    async function run(binary: string, args: string[]) {
      return exec(join(binPath!, 'bin', binary), args, { env, timeout: 20_000 })
    }
    async function query(sql: string) {
      return (
        await run('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atqc', sql])
      ).stdout.trim()
    }
    async function start(dir: string, disabled = false) {
      await run('pg_ctl', [
        '-D',
        dir,
        '-l',
        join(root, 'postgres.log'),
        '-w',
        'start',
        ...(disabled ? ['-o', '-c cron.launch_active_jobs=off'] : []),
      ])
    }
    async function stop(dir: string) {
      await run('pg_ctl', ['-D', dir, '-m', 'fast', '-w', 'stop'])
    }
    async function waitFor(sql: string, expected: string) {
      for (let attempt = 0; attempt < 30; attempt++) {
        if ((await query(sql)) === expected) return
        await delay(500)
      }
      assert.equal(await query(sql), expected)
    }
    try {
      await run('initdb', [
        '-D',
        dataDir,
        '-U',
        'postgres',
        '--auth=trust',
        '--no-locale',
      ])
      await appendFile(
        join(dataDir, 'postgresql.conf'),
        `\nlisten_addresses = ''\nunix_socket_directories = '${root}'\nport = 55439\nshared_preload_libraries = 'pg_stat_statements'\n`,
      )
      await persistPostgresSettings(dataDir, {
        shared_preload_libraries: '"pg_stat_statements"',
        max_connections: '37',
      })
      assert.equal(
        await configurePostgresCron({
          binPath: binPath!,
          dataDir,
          database: 'postgres',
        }),
        true,
      )
      const configuration = await readFile(
        join(dataDir, 'postgresql.auto.conf'),
        'utf8',
      )
      await configurePostgresCron({
        binPath: binPath!,
        dataDir,
        database: 'ignored_on_restart',
      })
      assert.equal(
        await readFile(join(dataDir, 'postgresql.auto.conf'), 'utf8'),
        configuration,
      )
      await start(dataDir)
      assert.equal(await query('SHOW max_connections'), '37')
      assert.equal(await query('SHOW cron.max_running_jobs'), '2')
      assert.equal(await query('SHOW cron.database_name'), 'postgres')
      await query(
        'CREATE EXTENSION pg_cron; CREATE EXTENSION pg_stat_statements; CREATE EXTENSION "uuid-ossp"; CREATE TABLE sentinel(kind text);',
      )
      await query(
        "SELECT cron.schedule('seconds', '1 second', $$INSERT INTO sentinel VALUES ('seconds')$$); SELECT cron.schedule('reboot', '@reboot', $$INSERT INTO sentinel VALUES ('reboot')$$);",
      )
      await waitFor(
        "SELECT (count(*) > 0)::text FROM sentinel WHERE kind = 'seconds'",
        'true',
      )
      await stop(dataDir)
      await start(dataDir)
      await waitFor(
        "SELECT (count(*) > 0)::text FROM sentinel WHERE kind = 'reboot'",
        'true',
      )
      await run('pg_dump', ['-Fc', '-f', join(root, 'backup.dump')])
      await stop(dataDir)
      await cp(dataDir, copyDir, { recursive: true })
      await persistPostgresSettings(copyDir, {
        'cron.launch_active_jobs': 'off',
      })
      await configurePostgresCron({
        binPath: binPath!,
        dataDir: copyDir,
        database: 'postgres',
      })
      await start(copyDir)
      const copiedCount = await query('SELECT count(*) FROM sentinel')
      await delay(2500)
      assert.equal(await query('SELECT count(*) FROM sentinel'), copiedCount)
      assert.equal(await query('SELECT count(*) FROM cron.job'), '2')
      await stop(copyDir)
      await start(dataDir, true)
      const temporaryCount = await query('SELECT count(*) FROM sentinel')
      await delay(2500)
      assert.equal(await query('SELECT count(*) FROM sentinel'), temporaryCount)
      await stop(dataDir)
      await start(dataDir)
      await waitFor(
        `SELECT (count(*) > ${temporaryCount})::text FROM sentinel`,
        'true',
      )
      await query("SELECT cron.schedule('failure', '1 second', 'SELECT 1/0')")
      await waitFor(
        "SELECT EXISTS (SELECT 1 FROM cron.job_run_details WHERE status = 'failed')::text",
        'true',
      )
      assert.equal(
        await query(
          "SELECT count(*) FROM cron.job WHERE jobname = 'failure' AND active",
        ),
        '1',
      )
      await query('SELECT cron.unschedule(jobid) FROM cron.job')
      for (const name of ['slow1', 'slow2', 'slow3']) {
        await query(
          `SELECT cron.schedule('${name}', '1 second', 'SELECT pg_sleep(4)')`,
        )
      }
      await waitFor(
        "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'pg_cron'",
        '2',
      )
      assert.equal(await query('SELECT 1'), '1')
      await query('ALTER SYSTEM SET cron.launch_active_jobs = off')
      await query('SELECT pg_reload_conf()')
      await waitFor(
        "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'pg_cron'",
        '0',
      )
      const historySql = process.env.SPINDB_CRON_HISTORY_SQL
      if (historySql) {
        const prune = await readFile(historySql, 'utf8')
        await query(
          "TRUNCATE cron.job_run_details; INSERT INTO cron.job_run_details(status, start_time, end_time) SELECT 'succeeded', now(), now() FROM generate_series(1, 12005); INSERT INTO cron.job_run_details(status, start_time) VALUES ('failed', now() - interval '8 days'), ('running', now() - interval '8 days')",
        )
        await query(prune)
        assert.equal(
          await query('SELECT count(*) FROM cron.job_run_details'),
          '11007',
        )
        await query(prune)
        await query(prune)
        assert.equal(
          await query(
            "SELECT count(*) FROM cron.job_run_details WHERE status IN ('failed','succeeded')",
          ),
          '9999',
        )
        assert.equal(
          await query(
            "SELECT count(*) FROM cron.job_run_details WHERE status = 'running'",
          ),
          '1',
        )
        assert.equal(await query('SELECT count(*) FROM cron.job'), '3')
      }
      await stop(dataDir)
      // A stopped copied target restores definitions without executing them.
      await start(copyDir)
      await run('pg_restore', [
        '--clean',
        '--if-exists',
        '--exit-on-error',
        '-d',
        'postgres',
        join(root, 'backup.dump'),
      ])
      const restoredCount = await query('SELECT count(*) FROM sentinel')
      await delay(2500)
      assert.equal(await query('SELECT count(*) FROM sentinel'), restoredCount)
      assert.equal(await query('SELECT count(*) FROM cron.job'), '2')
      await stop(copyDir)
    } finally {
      for (const dir of [dataDir, copyDir]) {
        try {
          await stop(dir)
        } catch {
          /* An already stopped fixture needs no shutdown. */
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  },
)
