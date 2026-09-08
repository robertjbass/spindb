/**
 * MariaDB source -> MySQL target restore-from-URL.
 *
 * `spindb restore <mysql-container> --from-url mysql://...` cannot tell from
 * the URL whether the server on the other end is MySQL or MariaDB: they share
 * a wire protocol and a scheme. Getting it wrong is not a degraded dump, it is
 * no dump at all - `mysqldump` 9 cannot even authenticate against MariaDB,
 * because MySQL 9 dropped the `mysql_native_password` client plugin MariaDB's
 * root user still uses.
 *
 * This proves the whole path against real binaries: a real MariaDB server, its
 * real default `utf8mb4_uca1400_ai_ci` collation (which MySQL has never had),
 * a real `json_valid()` CHECK constraint and a real trigger, dumped by the
 * MySQL engine's own `dumpFromConnectionString` and restored into a real
 * MySQL container.
 *
 * Needs BOTH engines' binaries, so it lives outside either engine's suite:
 * `pnpm test:engine mysql-mariadb-interop`.
 */

import { describe, it, before, after } from 'node:test'
import { join } from 'path'
import { tmpdir } from 'os'
import { rm } from 'fs/promises'
import {
  cleanupTestContainers,
  findConsecutiveFreePorts,
  generateTestName,
  getConnectionString,
  waitForReady,
  runScriptSQL,
  executeQuery,
  TEST_PORTS,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { getEngineDefaults } from '../../config/defaults'
import { Engine } from '../../types'

const DATABASE = 'testdb'
const MYSQL_VERSION = '9'
const MARIADB_VERSION = getEngineDefaults('mariadb').defaultVersion

// A schema that is ordinary on MariaDB and, statement for statement, illegal
// on MySQL until the dump is converted:
// - the table collation is MariaDB 11's default, which MySQL does not have,
// - the trigger drags a `NO_AUTO_CREATE_USER` sql_mode through the dump, which
//   MySQL 8+ answers with ERROR 1231,
// - the json_valid() CHECK is the control: MySQL has json_valid(), so it must
//   survive untouched.
const MARIADB_SCHEMA = `
CREATE TABLE catalog_item (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  attributes JSON DEFAULT NULL CHECK (json_valid(attributes)),
  touched_by VARCHAR(40) DEFAULT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TRIGGER catalog_item_stamp BEFORE INSERT ON catalog_item
FOR EACH ROW SET NEW.touched_by = 'trigger';

INSERT INTO catalog_item (name, attributes) VALUES
  ('bordeaux', '{"color":"red"}'),
  ('crémant', '{"color":"white"}'),
  ('rosé', '{"color":"pink"}');
`

async function startContainer(options: {
  engine: Engine
  version: string
  port: number
  name: string
}): Promise<void> {
  const engine = getEngine(options.engine)
  await engine.ensureBinaries(options.version, ({ message }) => {
    console.log(`   ${message}`)
  })
  await containerManager.create(options.name, {
    engine: options.engine,
    version: options.version,
    port: options.port,
    database: DATABASE,
  })
  await engine.initDataDir(options.name, options.version, {
    superuser: 'root',
  })

  const config = await containerManager.getConfig(options.name)
  assert(config !== null, `${options.engine} config should exist`)
  await engine.start(config!)
  await containerManager.updateConfig(options.name, { status: 'running' })

  const ready = await waitForReady(options.engine, options.port)
  assert(ready, `${options.engine} should be ready`)
  await engine.createDatabase(config!, DATABASE)
}

describe('MariaDB source -> MySQL target restore', () => {
  let mariadbPort: number
  let mysqlPort: number
  let mariadbName: string
  let mysqlName: string

  before(async () => {
    await cleanupTestContainers()

    const mariadbPorts = await findConsecutiveFreePorts(
      3,
      TEST_PORTS.mariadb.base,
    )
    const mysqlPorts = await findConsecutiveFreePorts(3, TEST_PORTS.mysql.base)
    mariadbPort = mariadbPorts[0]
    mysqlPort = mysqlPorts[0]
    // The '-test' in the name is what `cleanupTestContainers` matches on, so
    // a crashed run does not leave a container (and a held port) behind.
    mariadbName = generateTestName('mariadb-source-test')
    mysqlName = generateTestName('mysql-target-test')

    console.log(`\n🦭 Starting MariaDB ${MARIADB_VERSION} source...`)
    await startContainer({
      engine: Engine.MariaDB,
      version: MARIADB_VERSION,
      port: mariadbPort,
      name: mariadbName,
    })
    await runScriptSQL(mariadbName, MARIADB_SCHEMA, DATABASE)

    console.log(`\n🐬 Starting MySQL ${MYSQL_VERSION} target...`)
    await startContainer({
      engine: Engine.MySQL,
      version: MYSQL_VERSION,
      port: mysqlPort,
      name: mysqlName,
    })
  })

  after(async () => {
    await cleanupTestContainers()
  })

  it('the source really does use a collation MySQL does not have', async () => {
    // If this stops being true the rest of the test proves nothing.
    const result = await executeQuery(
      mariadbName,
      `SELECT table_collation AS collation_name FROM information_schema.tables
       WHERE table_schema = '${DATABASE}' AND table_name = 'catalog_item'`,
      DATABASE,
    )
    const collation = String(result.rows[0]?.collation_name ?? '')

    assert(
      collation.includes('uca1400'),
      `expected a uca1400 collation on the MariaDB source, got: ${collation}`,
    )
  })

  it('dumps a MariaDB source with mariadb-dump and reports the conversion', async () => {
    console.log('\n📤 Dumping the MariaDB source through the MySQL engine...')
    const mysqlEngine = getEngine(Engine.MySQL)
    const dumpPath = join(tmpdir(), `interop-dump-${Date.now()}.sql`)
    const mysqlConfig = await containerManager.getConfig(mysqlName)
    assert(mysqlConfig !== null, 'MySQL config should exist')

    try {
      const dump = await mysqlEngine.dumpFromConnectionString(
        getConnectionString(Engine.MariaDB, mariadbPort, DATABASE),
        dumpPath,
        { targetVersion: mysqlConfig!.version },
      )

      assertEqual(
        dump.remoteSource?.flavor,
        'mariadb',
        'the source should be recognized as MariaDB from its greeting',
      )
      assertEqual(
        dump.remoteSource?.dumpTool,
        'mariadb-dump',
        'a MariaDB source must be dumped with mariadb-dump',
      )
      assert(
        (dump.remoteSource?.rewrites?.collationsMapped ?? 0) > 0,
        'the uca1400 collation should have been rewritten',
      )

      console.log('\n📥 Restoring into the MySQL target...')
      await mysqlEngine.restore(mysqlConfig!, dumpPath, {
        database: DATABASE,
        createDatabase: false,
      })
    } finally {
      await rm(dumpPath, { force: true })
    }
  })

  it('lands the rows in MySQL', async () => {
    const result = await executeQuery(
      mysqlName,
      'SELECT name AS item_name FROM catalog_item ORDER BY id',
      DATABASE,
    )
    const names = result.rows.map((row) => String(row.item_name))

    assertEqual(names.length, 3, 'all three rows should have crossed engines')
    assert(
      names.includes('crémant'),
      `non-ASCII data should survive the collation rewrite, got: ${names.join(', ')}`,
    )
  })

  it('rewrites the collation to one MySQL has', async () => {
    const result = await executeQuery(
      mysqlName,
      `SELECT table_collation AS collation_name FROM information_schema.tables
       WHERE table_schema = '${DATABASE}' AND table_name = 'catalog_item'`,
      DATABASE,
    )
    const collation = String(result.rows[0]?.collation_name ?? '')

    assertEqual(
      collation,
      'utf8mb4_0900_ai_ci',
      'the MariaDB uca1400 collation should have become the MySQL 0900 one',
    )
  })

  it('carries the trigger across, working', async () => {
    const triggers = await executeQuery(
      mysqlName,
      `SELECT trigger_name AS name FROM information_schema.triggers
       WHERE trigger_schema = '${DATABASE}'`,
      DATABASE,
    )
    assert(
      triggers.rows.some((row) => String(row.name) === 'catalog_item_stamp'),
      'the trigger should exist on the MySQL target',
    )

    // The NO_AUTO_CREATE_USER sql_mode around the trigger is what MySQL
    // rejects with ERROR 1231; a working trigger proves it was stripped.
    await runScriptSQL(
      mysqlName,
      'INSERT INTO catalog_item (name, attributes) VALUES (\'muscat\', \'{"color":"amber"}\');',
      DATABASE,
    )
    const stamped = await executeQuery(
      mysqlName,
      "SELECT touched_by AS stamp FROM catalog_item WHERE name = 'muscat'",
      DATABASE,
    )
    assertEqual(
      String(stamped.rows[0]?.stamp ?? ''),
      'trigger',
      'the restored trigger should fire on the MySQL target',
    )
  })

  it('keeps the json_valid CHECK constraint, which MySQL also has', async () => {
    const checks = await executeQuery(
      mysqlName,
      `SELECT check_clause AS clause FROM information_schema.check_constraints
       WHERE constraint_schema = '${DATABASE}'`,
      DATABASE,
    )
    assert(
      checks.rows.some((row) => String(row.clause).includes('json_valid')),
      'the json_valid CHECK should survive unconverted',
    )
  })
})
