import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, cp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

const exec = promisify(execFile)
const binPath = process.env.SPINDB_CRON_TEST_ROOT
const cli = process.env.SPINDB_CRON_TEST_CLI
const version = process.env.SPINDB_CRON_TEST_VERSION || '18.6.0'

test(
  'compiled CLI creates, clones, temporarily starts and restores cron safely',
  {
    skip: !binPath || !cli,
    timeout: 600_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'spindb-cron-cli-'))
    const env = {
      ...process.env,
      SPINDB_HOME: root,
      PATH: `${binPath}/bin:${process.env.PATH}`,
      LD_LIBRARY_PATH: `${binPath}/lib`,
    }
    async function command(args: string[]) {
      try {
        return await exec(process.execPath, [cli!, ...args, '--json'], {
          env,
          timeout: 45_000,
        })
      } catch (error) {
        throw new Error(
          `${args[0]} failed: ${(error as { stdout?: string }).stdout || String(error)}`,
        )
      }
    }
    async function query(sql: string, port = 55441) {
      const result = await exec(
        join(binPath!, 'bin', 'psql'),
        [
          '-X',
          '-h',
          '127.0.0.1',
          '-p',
          String(port),
          '-U',
          'postgres',
          '-d',
          'app',
          '-v',
          'ON_ERROR_STOP=1',
          '-Atqc',
          sql,
        ],
        { env, timeout: 10_000 },
      )
      return result.stdout.trim()
    }
    try {
      await mkdir(join(root, 'bin'))
      await cp(binPath!, join(root, 'bin', `postgresql-${version}-linux-x64`), {
        recursive: true,
      })
      await command([
        'create',
        'source',
        '--db-version',
        version,
        '--database',
        'app',
        '--port',
        '55441',
        '--start',
      ])
      assert.equal(await query('SHOW shared_preload_libraries'), '')
      assert.equal(
        await query(
          "SELECT count(*) FROM pg_extension WHERE extname = 'pg_cron'",
        ),
        '0',
      )
      await query("ALTER SYSTEM SET shared_preload_libraries = 'pg_cron'")
      await command(['stop', 'source'])
      await command(['start', 'source', '--strict-port'])
      await query(
        "CREATE EXTENSION pg_cron; CREATE TABLE sentinel(n int); SELECT cron.schedule('sentinel', '1 second', 'INSERT INTO sentinel VALUES (1)')",
      )
      await delay(2500)
      assert.ok(Number(await query('SELECT count(*) FROM sentinel')) > 0)
      await exec(
        join(binPath!, 'bin', 'pg_dump'),
        [
          '-h',
          '127.0.0.1',
          '-p',
          '55441',
          '-U',
          'postgres',
          '-d',
          'app',
          '-Fc',
          '-f',
          join(root, 'backup.dump'),
        ],
        { env },
      )
      await command(['branch', 'create', 'source', 'online', '--port', '55443'])
      assert.equal(await query('SHOW cron.launch_active_jobs', 55443), 'off')
      const onlineCount = await query('SELECT count(*) FROM sentinel', 55443)
      const sourceCount = Number(await query('SELECT count(*) FROM sentinel'))
      await delay(2500)
      assert.equal(
        await query('SELECT count(*) FROM sentinel', 55443),
        onlineCount,
      )
      assert.ok(
        Number(await query('SELECT count(*) FROM sentinel')) > sourceCount,
      )
      await command(['stop', 'online'])
      await command(['stop', 'source'])
      await command(['clone', 'source', 'copy'])
      const copied = JSON.parse(
        await readFile(
          join(root, 'containers', 'postgresql', 'copy', 'container.json'),
          'utf8',
        ),
      ) as { port: number }
      await command(['start', 'copy', '--strict-port'])
      assert.equal(
        await query('SHOW cron.launch_active_jobs', copied.port),
        'off',
      )
      const before = await query('SELECT count(*) FROM sentinel', copied.port)
      await delay(2500)
      assert.equal(
        await query('SELECT count(*) FROM sentinel', copied.port),
        before,
      )
      await command(['stop', 'copy'])
      await command(['start', 'source', '--no-scheduled-jobs', '--strict-port'])
      assert.equal(await query('SHOW cron.launch_active_jobs'), 'off')
      await command(['stop', 'source'])
      await command(['start', 'source', '--strict-port'])
      assert.equal(await query('SHOW cron.launch_active_jobs'), 'on')
      await command([
        'restore',
        'source',
        join(root, 'backup.dump'),
        '--database',
        'app',
        '--force',
      ])
      assert.equal(await query('SHOW cron.launch_active_jobs'), 'off')
      const restored = await query('SELECT count(*) FROM sentinel')
      await delay(2500)
      assert.equal(await query('SELECT count(*) FROM sentinel'), restored)
      assert.equal(await query('SELECT count(*) FROM cron.job'), '1')
    } finally {
      for (const name of ['source', 'copy', 'online']) {
        try {
          await command(['stop', name])
        } catch {
          /* Cleanup also covers failed creation. */
        }
      }
      await rm(root, { recursive: true, force: true })
    }
  },
)
