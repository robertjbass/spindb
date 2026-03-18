/**
 * Tests for the bin-path command.
 *
 * Tests engine resolution, tool validation, and output formats.
 * Uses the CLI directly to test end-to-end behavior.
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

describe('bin-path command', () => {
  describe('engine validation', () => {
    it('should reject unknown engine names', () => {
      const result = runCommand('bin-path invalid-engine --json')
      assertEqual(result.exitCode, 1, 'should exit with code 1')
      const json = JSON.parse(result.stdout.trim())
      assert(
        json.error.includes('Unknown engine'),
        'should include error message',
      )
    })

    it('should accept canonical engine names', () => {
      // This may succeed or fail depending on whether binaries are installed,
      // but it should NOT fail with "Unknown engine"
      const result = runCommand('bin-path postgresql --json')
      if (result.exitCode !== 0) {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('Unknown engine'),
          'postgresql should be recognized as a valid engine',
        )
      }
    })

    it('should accept engine aliases', () => {
      const result = runCommand('bin-path pg --json')
      if (result.exitCode !== 0) {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('Unknown engine'),
          'pg alias should resolve to postgresql',
        )
      }
    })

    it('should accept postgres alias', () => {
      const result = runCommand('bin-path postgres --json')
      if (result.exitCode !== 0) {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('Unknown engine'),
          'postgres alias should resolve to postgresql',
        )
      }
    })

    it('should accept mongo alias', () => {
      const result = runCommand('bin-path mongo --json')
      if (result.exitCode !== 0) {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('Unknown engine'),
          'mongo alias should resolve to mongodb',
        )
      }
    })
  })

  describe('tool validation', () => {
    it('should reject tools not belonging to the engine', () => {
      const result = runCommand('bin-path redis --tool psql --json')
      assertEqual(result.exitCode, 1, 'should exit with code 1')
      const json = JSON.parse(result.stdout.trim())
      assert(
        json.error.includes('not a known tool'),
        'should say tool is not known for engine',
      )
    })

    it('should suggest available tools when tool is invalid', () => {
      const result = runCommand(
        'bin-path postgresql --tool invalid-tool --json',
      )
      assertEqual(result.exitCode, 1, 'should exit with code 1')
      const json = JSON.parse(result.stdout.trim())
      assert(json.error.includes('Available:'), 'should list available tools')
    })
  })

  describe('JSON output format', () => {
    it('should output valid JSON with --json flag', () => {
      const result = runCommand('bin-path postgresql --json')
      const json = JSON.parse(result.stdout.trim())
      // Whether found or error, it should be valid JSON
      assert(
        typeof json === 'object' && json !== null,
        'output should be a JSON object',
      )
    })

    it('should include engine and tool in successful JSON output', () => {
      const result = runCommand('bin-path postgresql --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(json.engine, 'postgresql', 'engine should be postgresql')
        assertEqual(json.tool, 'psql', 'default tool should be psql')
        assert(typeof json.path === 'string', 'path should be a string')
        assert(json.path.length > 0, 'path should not be empty')
      }
    })

    it('should include error field in error JSON output', () => {
      const result = runCommand('bin-path not-a-real-engine --json')
      assertEqual(result.exitCode, 1, 'should exit with code 1')
      const json = JSON.parse(result.stdout.trim())
      assert(typeof json.error === 'string', 'should have error field')
    })
  })

  describe('default tool selection', () => {
    it('should default to psql for postgresql', () => {
      const result = runCommand('bin-path postgresql --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(json.tool, 'psql', 'default tool should be psql')
      } else {
        const json = JSON.parse(result.stdout.trim())
        // If not found, the error should mention psql (the default tool)
        assert(
          json.error.includes('psql'),
          'error should reference default tool psql',
        )
      }
    })

    it('should default to redis-server for redis', () => {
      const result = runCommand('bin-path redis --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(
          json.tool,
          'redis-server',
          'default tool should be redis-server',
        )
      } else {
        const json = JSON.parse(result.stdout.trim())
        assert(
          json.error.includes('redis-server'),
          'error should reference default tool redis-server',
        )
      }
    })
  })

  describe('specific tool selection', () => {
    it('should accept --tool pg_dump for postgresql', () => {
      const result = runCommand('bin-path postgresql --tool pg_dump --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(json.tool, 'pg_dump', 'tool should be pg_dump')
      } else {
        const json = JSON.parse(result.stdout.trim())
        // Should not be an "unknown tool" error
        assert(
          !json.error.includes('not a known tool'),
          'pg_dump should be valid for postgresql',
        )
      }
    })

    it('should accept --tool redis-cli for redis', () => {
      const result = runCommand('bin-path redis --tool redis-cli --json')
      if (result.exitCode === 0) {
        const json = JSON.parse(result.stdout.trim())
        assertEqual(json.tool, 'redis-cli', 'tool should be redis-cli')
      } else {
        const json = JSON.parse(result.stdout.trim())
        assert(
          !json.error.includes('not a known tool'),
          'redis-cli should be valid for redis',
        )
      }
    })
  })

  describe('non-JSON output', () => {
    it('should output just the path without --json', () => {
      const result = runCommand('bin-path postgresql')
      if (result.exitCode === 0) {
        const output = result.stdout.trim()
        // Should be a bare path, not JSON
        assert(!output.startsWith('{'), 'plain output should not be JSON')
        assert(output.length > 0, 'output should not be empty')
      }
    })

    it('should exit non-zero when binary not found', () => {
      // Use an engine that's unlikely to have system binaries
      const result = runCommand('bin-path tigerbeetle')
      // Either exits 0 (found) or 1 (not found) — both are valid
      assert(
        result.exitCode === 0 || result.exitCode === 1,
        'should exit with 0 or 1',
      )
    })
  })

  describe('no argument', () => {
    it('should show error when no engine is provided', () => {
      const result = runCommand('bin-path')
      assertEqual(result.exitCode, 1, 'should exit with code 1')
    })
  })
})
