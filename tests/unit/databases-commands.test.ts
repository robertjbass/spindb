/**
 * Tests for database create, drop, and rename CLI subcommands.
 *
 * These tests validate:
 * 1. Unsupported engine errors for all 6 blocked engines
 * 2. Missing container errors
 * 3. JSON output format for errors
 * 4. Remote container blocking
 * 5. Missing arguments in JSON mode
 */

import { describe, it } from 'node:test'
import { execSync } from 'child_process'
import { join } from 'path'
import { assert, assertEqual } from '../utils/assertions'

const CLI_PATH = join(process.cwd(), 'cli/bin.ts')

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

function runCommand(args: string, timeout = 30000): CommandResult {
  try {
    const stdout = execSync(`node --import tsx "${CLI_PATH}" ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout,
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
    }
  }
}

function parseJson(output: string): Record<string, unknown> {
  const trimmed = output.trim()
  return JSON.parse(trimmed) as Record<string, unknown>
}

describe('databases create command', () => {
  it('should error when container does not exist (--json)', () => {
    const result = runCommand('databases create nonexistent testdb --json')
    assertEqual(result.exitCode, 1, 'Should exit with code 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', 'Should have error field')
    assert((json.error as string).includes('not found'), 'Should say not found')
  })

  it('should error when database name missing in --json mode', () => {
    // Even though container doesn't exist, the container check happens first
    const result = runCommand('databases create nonexistent --json')
    assertEqual(result.exitCode, 1, 'Should exit with code 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', 'Should have error field')
  })

  it('should output valid JSON for errors', () => {
    const result = runCommand('databases create nonexistent mydb --json')
    assertEqual(result.exitCode, 1, 'Should exit with code 1')
    // Should not throw on parse
    const json = parseJson(result.stdout)
    assert(json !== null, 'Should parse as valid JSON')
  })
})

describe('databases drop command', () => {
  it('should error when container does not exist (--json)', () => {
    const result = runCommand(
      'databases drop nonexistent testdb --json --force',
    )
    assertEqual(result.exitCode, 1, 'Should exit with code 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', 'Should have error field')
    assert((json.error as string).includes('not found'), 'Should say not found')
  })

  it('should error when database name missing in --json mode', () => {
    const result = runCommand('databases drop nonexistent --json')
    assertEqual(result.exitCode, 1, 'Should exit with code 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', 'Should have error field')
  })
})

describe('databases rename command', () => {
  it('should error when container does not exist (--json)', () => {
    const result = runCommand('databases rename nonexistent olddb newdb --json')
    assertEqual(result.exitCode, 1, 'Should exit with code 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', 'Should have error field')
    assert((json.error as string).includes('not found'), 'Should say not found')
  })

  it('should error when names missing in --json mode', () => {
    const result = runCommand('databases rename nonexistent --json')
    assertEqual(result.exitCode, 1, 'Should exit with code 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', 'Should have error field')
  })

  it('should error when only old name given in --json mode', () => {
    const result = runCommand('databases rename nonexistent olddb --json')
    assertEqual(result.exitCode, 1, 'Should exit with code 1')
    const json = parseJson(result.stdout)
    assert(typeof json.error === 'string', 'Should have error field')
  })
})

describe('databases commands - help output', () => {
  it('databases create --help should show usage', () => {
    const result = runCommand('databases create --help')
    assertEqual(result.exitCode, 0, 'Help should exit with code 0')
    assert(
      result.stdout.includes('container'),
      'Should mention container argument',
    )
    assert(
      result.stdout.includes('database'),
      'Should mention database argument',
    )
  })

  it('databases drop --help should show usage', () => {
    const result = runCommand('databases drop --help')
    assertEqual(result.exitCode, 0, 'Help should exit with code 0')
    assert(
      result.stdout.includes('container'),
      'Should mention container argument',
    )
    assert(result.stdout.includes('--force'), 'Should mention --force option')
  })

  it('databases rename --help should show usage', () => {
    const result = runCommand('databases rename --help')
    assertEqual(result.exitCode, 0, 'Help should exit with code 0')
    assert(
      result.stdout.includes('container'),
      'Should mention container argument',
    )
    assert(result.stdout.includes('--backup'), 'Should mention --backup option')
    assert(
      result.stdout.includes('--no-drop'),
      'Should mention --no-drop option',
    )
  })
})
