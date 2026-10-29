import { it } from 'node:test'
import { createServer } from 'node:net'
import { once } from 'node:events'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { normalizeRemoteDumpDefiners } from '../../core/mysql-import-definers'

// Explicit binaries keep this drill isolated from the user's managed containers.
const binaryRoot = process.env.SPINDB_TEST_IMPORT_BINARY_ROOT
const flavor = process.env.SPINDB_TEST_IMPORT_FLAVOR ?? 'mariadb'

it(
  'imports foreign-owned objects on a real MySQL-family engine',
  {
    skip: !binaryRoot,
    timeout: 120000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'spindb-definers-'))
    const listener = createServer()
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const address = listener.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    )
    const data = join(root, 'data')
    const socket = join(root, 'db.sock')
    const client = join(
      binaryRoot!,
      'bin',
      flavor === 'mysql' ? 'mysql' : 'mariadb',
    )
    const server = join(
      binaryRoot!,
      'bin',
      flavor === 'mysql' ? 'mysqld' : 'mariadbd',
    )
    const dump = join(
      binaryRoot!,
      'bin',
      flavor === 'mysql' ? 'mysqldump' : 'mariadb-dump',
    )
    const init =
      flavor === 'mysql'
        ? spawnSync(
            server,
            [
              '--no-defaults',
              '--initialize-insecure',
              `--basedir=${binaryRoot}`,
              `--datadir=${data}`,
            ],
            { encoding: 'utf8', timeout: 60000 },
          )
        : spawnSync(
            join(binaryRoot!, 'scripts', 'mariadb-install-db'),
            [
              '--no-defaults',
              `--basedir=${binaryRoot}`,
              `--datadir=${data}`,
              '--auth-root-authentication-method=normal',
              '--skip-test-db',
            ],
            { encoding: 'utf8', timeout: 60000 },
          )
    assert.equal(init.status, 0, init.stderr)
    const process = spawn(
      server,
      [
        '--no-defaults',
        `--basedir=${binaryRoot}`,
        `--datadir=${data}`,
        `--socket=${socket}`,
        `--pid-file=${join(root, 'db.pid')}`,
        '--bind-address=127.0.0.1',
        `--port=${port}`,
        '--innodb-buffer-pool-size=32M',
      ],
      { stdio: 'ignore' },
    )
    function query(sql: string, database?: string) {
      return spawnSync(
        client,
        [
          '--no-defaults',
          `--socket=${socket}`,
          '-u',
          'root',
          '--batch',
          '--skip-column-names',
          ...(database ? [database] : []),
        ],
        { input: sql, encoding: 'utf8', timeout: 10000 },
      )
    }
    try {
      let ready = false
      for (let i = 0; i < 100; i++) {
        if (query('SELECT 1').status === 0) {
          ready = true
          break
        }
        await delay(200)
      }
      assert.ok(ready, 'disposable server became ready')
      const seed = query(`
CREATE DATABASE source_db;
CREATE DATABASE target_db;
CREATE USER 'source_owner'@'%';
GRANT ALL ON source_db.* TO 'source_owner'@'%';
USE source_db;
CREATE TABLE items (id INT PRIMARY KEY, note VARBINARY(255), n INT);
INSERT INTO items VALUES (1,0x80ff00,10);
CREATE DEFINER='source_owner'@'%' SQL SECURITY DEFINER VIEW item_view AS SELECT id,n FROM items;
CREATE DEFINER='source_owner'@'%' SQL SECURITY INVOKER VIEW invoker_view AS SELECT id,n FROM items;
CREATE DEFINER='source_owner'@'%' TRIGGER item_trigger BEFORE INSERT ON items FOR EACH ROW SET NEW.n=NEW.n+1;
CREATE DEFINER='source_owner'@'%' PROCEDURE item_proc() SQL SECURITY DEFINER SELECT n FROM items WHERE id=1;
CREATE DEFINER='source_owner'@'%' FUNCTION item_func() RETURNS INT DETERMINISTIC SQL SECURITY DEFINER RETURN 42;
CREATE DEFINER='source_owner'@'%' EVENT item_event ON SCHEDULE EVERY 1 DAY DISABLE DO INSERT INTO items VALUES (99,'event',1);
`)
      assert.equal(seed.status, 0, seed.stderr)
      const dumped = spawnSync(
        dump,
        [
          '--no-defaults',
          `--socket=${socket}`,
          '-u',
          'root',
          '--routines',
          '--events',
          '--triggers',
          '--hex-blob',
          'source_db',
        ],
        { maxBuffer: 4 * 1024 * 1024, timeout: 10000 },
      )
      assert.equal(dumped.status, 0, dumped.stderr.toString())
      const engine =
        flavor === 'mysql'
          ? new (await import('../../engines/mysql')).MySQLEngine()
          : new (await import('../../engines/mariadb')).MariaDBEngine()
      Object.defineProperty(engine, 'getDumpPath', { value: async () => dump })
      const remotePath = join(root, 'remote.sql')
      const remote = await engine.dumpFromConnectionString(
        `mysql://root@127.0.0.1:${port}/source_db`,
        remotePath,
      )
      assert.equal(remote.remoteSource?.rewrites?.definersRewritten, 3)
      assert.ok(remote.warnings?.some((warning) => warning.includes('DEFINER')))
      const filePath = join(root, 'source.sql')
      await writeFile(filePath, dumped.stdout)
      assert.equal(query("DROP USER 'source_owner'@'%'").status, 0)
      const baseline = query(dumped.stdout.toString(), 'target_db')
      const baselineUse = query(
        "SELECT * FROM item_view; INSERT INTO items VALUES (2,'baseline',1);",
        'target_db',
      )
      assert.ok(
        baseline.status !== 0 || baselineUse.status !== 0,
        'unmodified dump fails to restore or use foreign-owned objects',
      )
      assert.equal(
        query('DROP DATABASE target_db; CREATE DATABASE target_db;').status,
        0,
      )
      const remoteRestored = query(
        await readFile(remotePath, 'utf8'),
        'target_db',
      )
      assert.equal(remoteRestored.status, 0, remoteRestored.stderr)
      assert.equal(
        query(
          "SELECT n FROM item_view WHERE id=1; INSERT INTO items VALUES (2,'remote',7); SELECT n FROM items WHERE id=2;",
          'target_db',
        ).stdout.trim(),
        '10\n8',
      )
      const normalized = await normalizeRemoteDumpDefiners({
        filePath,
        remoteSource: {
          flavor,
          dumpTool: flavor === 'mysql' ? 'mysqldump' : 'mariadb-dump',
        },
      })
      assert.equal(normalized.remoteSource?.rewrites?.definersRewritten, 6)
      assert.equal(
        query('DROP DATABASE target_db; CREATE DATABASE target_db;').status,
        0,
      )
      const restored = query(await readFile(filePath, 'utf8'), 'target_db')
      assert.equal(restored.status, 0, restored.stderr)
      const check = query(
        "SELECT HEX(note),n FROM items WHERE id=1; SELECT n FROM item_view WHERE id=1; CALL item_proc(); SELECT item_func(); INSERT INTO items VALUES (2,'new',7); SELECT n FROM items WHERE id=2;",
        'target_db',
      )
      assert.equal(check.status, 0, check.stderr)
      assert.equal(check.stdout.trim(), '80FF00\t10\n10\n10\n42\n8')
      const owners = query(
        "SELECT DEFINER,SECURITY_TYPE FROM information_schema.VIEWS WHERE TABLE_SCHEMA='target_db' ORDER BY TABLE_NAME;",
      )
      assert.equal(
        owners.stdout.trim(),
        'root@localhost\tINVOKER\nroot@localhost\tDEFINER',
      )
      const otherOwners = query(
        "SELECT DEFINER FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='target_db' UNION ALL SELECT DEFINER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA='target_db' UNION ALL SELECT DEFINER FROM information_schema.EVENTS WHERE EVENT_SCHEMA='target_db';",
      )
      assert.deepEqual(
        otherOwners.stdout.trim().split('\n'),
        Array(4).fill('root@localhost'),
      )
    } finally {
      query('SHUTDOWN;')
      if (process.exitCode === null) {
        for (let i = 0; i < 50 && process.exitCode === null; i++)
          await delay(100)
        if (process.exitCode === null) process.kill('SIGTERM')
      }
      await rm(root, { recursive: true, force: true })
    }
  },
)
