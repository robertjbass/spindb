import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { branchManager } from '../../core/branch-manager'
import { containerManager } from '../../core/container-manager'
import { processManager } from '../../core/process-manager'
import { postgresqlEngine } from '../../engines/postgresql'
import { Engine, type ContainerConfig } from '../../types'

function setup(
  context: TestContext,
  options: {
    live?: boolean
    unknown?: boolean
    restartFails?: boolean
    replacement?: boolean
    reset?: boolean
  } = {},
) {
  const mock = context.mock
  const events: string[] = []
  const config: ContainerConfig = {
    name: 'source',
    engine: Engine.PostgreSQL,
    version: '18.6.0',
    port: 5454,
    database: 'diagnostic',
    created: '2026-10-08',
    status: 'running',
  }
  mock.method(containerManager, 'getConfig', async (name: string) => ({
    ...config,
    name,
    ...(options.reset && name === 'child' ? { branchParent: 'source' } : {}),
  }))
  mock.method(containerManager, 'isValidName', () => true)
  mock.method(containerManager, 'exists', async () => false)
  mock.method(processManager, 'isRunning', async () => true)
  let reads = 0
  mock.method(processManager, 'getPid', async () =>
    ++reads === 1 ? 123456 : options.replacement ? 654321 : null,
  )
  let clock = 0
  mock.method(Date, 'now', () => {
    clock += 6000
    return clock
  })
  mock.method(process, 'kill', (pid: number, signal: string | number) => {
    assert.equal(signal, 0, 'only liveness probes, never termination')
    if (options.unknown)
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
    if (options.live || pid === 654321) return true
    throw Object.assign(new Error('exited'), { code: 'ESRCH' })
  })
  mock.method(postgresqlEngine, 'stop', async (value: ContainerConfig) => {
    events.push(options.reset ? `stop:${value.name}` : 'stop')
    if (!options.reset || value.name === 'source')
      throw new Error('stop timed out')
  })
  mock.method(postgresqlEngine, 'start', async (value: ContainerConfig) => {
    events.push('start')
    assert.equal(value.port, 5454)
    if (options.restartFails) throw new Error('start failed')
    return { port: 5454, connectionString: 'test' }
  })
  mock.method(containerManager, 'copyContainerData', async () => {
    events.push('copy')
    throw new Error('unsafe copy')
  })
  mock.method(containerManager, 'updateConfig', async () => {
    events.push('update')
  })
  return events
}

for (const [name, options] of Object.entries({
  live: { live: true },
  unknown: { unknown: true },
  replacement: { replacement: true },
})) {
  test(`does not restart or copy when source liveness is ${name}`, async (context) => {
    const events = setup(context, options)
    await assert.rejects(
      branchManager.createBranch({ source: 'source', name: 'child' }),
      /Source recovery requires attention/,
    )
    assert.deepEqual(events, ['stop'])
  })
}

test('restarts an exited source on its original port, but still fails the branch', async (context) => {
  const events = setup(context)
  await assert.rejects(
    branchManager.createBranch({ source: 'source', name: 'child' }),
    /source has been restarted on its original port/,
  )
  assert.deepEqual(events, ['stop', 'start', 'update'])
})

test('surfaces restart failure without attempting a copy', async (context) => {
  const events = setup(context, { restartFails: true })
  await assert.rejects(
    branchManager.createBranch({ source: 'source', name: 'child' }),
    /Source recovery requires attention: start failed/,
  )
  assert.deepEqual(events, ['stop', 'start'])
})

test('reset restores the untouched branch when the parent cannot stop', async (context) => {
  const events = setup(context, { live: true, reset: true })
  await assert.rejects(
    branchManager.resetBranch('child'),
    /Source recovery requires attention/,
  )
  assert.deepEqual(events, [
    'stop:child',
    'update',
    'stop:source',
    'start',
    'update',
  ])
})
