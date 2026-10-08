import { describe, it } from 'node:test'
import {
  ensureStartBinaries,
  needsStartBinariesCheck,
  startBinariesDownloadCommand,
  type StartBinariesEngine,
} from '../../core/start-binaries'
import { getEngine } from '../../engines'
import { postgresqlEngine } from '../../engines/postgresql'
import { Engine, ALL_ENGINES, isFileBasedEngine } from '../../types'
import { assert, assertDeepEqual, assertEqual } from '../utils/assertions'

type FakeOptions = {
  installed: boolean
  checkError?: string
  downloadError?: string
}

function makeFakeEngine(options: FakeOptions) {
  const calls = {
    check: [] as string[],
    download: [] as string[],
  }
  const engine: StartBinariesEngine = {
    displayName: 'MariaDB',
    async hasStartableBinaries(version) {
      calls.check.push(version)
      if (options.checkError) throw new Error(options.checkError)
      return options.installed
    },
    async ensureBinaries(version, onProgress) {
      calls.download.push(version)
      if (options.downloadError) throw new Error(options.downloadError)
      onProgress?.({ stage: 'downloading', message: 'Downloading...' })
      return '/bin/path'
    },
  }
  return { engine, calls }
}

describe('needsStartBinariesCheck', () => {
  it('skips file-based engines and containers with no usable version', () => {
    assert(
      !needsStartBinariesCheck(Engine.SQLite, '3.50.4'),
      'SQLite has no server binary to check before start',
    )
    assert(
      !needsStartBinariesCheck(Engine.DuckDB, '1.4.0'),
      'DuckDB has no server binary to check before start',
    )
    assert(
      !needsStartBinariesCheck(Engine.MariaDB, 'unknown'),
      "'unknown' cannot be downloaded",
    )
    assert(
      !needsStartBinariesCheck(Engine.MariaDB, undefined),
      'a missing version cannot be downloaded',
    )
    assert(
      !needsStartBinariesCheck(Engine.MariaDB, ''),
      'an empty version cannot be downloaded',
    )
  })

  it('checks every server engine', () => {
    for (const engine of ALL_ENGINES) {
      if (isFileBasedEngine(engine)) continue
      assert(
        needsStartBinariesCheck(engine, '1.2.3'),
        `${engine} should be checked before start`,
      )
    }
  })
})

