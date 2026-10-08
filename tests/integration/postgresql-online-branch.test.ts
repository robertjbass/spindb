import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdir,
  mkdtemp,
  appendFile,
  writeFile,
  readFile,
  rm,
  symlink,
  readdir,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { getBundledBinaryPath } from '../../core/pg-binary-resolver'
import { branchManager } from '../../core/branch-manager'
import { paths } from '../../config/paths'
import { Engine } from '../../types'
import { postgresqlEngine } from '../../engines/postgresql'
import { findConsecutiveFreePorts, TEST_PORTS } from './helpers'

const exec = promisify(execFile)
const basebackup = getBundledBinaryPath('pg_basebackup', '18')

test(
  'online PostgreSQL branch preserves source availability and isolates its data',
  { skip: !basebackup, timeout: 120_000 },
  async (context) => {
    const bin = dirname(basebackup!)
    const root = await mkdtemp(join(tmpdir(), 'pg-online-'))
    const sourcePath = join(root, 'source')
    const childPath = join(root, 'child')
    const sourceData = join(sourcePath, 'data')
    const childData = join(childPath, 'data')
    const [sourcePort, childPort] = await findConsecutiveFreePorts(
      2,
      TEST_PORTS.postgresql.base,
    )
    context.mock.method(paths, 'getContainerPath', (name: string) =>
      join(root, name),
    )
    context.mock.method(paths, 'getContainerDataPath', (name: string) =>
      join(root, name, 'data'),
    )
    context.mock.method(paths, 'getContainerConfigPath', (name: string) =>
      join(root, name, 'container.json'),
    )
    context.mock.method(paths, 'getContainerLogPath', (name: string) =>
      join(root, name, 'postgresql.log'),
    )
    context.mock.method(paths, 'getContainerPidPath', (name: string) =>
      join(root, name, 'data', 'postmaster.pid'),
    )
    const run = async (tool: string, args: string[]) =>
      exec(join(bin, tool), args, { timeout: 30_000 })
    const sql = async (port: number, query: string) =>
      (
        await run('psql', [
          '-h',
          '127.0.0.1',
          '-p',
          String(port),
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-X',
          '-At',
          '-v',
          'ON_ERROR_STOP=1',
          '-c',
          query,
        ])
      ).stdout.trim()
    try {
      await mkdir(sourcePath)
      await writeFile(
        join(sourcePath, 'container.json'),
        JSON.stringify({
          name: 'source',
          engine: Engine.PostgreSQL,
          version: '18.6.0',
          port: sourcePort,
          database: 'postgres',
          created: new Date().toISOString(),
          status: 'running',
        }),
      )
      await run('initdb', [
        '-D',
        sourceData,
        '-U',
        'postgres',
        '-A',
        'trust',
        '--no-locale',
      ])
      await appendFile(
        join(sourceData, 'postgresql.conf'),
        `\nwal_level=logical\nlisten_addresses='127.0.0.1'\n${process.platform === 'win32' ? '' : `unix_socket_directories='${root.replaceAll("'", "''")}'\n`}`,
      )
      await run('pg_ctl', [
        'start',
        '-D',
        sourceData,
        '-l',
        join(root, 'source.log'),
        '-o',
        `-p ${sourcePort}`,
        '-w',
        '-t',
        '15',
      ])
      await sql(
        sourcePort,
        'CREATE TABLE proof(id int primary key); INSERT INTO proof VALUES (1);',
      )
      await sql(
        sourcePort,
        "SELECT pg_create_logical_replication_slot('proof_slot','pgoutput')",
      )
      const started = await sql(sourcePort, 'SELECT pg_postmaster_start_time()')
      const beforeConfig = await readFile(
        join(sourceData, 'postgresql.auto.conf'),
        'utf8',
      )
      await mkdir(join(sourcePath, 'credentials'), { recursive: true })
      await writeFile(
        join(sourcePath, 'credentials', '.env.postgres'),
        `DB_USER=postgres\nDB_PASSWORD=unused\nDB_URL=postgresql://postgres@127.0.0.1:${sourcePort}/postgres\n`,
      )
      const branch = await branchManager.createBranch({
        source: 'source',
        name: 'child',
        port: childPort,
        start: false,
      })
      assert.match(
        await readFile(join(childPath, 'credentials', '.env.postgres'), 'utf8'),
        new RegExp(`DB_PORT=${childPort}`),
      )
      assert.equal(branch.method, 'copy')
      assert.equal(branch.config.branchParent, 'source')
      assert.equal(
        await sql(sourcePort, 'SELECT pg_postmaster_start_time()'),
        started,
      )
      await sql(sourcePort, 'INSERT INTO proof VALUES (2)')
      await run('pg_ctl', [
        'start',
        '-D',
        childData,
        '-l',
        join(root, 'child.log'),
        '-o',
        `-p ${childPort}`,
        '-w',
        '-t',
        '15',
      ])
      assert.equal(
        await sql(childPort, 'SELECT id FROM proof ORDER BY id'),
        '1',
      )
      assert.equal(
        await sql(childPort, 'SELECT count(*) FROM pg_replication_slots'),
        '0',
      )
      assert.equal(
        await sql(childPort, 'SHOW max_logical_replication_workers'),
        '0',
      )
      await sql(childPort, 'INSERT INTO proof VALUES (3)')
      assert.equal(
        await sql(sourcePort, 'SELECT id FROM proof ORDER BY id'),
        '1\n2',
      )
      assert.equal(
        await readFile(join(sourceData, 'postgresql.auto.conf'), 'utf8'),
        beforeConfig,
      )

      const reset = await branchManager.resetBranch('child')
      assert.equal(reset.started, true)
      assert.equal(reset.warning, undefined)
      assert.equal(
        await sql(childPort, 'SELECT id FROM proof ORDER BY id'),
        '1\n2',
      )
      assert.equal(
        await sql(sourcePort, 'SELECT pg_postmaster_start_time()'),
        started,
      )

      await writeFile(join(childData, 'previous-data-marker'), 'preserve')
      const failedStart = context.mock.method(
        postgresqlEngine,
        'start',
        async () => {
          throw new Error('injected child startup failure')
        },
      )
      const failedReset = await branchManager.resetBranch('child')
      failedStart.mock.restore()
      assert.equal(failedReset.started, false)
      assert.match(
        failedReset.warning ?? '',
        /Previous branch data is preserved/,
      )
      const saved = await readdir(join(root, '.reset-backups'))
      assert.equal(saved.length, 1)
      assert.equal(
        await readFile(
          join(
            root,
            '.reset-backups',
            saved[0],
            'data',
            'previous-data-marker',
          ),
          'utf8',
        ),
        'preserve',
      )
      assert.equal(
        await sql(sourcePort, 'SELECT pg_postmaster_start_time()'),
        started,
      )

      // Physical backup permission failure must never trigger an offline retry.
      await sql(sourcePort, 'CREATE ROLE backup_denied LOGIN')
      await mkdir(join(sourcePath, 'credentials'), { recursive: true })
      await writeFile(
        join(sourcePath, 'credentials', '.env.postgres'),
        'DB_USER=backup_denied\nDB_PASSWORD=unused\nDB_URL=postgresql://backup_denied@127.0.0.1/postgres\n',
      )
      await assert.rejects(
        branchManager.createBranch({
          source: 'source',
          name: 'denied',
          start: false,
        }),
        /replication|superuser|permission denied/i,
      )
      assert.equal(existsSync(join(root, 'denied')), false)
      assert.equal(
        await sql(sourcePort, 'SELECT pg_postmaster_start_time()'),
        started,
      )
      await rm(join(sourcePath, 'credentials', '.env.postgres'))

      if (process.platform !== 'win32') {
        const external = join(root, 'external')
        await mkdir(external)
        await symlink(external, join(sourceData, 'external-link'))
        await assert.rejects(
          branchManager.createBranch({
            source: 'source',
            name: 'unsafe_child',
            start: false,
          }),
          /self-contained/,
        )
        assert.equal(
          await sql(sourcePort, 'SELECT pg_postmaster_start_time()'),
          started,
        )
        assert.equal(existsSync(external), true)
        await assert.rejects(
          branchManager.createBranch({
            source: 'source',
            name: 'external',
            start: false,
          }),
          /EEXIST/,
        )
        assert.equal(existsSync(external), true)
        await rm(join(sourceData, 'external-link'))
      }
    } finally {
      for (const data of [childData, sourceData]) {
        if (existsSync(join(data, 'postmaster.pid')))
          await run('pg_ctl', [
            'stop',
            '-D',
            data,
            '-m',
            'fast',
            '-w',
            '-t',
            '15',
          ])
      }
      await rm(root, { recursive: true, force: true })
    }
  },
)
