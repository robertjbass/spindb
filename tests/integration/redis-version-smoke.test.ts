/**
 * Redis version coverage smoke test
 *
 * The main `redis.test.ts` is comprehensive but hardcodes `TEST_VERSION='8'`.
 * That meant when hostdb 0.32.0 added the BSD-licensed redis-7.2.14 binary
 * and spindb 0.50.6 shipped it, no automated test ever booted the new
 * binary — we discovered this manually post-merge during the 2026-05-23
 * cloud rollout. The binary worked, but it could just as easily have not.
 *
 * Fix: a minimal lifecycle smoke (create → start → SET/GET → stop → delete)
 * for every supported major version *except* the canonical one that the
 * main suite already covers. New majors added to hostdb automatically
 * pick up smoke coverage via SUPPORTED_MAJOR_VERSIONS.
 *
 * Scope on purpose:
 *   - One container per version. Independent. No backup/restore/clone
 *     coverage (the main suite handles that on canonical) — we just need
 *     proof that the binary runs and accepts traffic on this platform.
 *   - All cleanup is in `finally` blocks so a single bad version doesn't
 *     leak containers and break subsequent runs.
 */

import { describe, it, after } from 'node:test'
import {
  cleanupTestContainers,
  findConsecutiveFreePorts,
  generateTestName,
  waitForReady,
  waitForStopped,
} from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { getEngine } from '../../engines'
import { Engine } from '../../types'
import { SUPPORTED_MAJOR_VERSIONS } from '../../engines/redis/version-maps'

const ENGINE = Engine.Redis
const DATABASE = '0'
const CANONICAL_VERSION = '8' // matches redis.test.ts TEST_VERSION

// Smoke every supported major version EXCEPT the canonical one — the main
// suite already covers that one in depth, no need to duplicate.
const SMOKE_VERSIONS = SUPPORTED_MAJOR_VERSIONS.filter(
  (v) => v !== CANONICAL_VERSION,
)

describe('Redis version coverage smoke', () => {
  after(async () => {
    // Belt-and-suspenders. Each smoke `it` cleans up its own container in
    // a finally, but if Node aborted mid-test we want the next run to
    // start clean.
    await cleanupTestContainers()
  })

  for (const version of SMOKE_VERSIONS) {
    it(`should boot, accept SET/GET, and stop cleanly on Redis ${version}`, async () => {
      const containerName = generateTestName(`redis-${version}-test-smoke`)
      const [port] = await findConsecutiveFreePorts(1, 6420)
      const engine = getEngine(ENGINE)

      try {
        console.log(
          `\n📦 Redis ${version} smoke — container=${containerName} port=${port}`,
        )

        await engine.ensureBinaries(version)

        await containerManager.create(containerName, {
          engine: ENGINE,
          version,
          port,
          database: DATABASE,
        })
        const config = await containerManager.getConfig(containerName)
        assert(config !== null, 'Container should be created')

        await engine.initDataDir(containerName, version, {})
        await engine.start(config!)
        await waitForReady(ENGINE, port)

        // Round-trip a value through redis-cli via the engine's query path.
        // No password (we didn't set one in this minimal container).
        const setResult = await engine.executeQuery(
          config!,
          'SET smoke:key smoke_value_works',
          { database: DATABASE },
        )
        assertEqual(setResult.rows[0]?.result, 'OK', 'SET should return OK')

        const getResult = await engine.executeQuery(
          config!,
          'GET smoke:key',
          { database: DATABASE },
        )
        assertEqual(
          getResult.rows[0]?.result,
          'smoke_value_works',
          'GET should return the value we just SET',
        )

        // Intentionally NOT asserting version via `INFO server` here — the
        // executeQuery row shape for multi-line redis-cli output isn't
        // stable across helpers and the SET/GET roundtrip above already
        // proves the binary booted and is serving traffic. Hostdb's
        // resolveVersion test (in tests/integration/hostdb-sync.test.ts)
        // covers the version-mapping invariant separately.

        await engine.stop(config!)
        await waitForStopped(containerName, ENGINE)
      } finally {
        const config = await containerManager.getConfig(containerName)
        if (config) {
          const running = await processManager
            .isRunning(containerName, { engine: ENGINE })
            .catch(() => false)
          if (running) {
            await engine.stop(config).catch(() => {})
          }
          await containerManager
            .delete(containerName, { force: true })
            .catch(() => {})
        }
      }
    })
  }
})
