import { describe, it, afterEach } from 'node:test'
import { containerManager } from '../../core/container-manager'
import { assertPostgresVersionStopped } from '../../cli/commands/engines'
import { reportStartNotices } from '../../cli/commands/start'
import { Engine, type ContainerConfig } from '../../types'
import { assert, assertDeepEqual, assertEqual } from '../utils/assertions'

const realList = containerManager.list.bind(containerManager)

function container(
  name: string,
  options: { engine?: Engine; version: string; status: string },
): ContainerConfig {
  return {
    name,
    engine: options.engine ?? Engine.PostgreSQL,
    version: options.version,
    status: options.status,
  } as ContainerConfig
}

describe('engines download postgresql --refresh guard', () => {
  afterEach(() => {
    containerManager.list = realList
  })

  it('refuses while a database runs from that version and names how to stop it', async () => {
    containerManager.list = async () => [
      container('app-db', { version: '18.6.0', status: 'running' }),
      container('idle-db', { version: '18.6.0', status: 'stopped' }),
      container('other-db', { version: '17.7.0', status: 'running' }),
    ]

    let error: unknown
    try {
      await assertPostgresVersionStopped('18.6.0')
    } catch (caught) {
      error = caught
    }

    assert(error instanceof Error, 'refresh refused')
    assert(error.message.includes('app-db'), 'names the running database')
    assert(error.message.includes('spindb stop app-db'), 'says how to stop it')
    assert(!error.message.includes('idle-db'), 'stopped database not listed')
    assert(!error.message.includes('other-db'), 'other version not listed')
  })

  it('allows the refresh when only other versions or engines are running', async () => {
    containerManager.list = async () => [
      container('idle-db', { version: '18.6.0', status: 'stopped' }),
      container('other-db', { version: '17.7.0', status: 'running' }),
      container('cache', {
        engine: Engine.Redis,
        version: '18.6.0',
        status: 'running',
      }),
    ]

    await assertPostgresVersionStopped('18.6.0')
  })
})

describe('start notices', () => {
  function capture(run: () => void): { stdout: string[]; stderr: string[] } {
    const stdout: string[] = []
    const stderr: string[] = []
    const realLog = console.log
    const realError = console.error
    console.log = (...args: unknown[]) => {
      stdout.push(args.join(' '))
    }
    console.error = (...args: unknown[]) => {
      stderr.push(args.join(' '))
    }
    try {
      run()
    } finally {
      console.log = realLog
      console.error = realError
    }
    return { stdout, stderr }
  }

  it('go to stderr under --json so stdout stays valid JSON, without failing the start', () => {
    const exitCodeBefore = process.exitCode
    const notice = 'pg_cron disabled: the binary does not include pg_cron'

    const { stdout, stderr } = capture(() =>
      reportStartNotices([notice], { json: true }),
    )

    assertDeepEqual(stdout, [], 'nothing on stdout')
    assertDeepEqual(stderr, [notice], 'notice on stderr')
    assertEqual(process.exitCode, exitCodeBefore, 'exit code unchanged')
  })

  it('print as warnings on stdout without --json', () => {
    const notice = 'pg_cron disabled: the binary does not include pg_cron'

    const { stdout, stderr } = capture(() =>
      reportStartNotices([notice], { json: false }),
    )

    assertEqual(stdout.length, 1, 'one line on stdout')
    assert(stdout[0].includes(notice), 'notice text shown')
    assertDeepEqual(stderr, [], 'nothing on stderr')
  })
})
