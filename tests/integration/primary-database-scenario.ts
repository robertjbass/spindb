/**
 * Dropped primary database scenario, shared by the engine suites whose
 * databases exist durably (see durableDatabaseExistence in
 * core/database-capabilities.ts).
 *
 * Drives the real CLI the way layerbase-cloud does (create --no-start, then
 * start --json), drops the primary with SQL, and checks what start and backup
 * report afterward.
 */

import { spawn } from 'child_process'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { executeSQL } from './helpers'
import { assert, assertEqual } from '../utils/assertions'
import type { Engine } from '../../types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_PATH = join(__dirname, '../../cli/bin.ts')

type CliResult = { stdout: string; stderr: string; exitCode: number }

async function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.execPath,
      ['--import', 'tsx', CLI_PATH, ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk) => (stdout += String(chunk)))
    proc.stderr.on('data', (chunk) => (stderr += String(chunk)))
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))
  })
}

function parseJson(result: CliResult, label: string): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout.trim()) as Record<string, unknown>
  } catch {
    throw new Error(
      `${label}: stdout is not JSON (exit ${result.exitCode})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    )
  }
}

async function startJson(
  name: string,
  extraArgs: string[] = [],
): Promise<{ name: string; state: string }> {
  const result = await runCli(['start', name, '--json', ...extraArgs])
  const json = parseJson(result, `start ${extraArgs.join(' ')}`)
  assertEqual(result.exitCode, 0, `start should succeed: ${result.stdout}`)
  assertEqual(json.success, true, 'start success')
  const primary = json.primaryDatabase as { name: string; state: string }
  assert(
    primary !== undefined,
    `start --json should include primaryDatabase: ${result.stdout}`,
  )
  return primary
}

async function stop(name: string): Promise<void> {
  const result = await runCli(['stop', name, '--json'])
  assertEqual(result.exitCode, 0, `stop should succeed: ${result.stdout}`)
}

export async function runDroppedPrimaryScenario(options: {
  engine: Engine
  version: string
  port: number
  name: string
  // Database the drop statement connects to (never the primary itself)
  adminDatabase: string
}): Promise<void> {
  const { engine, version, port, name, adminDatabase } = options
  const primary = 'appdb'
  const sibling = 'otherdb'
  const outputDir = await mkdtemp(join(tmpdir(), 'spindb-primary-db-'))

  try {
    const created = await runCli([
      'create',
      name,
      '--engine',
      engine,
      '--db-version',
      version,
      '--port',
      String(port),
      '--database',
      primary,
      '--no-start',
      '--force',
      '--json',
    ])
    assertEqual(
      created.exitCode,
      0,
      `create should succeed: ${created.stdout} ${created.stderr}`,
    )

    // First start of a --no-start container creates the primary: not a
    // recreation
    const first = await startJson(name)
    assertEqual(first.name, primary, 'primaryDatabase.name')
    assertEqual(first.state, 'created', 'first start state')
    await executeSQL(engine, port, adminDatabase, `CREATE DATABASE ${sibling}`)

    // Restart with the primary intact (and empty): present
    await stop(name)
    const intact = await startJson(name)
    assertEqual(intact.state, 'present', 'empty primary counts as present')

    // Drop the primary inside the server, then start with the default
    await executeSQL(engine, port, adminDatabase, `DROP DATABASE ${primary}`)
    await stop(name)
    const recreated = await startJson(name)
    assertEqual(recreated.state, 'recreated', 'default start recreates')

    // Drop again, then start with --no-recreate-database
    await executeSQL(engine, port, adminDatabase, `DROP DATABASE ${primary}`)
    await stop(name)
    const missing = await startJson(name, ['--no-recreate-database'])
    assertEqual(missing.state, 'missing', 'start leaves it missing')

    // Backup of the missing primary is a structured refusal
    const backup = await runCli([
      'backup',
      name,
      '-d',
      primary,
      '-o',
      outputDir,
      '--json',
    ])
    const backupJson = parseJson(backup, 'backup')
    assert(backup.exitCode !== 0, 'backup of a dropped database should fail')
    assertEqual(backupJson.code, 'database_not_found', 'backup code')
    assertEqual(backupJson.database, primary, 'backup database')
    const available = backupJson.availableDatabases as string[]
    assert(
      Array.isArray(available) && available.includes(sibling),
      `availableDatabases should list ${sibling}: ${backup.stdout}`,
    )
    assert(
      !available.includes(primary),
      'availableDatabases should not list the dropped primary',
    )
    assert(
      typeof backupJson.error === 'string' &&
        (backupJson.error as string).includes(primary),
      'error message should name the database',
    )

    // The sibling still backs up normally
    const siblingBackup = await runCli([
      'backup',
      name,
      '-d',
      sibling,
      '-o',
      outputDir,
      '--json',
    ])
    assertEqual(
      siblingBackup.exitCode,
      0,
      `backup of an existing database should succeed: ${siblingBackup.stdout} ${siblingBackup.stderr}`,
    )

    await stop(name)
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {})
  }
}
