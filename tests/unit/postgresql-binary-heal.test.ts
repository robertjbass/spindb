import { describe, it, before, after, afterEach } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { paths } from '../../config/paths'
import { platformService } from '../../core/platform-service'
import { containerManager } from '../../core/container-manager'
import {
  postgresqlEngine,
  POSTGRESQL_BIN_PATH_VERSION,
  isCronBuildRevision,
} from '../../engines/postgresql'
import { CRON_MARKER_FILE } from '../../engines/postgresql/cron-config'
import { BinaryVersionNotFoundError } from '../../core/version-resolver'
import type { ContainerConfig } from '../../types'
import { assert, assertDeepEqual, assertEqual } from '../utils/assertions'

const realGetBinaryPath = paths.getBinaryPath.bind(paths)
const realFindInstalledBinaries = paths.findInstalledBinaries.bind(paths)
const realGetContainerDataPath = paths.getContainerDataPath.bind(paths)
const realUpdateConfig = containerManager.updateConfig.bind(containerManager)
const realEnsureBinaries =
  postgresqlEngine.ensureBinaries.bind(postgresqlEngine)

describe('PostgreSQL binary self-heal and pg_cron build revisions', () => {
  let root: string
  let ext: string
  let configUpdates: Array<{ name: string; version: unknown }>
  let downloads: string[]

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'spindb-pg-heal-test-'))
    ext = platformService.getExecutableExtension()
  })

  after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  afterEach(() => {
    paths.getBinaryPath = realGetBinaryPath
    paths.findInstalledBinaries = realFindInstalledBinaries
    paths.getContainerDataPath = realGetContainerDataPath
    containerManager.updateConfig = realUpdateConfig
    postgresqlEngine.ensureBinaries = realEnsureBinaries
  })

  function dirFor(version: string): string {
    return join(root, `postgresql-${version}`)
  }

  async function install(version: string): Promise<void> {
    const binDir = join(dirFor(version), 'bin')
    await mkdir(binDir, { recursive: true })
    await writeFile(join(binDir, `pg_ctl${ext}`), 'fake pg_ctl')
  }

  async function installWithCron(version: string): Promise<void> {
    await install(version)
    const dir = dirFor(version)
    await mkdir(join(dir, 'lib'), { recursive: true })
    await mkdir(join(dir, 'share', 'extension'), { recursive: true })
    await writeFile(join(dir, 'lib', 'pg_cron.so'), '')
    for (const file of [
      'pg_cron.control',
      'pg_cron--1.0.sql',
      'pg_cron--1.5--1.6.sql',
    ])
      await writeFile(join(dir, 'share', 'extension', file), '')
  }

  // A data directory per container; opted-in ones preload pg_cron.
  async function dataDir(name: string, optedIn: boolean): Promise<void> {
    const dir = join(root, 'data', name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'postgresql.auto.conf'),
      optedIn ? "shared_preload_libraries = 'pg_cron'\n" : '',
    )
  }

  function stub(installedVersions: string[]): void {
    configUpdates = []
    downloads = []
    paths.getBinaryPath = (options) => dirFor(options.version)
    paths.getContainerDataPath = (name: string) => join(root, 'data', name)
    paths.findInstalledBinaries = () =>
      installedVersions.map((version) => ({ version, path: dirFor(version) }))
    containerManager.updateConfig = async (name, updates) => {
      configUpdates.push({ name, version: updates.version })
      return { name, ...updates } as ContainerConfig
    }
    postgresqlEngine.ensureBinaries = async (version: string) => {
      downloads.push(version)
      return dirFor(version)
    }
  }

  it('resolves a -cron.N revision to itself', () => {
    assertEqual(
      postgresqlEngine.resolveFullVersion('18.6.0-cron.1'),
      '18.6.0-cron.1',
      'cron revision is an identity version',
    )
    assertEqual(
      postgresqlEngine.resolveFullVersion('19.0.0-beta.3-cron.1'),
      '19.0.0-beta.3-cron.1',
      'beta cron revision is an identity version',
    )
  })

  it('downloads the pinned cron revision instead of healing onto a plain same-major binary', async () => {
    await install('18.6.0')
    stub(['18.6.0'])

    const result = await postgresqlEngine.getBinaryPathWithFallback(
      '18.6.0-cron.1',
      'cron-db',
    )

    assertDeepEqual(downloads, ['18.6.0-cron.1'], 'downloads pinned revision')
    assertEqual(result.actualVersion, '18.6.0-cron.1', 'version unchanged')
    assertEqual(result.wasHealed, false, 'not healed')
    assertEqual(result.binPath, dirFor('18.6.0-cron.1'), 'pinned bin path')
    assertDeepEqual(configUpdates, [], 'container config untouched')
    assertEqual(
      postgresqlEngine.hasCompatibleBinaries('18.6.0-cron.1'),
      false,
      'a plain same-major binary is not startable for a cron revision',
    )
  })

  it('does not heal a plain container onto a cron revision', async () => {
    await install('18.6.0-cron.1')
    stub(['18.6.0-cron.1'])

    const result = await postgresqlEngine.getBinaryPathWithFallback(
      '18.5.0',
      'plain-db',
    )

    assert(
      !downloads.includes('18.6.0-cron.1') &&
        result.actualVersion !== '18.6.0-cron.1',
      'plain container never lands on a cron revision',
    )
    assert(
      configUpdates.every((update) => update.version !== '18.6.0-cron.1'),
      'config never repinned to a cron revision',
    )
    assertEqual(
      postgresqlEngine.hasCompatibleBinaries('18.5.0'),
      false,
      'a cron revision does not make a plain version startable',
    )
  })

  it('still heals a plain container onto a plain same-major binary, skipping a newer cron revision', async () => {
    await install('18.6.0-cron.1')
    await install('18.4.0')
    stub(['18.6.0-cron.1', '18.4.0'])

    const result = await postgresqlEngine.getBinaryPathWithFallback(
      '18.5.0',
      'plain-db',
    )

    assertEqual(result.actualVersion, '18.4.0', 'healed onto plain binary')
    assertEqual(result.wasHealed, true, 'healed')
    assertDeepEqual(downloads, [], 'nothing downloaded')
    assertDeepEqual(
      configUpdates,
      [{ name: 'plain-db', version: '18.4.0' }],
      'config repinned to the plain binary',
    )
    assertEqual(
      postgresqlEngine.hasCompatibleBinaries('18.5.0'),
      true,
      'plain same-major binary is compatible',
    )
  })

  it('uses the exact cron revision when it is installed', async () => {
    await install('18.6.0-cron.1')
    stub(['18.6.0-cron.1'])

    const result = await postgresqlEngine.getBinaryPathWithFallback(
      '18.6.0-cron.1',
      'cron-db',
    )

    assertEqual(result.actualVersion, '18.6.0-cron.1', 'exact revision')
    assertEqual(result.wasHealed, false, 'not healed')
    assertDeepEqual(downloads, [], 'nothing downloaded')
    assertEqual(
      postgresqlEngine.hasCompatibleBinaries('18.6.0-cron.1'),
      true,
      'exact cron revision is startable',
    )
  })

  it('heals an opted-in plain container only onto a binary that contains pg_cron', async () => {
    await install('18.4.0')
    await installWithCron('18.1.0')
    await dataDir('opted-in-db', true)
    stub(['18.4.0', '18.1.0'])

    const result = await postgresqlEngine.getBinaryPathWithFallback(
      '18.5.0',
      'opted-in-db',
    )

    assertEqual(result.actualVersion, '18.1.0', 'skipped 18.4.0 (no pg_cron)')
    assertDeepEqual(downloads, [], 'nothing downloaded')
    assertDeepEqual(
      configUpdates,
      [{ name: 'opted-in-db', version: '18.1.0' }],
      'config repinned to the pg_cron-capable binary',
    )
  })

  it('re-downloads the pinned version of an opted-in container instead of healing onto a binary without pg_cron', async () => {
    await install('18.4.0')
    await dataDir('opted-in-db', true)
    stub(['18.4.0'])

    const result = await postgresqlEngine.getBinaryPathWithFallback(
      '18.5.0',
      'opted-in-db',
    )

    assertDeepEqual(downloads, ['18.5.0'], 'downloaded the pinned version')
    assertEqual(result.actualVersion, '18.5.0', 'pin kept')
    assertEqual(result.wasHealed, false, 'not healed')
    assertDeepEqual(configUpdates, [], 'container config untouched')
  })

  it('falls back to the major default only when the registry has no opted-in pinned version (404)', async () => {
    await dataDir('opted-in-db', true)
    stub([])
    postgresqlEngine.ensureBinaries = async (version: string) => {
      downloads.push(version)
      if (version === '18.5.0')
        throw new BinaryVersionNotFoundError(
          'PostgreSQL 18.5.0 binaries not found (404).',
        )
      return dirFor(version)
    }
    const progress: string[] = []

    const result = await postgresqlEngine.getBinaryPathWithFallback(
      '18.5.0',
      'opted-in-db',
      (event) => progress.push(event.message),
    )

    assertEqual(downloads[0], '18.5.0', 'pinned version tried first')
    assertEqual(downloads.length, 2, 'then the major default')
    assert(!downloads[1].includes('-cron.'), 'never a legacy cron revision')
    assertEqual(result.wasHealed, true, 'healed onto the major default')
    assert(
      progress.some((message) => message.includes('not found (404)')),
      `notice carries the registry error: ${progress.join(' | ')}`,
    )
  })

  for (const [label, failure] of [
    ['a network failure', new Error('fetch failed: ECONNRESET')],
    [
      'a timeout',
      new Error(
        'Download timed out after 5 minutes. Check your network connection and try again.',
      ),
    ],
    [
      'a full disk',
      Object.assign(new Error('ENOSPC: no space left on device, write'), {
        code: 'ENOSPC',
      }),
    ],
    [
      'a read-only bin directory',
      Object.assign(new Error('EROFS: read-only file system, mkdir'), {
        code: 'EROFS',
      }),
    ],
  ] as const) {
    it(`keeps an opted-in pin and rethrows on ${label} instead of falling back`, async () => {
      await dataDir('opted-in-db', true)
      const dir = join(root, 'data', 'opted-in-db')
      await writeFile(join(dir, CRON_MARKER_FILE), '{}')
      stub([])
      postgresqlEngine.ensureBinaries = async (version: string) => {
        downloads.push(version)
        throw failure
      }

      let error: unknown
      try {
        await postgresqlEngine.getBinaryPathWithFallback(
          '18.5.0',
          'opted-in-db',
        )
      } catch (caught) {
        error = caught
      }

      assert(error instanceof Error, 'the failure is rethrown')
      assert(
        error.message.includes(failure.message),
        `original error text kept: ${error.message}`,
      )
      assert(
        error.message.includes('spindb engines download postgresql 18.5.0'),
        'actionable retry command',
      )
      assertDeepEqual(downloads, ['18.5.0'], 'no major default download')
      assertDeepEqual(configUpdates, [], 'container not repinned')
      assert(existsSync(join(dir, CRON_MARKER_FILE)), 'pg_cron marker kept')
      assertEqual(
        await readFile(join(dir, 'postgresql.auto.conf'), 'utf8'),
        "shared_preload_libraries = 'pg_cron'\n",
        'pg_cron preload untouched',
      )
    })
  }

  it('heals a plain container that did not opt in exactly as before, pg_cron or not', async () => {
    await install('18.4.0')
    await dataDir('plain-db', false)
    stub(['18.4.0'])

    const result = await postgresqlEngine.getBinaryPathWithFallback(
      '18.5.0',
      'plain-db',
    )

    assertEqual(result.actualVersion, '18.4.0', 'healed onto 18.4.0')
    assertDeepEqual(downloads, [], 'nothing downloaded')
  })

  it('identifies cron build revisions', () => {
    assert(isCronBuildRevision('18.6.0-cron.1'), 'GA cron revision')
    assert(isCronBuildRevision('19.0.0-beta.3-cron.1'), 'beta cron revision')
    assert(!isCronBuildRevision('18.6.0'), 'plain GA')
    assert(!isCronBuildRevision('19.0.0-beta.3'), 'plain beta')
  })
})

describe('POSTGRESQL_BIN_PATH_VERSION', () => {
  const cases: Array<[string, string]> = [
    ['/home/u/.spindb/bin/postgresql-17.7.0-darwin-arm64', '17.7.0'],
    [
      '/home/u/.spindb/bin/postgresql-19.0.0-beta.1-darwin-arm64',
      '19.0.0-beta.1',
    ],
    ['/home/u/.spindb/bin/postgresql-19.0.0-rc.2-linux-x64', '19.0.0-rc.2'],
    ['/home/u/.spindb/bin/postgresql-18.6.0-cron.1-linux-x64', '18.6.0-cron.1'],
    [
      '/home/u/.spindb/bin/postgresql-19.0.0-beta.3-cron.1-linux-x64',
      '19.0.0-beta.3-cron.1',
    ],
  ]

  for (const [path, expected] of cases) {
    it(`extracts ${expected}`, () => {
      assertEqual(path.match(POSTGRESQL_BIN_PATH_VERSION)?.[1], expected, path)
    })
  }
})
