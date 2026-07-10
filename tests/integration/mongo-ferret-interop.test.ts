/**
 * MongoDB <-> FerretDB cross-engine backup/restore interoperability.
 *
 * Both engines speak the MongoDB wire protocol and back up / restore via
 * mongodump / mongorestore, so a backup taken from one MUST be restorable into
 * the other. Layerbase Cloud relies on this: it pins both engines to the same
 * `archive-plain` backup format and uses byte-identical restore commands. This
 * test proves the interchangeability end-to-end, in BOTH directions, against
 * real engines - not just that the formats look alike - using a distinct marker
 * document so it is unambiguous that the data crossed engines.
 */

import { describe, it, before, after } from 'node:test'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
const __dirname = dirname(fileURLToPath(import.meta.url))
import {
  cleanupTestContainers,
  findConsecutiveFreePorts,
  generateTestName,
  waitForReady,
  getRowCount,
  runScriptFile,
  runScriptSQL,
  runScriptJS,
  executeQuery,
  TEST_PORTS,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'

const DATABASE = 'testdb'
const MONGO_VERSION = '8.0'
const FERRET_VERSION = '2'
const MONGO_SEED = join(__dirname, '../fixtures/mongodb/seeds/sample-db.js')
const FERRET_SEED = join(__dirname, '../fixtures/ferretdb/seeds/sample-db.js')
const SEEDED_ROWS = 5

// Create + start + seed one mongo-wire engine container (mongo and ferret share
// the same bootstrap sequence; only engine/version/seed differ).
async function setupEngine(opts: {
  engine: Engine
  version: string
  port: number
  name: string
  seedFile: string
}): Promise<void> {
  const engine = getEngine(opts.engine)
  await engine.ensureBinaries(opts.version, () => {})
  await containerManager.create(opts.name, {
    engine: opts.engine,
    version: opts.version,
    port: opts.port,
    database: DATABASE,
  })
  await engine.initDataDir(opts.name, opts.version, {})
  const config = await containerManager.getConfig(opts.name)
  assert(config !== null, `${opts.engine} config should exist`)
  await engine.start(config!)
  await containerManager.updateConfig(opts.name, { status: 'running' })
  const ready = await waitForReady(opts.engine, opts.port)
  assert(ready, `${opts.engine} should be ready`)
  await runScriptFile(opts.name, opts.seedFile, DATABASE)
}

describe('MongoDB <-> FerretDB backup/restore interoperability', () => {
  let mongoPort: number
  let ferretPort: number
  let mongoName: string
  let ferretName: string

  before(async () => {
    await cleanupTestContainers()
    // Separate port blocks so the two engines (ferret reserves aux ports for its
    // backend) never collide.
    const mongoPorts = await findConsecutiveFreePorts(
      3,
      TEST_PORTS.mongodb.base,
    )
    const ferretPorts = await findConsecutiveFreePorts(
      3,
      TEST_PORTS.ferretdb.base,
    )
    mongoPort = mongoPorts[0]
    ferretPort = ferretPorts[0]
    mongoName = generateTestName('interop-mongo')
    ferretName = generateTestName('interop-ferret')

    await setupEngine({
      engine: Engine.MongoDB,
      version: MONGO_VERSION,
      port: mongoPort,
      name: mongoName,
      seedFile: MONGO_SEED,
    })
    await setupEngine({
      engine: Engine.FerretDB,
      version: FERRET_VERSION,
      port: ferretPort,
      name: ferretName,
      seedFile: FERRET_SEED,
    })
  })

  after(async () => {
    await cleanupTestContainers()
  })

  it('a MongoDB backup restores into FerretDB with the data intact (archive-plain)', async () => {
    console.log(`\n MongoDB -> FerretDB cross-restore...`)
    const mongoEngine = getEngine(Engine.MongoDB)
    const ferretEngine = getEngine(Engine.FerretDB)
    const mongoConfig = await containerManager.getConfig(mongoName)
    const ferretConfig = await containerManager.getConfig(ferretName)
    assert(mongoConfig !== null && ferretConfig !== null, 'configs exist')

    // Tag the MongoDB data with a marker NOT present in FerretDB's seed.
    await runScriptSQL(
      mongoName,
      "db.test_user.insertOne({id: 7001, name: 'MONGO-MARKER', email: 'mongo-marker@example.com'})",
      DATABASE,
    )

    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(tmpdir(), `interop-mongo-${Date.now()}.archive`)
    try {
      // Back up MongoDB in the exact format the cloud pins for both engines.
      await mongoEngine.backup(mongoConfig!, backupPath, {
        database: DATABASE,
        format: 'archive-plain',
      })

      // Restore the MongoDB-produced archive INTO FerretDB (replace in place).
      await ferretEngine.restore(ferretConfig!, backupPath, {
        database: DATABASE,
        createDatabase: false,
        clean: true,
      })

      // FerretDB now holds MongoDB's data (the 5 seed docs + the marker),
      // proving the backup format crossed engines.
      const count = await getRowCount(
        Engine.FerretDB,
        ferretPort,
        DATABASE,
        'test_user',
      )
      assertEqual(
        count,
        SEEDED_ROWS + 1,
        'FerretDB should hold the MongoDB backup contents after cross-restore',
      )
      const marker = await executeQuery(
        ferretName,
        'test_user.find({id: 7001}).toArray()',
        DATABASE,
      )
      assertEqual(
        marker.rowCount,
        1,
        'The MongoDB marker doc should be present in FerretDB after cross-restore',
      )
      assertEqual(
        marker.rows[0].name,
        'MONGO-MARKER',
        'Cross-restored doc should match the MongoDB original',
      )
      console.log('   ✓ MongoDB backup restored into FerretDB intact')
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})
    }
  })

  it('a FerretDB backup restores into MongoDB with the data intact (archive-plain)', async () => {
    console.log(`\n FerretDB -> MongoDB cross-restore...`)
    const mongoEngine = getEngine(Engine.MongoDB)
    const ferretEngine = getEngine(Engine.FerretDB)
    const mongoConfig = await containerManager.getConfig(mongoName)
    const ferretConfig = await containerManager.getConfig(ferretName)
    assert(mongoConfig !== null && ferretConfig !== null, 'configs exist')

    // Tag the FerretDB data with a distinct marker.
    await runScriptJS(
      ferretName,
      "db.test_user.insertOne({id: 8001, name: 'FERRET-MARKER', email: 'ferret-marker@example.com'})",
      DATABASE,
    )

    const { tmpdir } = await import('os')
    const { rm } = await import('fs/promises')
    const backupPath = join(tmpdir(), `interop-ferret-${Date.now()}.archive`)
    try {
      await ferretEngine.backup(ferretConfig!, backupPath, {
        database: DATABASE,
        format: 'archive-plain',
      })

      // Restore the FerretDB-produced archive INTO MongoDB (replace in place).
      await mongoEngine.restore(mongoConfig!, backupPath, {
        database: DATABASE,
        createDatabase: false,
        clean: true,
      })

      // MongoDB now contains the FerretDB marker, proving the reverse direction.
      const marker = await executeQuery(
        mongoName,
        'test_user.find({id: 8001}).toArray()',
        DATABASE,
      )
      assertEqual(
        marker.rowCount,
        1,
        'The FerretDB marker doc should be present in MongoDB after cross-restore',
      )
      assertEqual(
        marker.rows[0].name,
        'FERRET-MARKER',
        'Cross-restored doc should match the FerretDB original',
      )
      console.log('   ✓ FerretDB backup restored into MongoDB intact')
    } finally {
      await rm(backupPath, { force: true }).catch(() => {})
    }
  })
})
