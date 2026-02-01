/**
 * Tests that all commands with --json flag output valid JSON.
 *
 * This test suite ensures that:
 * 1. Commands with --json flag output pure JSON (no extra text)
 * 2. The JSON is parseable
 * 3. No regressions occur where --json stops working
 *
 * Note: Commands that require arguments (like container names) are tested
 * separately with expected error JSON output.
 */

import { describe, it } from 'node:test'
import { execSync } from 'child_process'
import { join } from 'path'

const CLI_PATH = join(process.cwd(), 'cli/bin.ts')

type CommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run a CLI command and capture output
 * @param args - Command arguments to pass to the CLI
 * @param timeout - Command timeout in ms (default: 30000, use 60000 for slow commands like doctor)
 */
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

/**
 * Validate that output is valid JSON
 */
function isValidJson(output: string): { valid: boolean; error?: string } {
  const trimmed = output.trim()

  if (!trimmed) {
    return { valid: false, error: 'Empty output' }
  }

  try {
    JSON.parse(trimmed)
    return { valid: true }
  } catch (error) {
    const e = error as Error
    return { valid: false, error: e.message }
  }
}

/**
 * Assert that output is valid JSON, with helpful error message
 */
function assertValidJson(
  output: string,
  command: string,
): asserts output is string {
  const result = isValidJson(output)
  if (!result.valid) {
    const preview = output.slice(0, 200)
    throw new Error(
      `Command "${command}" did not output valid JSON.\n` +
        `Error: ${result.error}\n` +
        `Output preview: ${preview}${output.length > 200 ? '...' : ''}`,
    )
  }
}