describe('ensureStartBinaries', () => {
  const engineName = Engine.MariaDB
  const version = '10.11.16'

  it('returns skipped without touching the engine for file-based engines', async () => {
    const { engine, calls } = makeFakeEngine({ installed: false })
    const result = await ensureStartBinaries({
      engine,
      engineName: Engine.SQLite,
      version: '3.50.4',
    })
    assertEqual(result.kind, 'skipped', 'file-based engines are skipped')
    assertEqual(calls.check.length, 0, 'no binary check for SQLite')
    assertEqual(calls.download.length, 0, 'no download for SQLite')
  })

  it('does nothing when the pinned version is installed', async () => {
    const { engine, calls } = makeFakeEngine({ installed: true })
    let prompted = false
    const result = await ensureStartBinaries({
      engine,
      engineName,
      version,
      confirm: async () => {
        prompted = true
        return true
      },
    })
    assertEqual(result.kind, 'installed', 'installed binaries need no work')
    assert(!prompted, 'must not prompt when binaries are installed')
    assertEqual(calls.download.length, 0, 'must not download')
  })

  it('checks and downloads the exact pinned version, never a shorthand', async () => {
    const { engine, calls } = makeFakeEngine({ installed: false })
    const result = await ensureStartBinaries({ engine, engineName, version })
    assertEqual(result.kind, 'downloaded', 'missing binaries are downloaded')
    assertDeepEqual(calls.check, [version], 'the exact version is checked')
    assertDeepEqual(
      calls.download,
      [version],
      'the exact version is downloaded',
    )
  })

  it('downloads without a prompt when no confirm callback is given', async () => {
    const { engine, calls } = makeFakeEngine({ installed: false })
    let downloadStarted = 0
    const progress: string[] = []
    const result = await ensureStartBinaries({
      engine,
      engineName,
      version,
      onDownloadStart: () => {
        downloadStarted++
      },
      onProgress: ({ message }) => {
        progress.push(message)
      },
    })
    assertEqual(result.kind, 'downloaded', 'non-interactive mode downloads')
    assertEqual(downloadStarted, 1, 'onDownloadStart fires once')
    assertDeepEqual(progress, ['Downloading...'], 'progress is forwarded')
    assertEqual(calls.download.length, 1, 'downloaded once')
  })

  it('asks first when a confirm callback is given and downloads on yes', async () => {
    const { engine, calls } = makeFakeEngine({ installed: false })
    const prompts: string[] = []
    const result = await ensureStartBinaries({
      engine,
      engineName,
      version,
      confirm: async (message) => {
        prompts.push(message)
        return true
      },
    })
    assertEqual(result.kind, 'downloaded', 'yes downloads')
    assertDeepEqual(
      prompts,
      ['MariaDB 10.11.16 is not installed. Download now?'],
      'the prompt names the engine and the pinned version',
    )
    assertDeepEqual(calls.download, [version], 'downloaded the pinned version')
  })

  it('returns declined with the manual command on no, downloading nothing', async () => {
    const { engine, calls } = makeFakeEngine({ installed: false })
    let downloadStarted = 0
    const result = await ensureStartBinaries({
      engine,
      engineName,
      version,
      confirm: async () => false,
      onDownloadStart: () => {
        downloadStarted++
      },
    })
    assertEqual(result.kind, 'declined', 'no declines')
    assert(result.kind === 'declined', 'narrow')
    assertEqual(
      result.manualCommand,
      'spindb engines download mariadb 10.11.16',
      'manual command names the engine slug and exact version',
    )
    assertEqual(calls.download.length, 0, 'nothing downloaded after no')
    assertEqual(downloadStarted, 0, 'onDownloadStart not fired after no')
  })

  it('throws a download failure that names the version and the manual command', async () => {
    const { engine } = makeFakeEngine({
      installed: false,
      downloadError:
        "ENOENT: no such file or directory, mkdir '/home/u/.spindb/bin/temp-mariadb-10.11.16-linux-x64'",
    })
    let thrown: unknown
    try {
      await ensureStartBinaries({ engine, engineName, version })
    } catch (error) {
      thrown = error
    }
    assert(thrown instanceof Error, 'download failure throws an Error')
    const message = thrown.message
    assert(
      message.startsWith('MariaDB 10.11.16 not available: '),
      `uses the create wording so callers parse one shape: ${message}`,
    )
    assert(
      message.includes('temp-mariadb-10.11.16-linux-x64'),
      'keeps the underlying error text (Layerbase Cloud reads the temp dir)',
    )
    assert(
      message.includes('spindb engines download mariadb 10.11.16'),
      'names the manual download command',
    )
  })

  it('skips (and does not download) when the binary check itself throws', async () => {
    const { engine, calls } = makeFakeEngine({
      installed: false,
      checkError: 'cannot resolve version',
    })
    const result = await ensureStartBinaries({ engine, engineName, version })
    assertEqual(result.kind, 'skipped', 'engine.start() stays the backstop')
    assertEqual(calls.download.length, 0, 'no download on a failed check')
  })
})

describe('startBinariesDownloadCommand', () => {
  it('builds the non-interactive two-argument download command', () => {
    assertEqual(
      startBinariesDownloadCommand(Engine.ClickHouse, '25.8.5.1'),
      'spindb engines download clickhouse 25.8.5.1',
      'engine slug plus exact version',
    )
  })
})

describe('BaseEngine.hasStartableBinaries', () => {
  it('is the exact-version install check for every non-PostgreSQL engine', async () => {
    for (const engineName of ALL_ENGINES) {
      if (engineName === Engine.PostgreSQL) continue
      const engine = getEngine(engineName)
      // A version no registry has ever published: never installed, so both
      // answers must be false and must agree.
      const version = '0.0.1'
      let startable: boolean
      let installed: boolean
      try {
        startable = await engine.hasStartableBinaries(version)
        installed = await engine.isBinaryInstalled(version)
      } catch {
        // An engine whose resolver rejects an unknown version rejects both
        // the same way; ensureStartBinaries treats that as 'skipped'.
        continue
      }
      assertEqual(
        startable,
        installed,
        `${engineName}: hasStartableBinaries must equal isBinaryInstalled`,
      )
      assert(!startable, `${engineName}: 0.0.1 can never be installed`)
    }
  })

  it('PostgreSQL accepts same-major binaries (start self-heals onto them)', async () => {
    const version = '17.0.0'
    assertEqual(
      await postgresqlEngine.hasStartableBinaries(version),
      postgresqlEngine.hasCompatibleBinaries(version),
      'PostgreSQL delegates to its same-major compatibility check',
    )
  })
})
