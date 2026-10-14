import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEngine } from '../../engines'
import { waitForCronPause } from '../../engines/postgresql/cron-config'
import { Engine, type ContainerConfig, type QueryResult } from '../../types'

const postgresqlEngine = getEngine(Engine.PostgreSQL)

const container: ContainerConfig = {
  name: 'cron-restore-fixture',
  engine: Engine.PostgreSQL,
  version: '18.6.0',
  port: 55442,
  database: 'app',
  created: '2026-10-14',
  status: 'running',
}

function row(values: Record<string, string>): QueryResult {
  return { columns: Object.keys(values), rows: [values], rowCount: 1 }
}

function scriptedServer(options: {
  launch: string
  pausedAfterChecks?: number
  runningWorkers?: number[]
}) {
  const statements: string[] = []
  let settingChecks = 0
  const running = [...(options.runningWorkers ?? [])]
  async function query(sql: string): Promise<QueryResult> {
    statements.push(sql)
    if (sql.includes("current_setting('cron.launch_active_jobs', true)")) {
      return row({ enabled: options.launch })
    }
    if (sql.includes("current_setting('cron.launch_active_jobs')")) {
      settingChecks++
      const paused = settingChecks > (options.pausedAfterChecks ?? 0)
      return row({ enabled: paused ? 'off' : 'on' })
    }
    if (sql.includes('pg_terminate_backend')) {
      return row({ running: String(running.shift() ?? 0) })
    }
    return row({})
  }
  return { query, statements }
}

test('restore leaves servers without active pg_cron scheduling untouched', async (context) => {
  for (const launch of ['', 'off']) {
    const server = scriptedServer({ launch })
    const queried = context.mock.method(
      postgresqlEngine,
      'executeQuery',
      (_container: ContainerConfig, sql: string) => server.query(sql),
    )
    const stopped = context.mock.method(
      postgresqlEngine,
      'stop',
      async () => {},
    )
    await postgresqlEngine.prepareRestore(container)
    assert.equal(server.statements.length, 1)
    assert.equal(stopped.mock.callCount(), 0)
    queried.mock.restore()
    stopped.mock.restore()
  }
})

test('restore pauses pg_cron by reload, without stopping the server', async (context) => {
  const server = scriptedServer({
    launch: 'on',
    pausedAfterChecks: 1,
    runningWorkers: [1, 0, 0],
  })
  context.mock.method(
    postgresqlEngine,
    'executeQuery',
    (_container: ContainerConfig, sql: string) => server.query(sql),
  )
  const stopped = context.mock.method(postgresqlEngine, 'stop', async () => {})
  const started = context.mock.method(postgresqlEngine, 'start', async () => ({
    port: 55442,
    connectionString: '',
  }))

  await postgresqlEngine.prepareRestore(container)

  assert.equal(stopped.mock.callCount(), 0, 'live connections must survive')
  assert.equal(started.mock.callCount(), 0)
  assert.match(
    server.statements[1],
    /^ALTER SYSTEM SET cron\.launch_active_jobs = off$/,
  )
  assert.match(server.statements[2], /pg_reload_conf\(\)/)
  const firstTerminate = server.statements.findIndex((sql) =>
    sql.includes('pg_terminate_backend'),
  )
  const lastSettingCheck = server.statements
    .map((sql) => sql.includes("current_setting('cron.launch_active_jobs')"))
    .lastIndexOf(true)
  assert.ok(
    lastSettingCheck < firstTerminate,
    'in-flight jobs are ended only after the pause is confirmed',
  )
  assert.equal(
    server.statements.filter((sql) => sql.includes('pg_terminate_backend'))
      .length,
    3,
    'two consecutive empty polls are required after a running worker',
  )
})

test('restore does not begin when the pause never takes effect', async () => {
  const server = scriptedServer({ launch: 'on', pausedAfterChecks: Infinity })
  await assert.rejects(
    waitForCronPause(server.query, { timeoutMs: 20, pollMs: 1 }),
    /did not pause within .*Restore has not begun/,
  )
  assert.ok(
    !server.statements.some((sql) => sql.includes('pg_terminate_backend')),
  )
})

test('restore does not begin while pg_cron workers keep running', async () => {
  const server = scriptedServer({
    launch: 'on',
    runningWorkers: Array(1000).fill(1),
  })
  await assert.rejects(
    waitForCronPause(server.query, { timeoutMs: 20, pollMs: 1 }),
    /Restore has not begun/,
  )
})