describe('JSON Output Validation', () => {
  describe('Commands without required arguments', () => {
    // These commands should output valid JSON without any arguments

    it('spindb list --json', () => {
      const result = runCommand('list --json')
      // list --json should succeed even with no containers
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'list --json')
        const parsed = JSON.parse(result.stdout.trim())
        // Should be an array of containers
        if (!Array.isArray(parsed)) {
          throw new Error('list --json should output an array')
        }
      } else {
        // If it fails, the error should still be JSON
        assertValidJson(result.stdout || result.stderr, 'list --json (error)')
      }
    })

    it('spindb info --json (lists all containers)', () => {
      const result = runCommand('info --json')
      // info --json without container name lists all containers
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'info --json')
        const parsed = JSON.parse(result.stdout.trim())
        // Should be an array of container info
        if (!Array.isArray(parsed)) {
          throw new Error('info --json should output an array')
        }
      }
    })

    it('spindb engines --json', () => {
      const result = runCommand('engines --json')
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'engines --json')
      } else {
        // May fail if no engines installed, but should still be JSON error
        const output = result.stdout || result.stderr
        if (output.trim()) {
          assertValidJson(output, 'engines --json (error)')
        }
      }
    })

    it('spindb engines list --json', () => {
      const result = runCommand('engines list --json')
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'engines list --json')
      } else {
        const output = result.stdout || result.stderr
        if (output.trim()) {
          assertValidJson(output, 'engines list --json (error)')
        }
      }
    })

    it('spindb databases list --json (all containers)', () => {
      const result = runCommand('databases list --json')
      // databases list --json should succeed even with no containers
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'databases list --json')
        const parsed = JSON.parse(result.stdout.trim())
        // Should be an array of containers with their databases
        if (!Array.isArray(parsed)) {
          throw new Error('databases list --json should output an array')
        }
        // If there are containers, validate structure
        for (const item of parsed) {
          if (!item.container || !item.engine || !item.databases) {
            throw new Error(
              'databases list item missing required fields (container, engine, databases)',
            )
          }
        }
      }
    })

    it('spindb engines supported --json', () => {
      const result = runCommand('engines supported --json')
      // This should always succeed - it reads from engines.json
      if (result.exitCode !== 0) {
        throw new Error(
          `engines supported --json failed with exit code ${result.exitCode}`,
        )
      }
      assertValidJson(result.stdout, 'engines supported --json')

      // Validate structure
      const parsed = JSON.parse(result.stdout.trim())
      if (!parsed.engines) {
        throw new Error(
          'engines supported --json should have an "engines" object',
        )
      }
      if (!parsed.engines.postgresql) {
        throw new Error('engines supported --json should include postgresql')
      }
    })

    it('spindb config show --json', () => {
      const result = runCommand('config show --json')
      if (result.exitCode === 0) {
        assertValidJson(result.stdout, 'config show --json')
      } else {
        // Config might not exist, but error should be JSON
        const output = result.stdout || result.stderr
        if (output.trim()) {
          assertValidJson(output, 'config show --json (error)')
        }
      }
    })

    it('spindb doctor --json', () => {
      // doctor command can be slow on Windows CI due to system checks
      const result = runCommand('doctor --json', 60000)
      // doctor --json should always output valid JSON
      assertValidJson(result.stdout, 'doctor --json')

      // Validate structure - doctor outputs an array of check results
      const parsed = JSON.parse(result.stdout.trim())
      if (!Array.isArray(parsed)) {
        throw new Error('doctor --json should output an array of checks')
      }
      // Each check should have name and status
      for (const check of parsed) {
        if (!check.name || !check.status) {
          throw new Error('doctor check missing required fields (name, status)')
        }
      }
    })
  })

  describe('Commands requiring arguments (error case)', () => {
    // These commands require arguments and should output JSON errors when missing

    it('spindb url --json (no container) should fail', () => {
      const result = runCommand('url --json')
      // url requires a container name
      if (result.exitCode === 0) {
        throw new Error('url --json should fail without container argument')
      }
    })

    it('spindb info nonexistent --json should output JSON error', () => {
      const result = runCommand('info nonexistent-container-12345 --json')
      // Should fail because container doesn't exist
      if (result.exitCode === 0) {
        throw new Error('info --json should fail for nonexistent container')
      }
      // Error should be JSON
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'info nonexistent --json')
      }
    })

    it('spindb url nonexistent --json should output JSON error', () => {
      const result = runCommand('url nonexistent-container-12345 --json')
      if (result.exitCode === 0) {
        throw new Error('url --json should fail for nonexistent container')
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'url nonexistent --json')
      }
    })

    it('spindb attach /nonexistent/path --json should output JSON error', () => {
      const result = runCommand('attach /nonexistent/path/db.sqlite --json')
      if (result.exitCode === 0) {
        throw new Error('attach --json should fail for nonexistent path')
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'attach nonexistent --json')
      }
    })

    it('spindb detach nonexistent --json should output JSON error', () => {
      const result = runCommand('detach nonexistent-db-12345 --json')
      if (result.exitCode === 0) {
        throw new Error('detach --json should fail for nonexistent container')
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'detach nonexistent --json')
      }
    })

    it('spindb databases list nonexistent --json should output JSON error', () => {
      const result = runCommand(
        'databases list nonexistent-container-12345 --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases list --json should fail for nonexistent container',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases list nonexistent --json')
        // Verify the error structure
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error('databases list error should include "error" field')
        }
      }
    })

    it('spindb databases add nonexistent db --json should output JSON error', () => {
      const result = runCommand(
        'databases add nonexistent-container-12345 testdb --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases add --json should fail for nonexistent container',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases add nonexistent --json')
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error('databases add error should include "error" field')
        }
      }
    })

    it('spindb databases remove nonexistent db --json should output JSON error', () => {
      const result = runCommand(
        'databases remove nonexistent-container-12345 testdb --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases remove --json should fail for nonexistent container',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases remove nonexistent --json')
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error('databases remove error should include "error" field')
        }
      }
    })

    it('spindb databases sync nonexistent old new --json should output JSON error', () => {
      const result = runCommand(
        'databases sync nonexistent-container-12345 olddb newdb --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases sync --json should fail for nonexistent container',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases sync nonexistent --json')
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error('databases sync error should include "error" field')
        }
      }
    })

    it('spindb databases set-default nonexistent db --json should output JSON error', () => {
      const result = runCommand(
        'databases set-default nonexistent-container-12345 testdb --json',
      )
      if (result.exitCode === 0) {
        throw new Error(
          'databases set-default --json should fail for nonexistent container',
        )
      }
      const output = result.stdout.trim()
      if (output) {
        assertValidJson(output, 'databases set-default nonexistent --json')
        const parsed = JSON.parse(output)
        if (!parsed.error) {
          throw new Error(
            'databases set-default error should include "error" field',
          )
        }
      }
    })
  })

  describe('JSON structure validation', () => {
    it('list --json should have correct structure', () => {
      const result = runCommand('list --json')
      if (result.exitCode === 0) {
        const parsed = JSON.parse(result.stdout.trim())
        // Should be an array
        if (!Array.isArray(parsed)) {
          throw new Error('list --json should output an array')
        }
        // Each container should have required fields (if any exist)
        for (const container of parsed) {
          if (!container.name || !container.engine) {
            throw new Error('Container missing required fields (name, engine)')
          }
        }
      }
    })

    it('engines supported --json should have correct structure', () => {
      const result = runCommand('engines supported --json')
      const parsed = JSON.parse(result.stdout.trim())

      // Validate schema reference
      if (!parsed.$schema) {
        throw new Error('Missing "$schema" field')
      }

      // Validate engines object
      if (!parsed.engines || typeof parsed.engines !== 'object') {
        throw new Error('Missing or invalid "engines" object')
      }

      // Validate at least one engine has required fields
      const postgresql = parsed.engines.postgresql
      if (!postgresql) {
        throw new Error('Missing postgresql engine')
      }
      if (!postgresql.displayName || !postgresql.defaultVersion) {
        throw new Error('PostgreSQL missing required fields')
      }
    })

    it('doctor --json should have correct structure', () => {
      // doctor command can be slow on Windows CI due to system checks
      const result = runCommand('doctor --json', 60000)
      const parsed = JSON.parse(result.stdout.trim())

      // doctor outputs an array of checks
      if (!Array.isArray(parsed)) {
        throw new Error('doctor --json should output an array')
      }

      // Each check should have name, status, and message
      for (const check of parsed) {
        if (!check.name) {
          throw new Error('Check missing "name" field')
        }
        if (!check.status) {
          throw new Error('Check missing "status" field')
        }
        if (!['ok', 'warning', 'error'].includes(check.status)) {
          throw new Error(`Invalid check status: ${check.status}`)
        }
      }
    })
  })
})
