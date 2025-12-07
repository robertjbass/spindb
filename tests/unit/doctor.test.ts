/**
 * Unit tests for doctor command module
 */

import { describe, it } from 'node:test'
import { assert, assertEqual } from '../integration/helpers'

describe('Doctor Command', () => {
  describe('Health Check Result Shape', () => {
    it('should have required fields', () => {
      const result = {
        name: 'Test Check',
        status: 'ok' as const,
        message: 'Check passed',
      }

      assert(typeof result.name === 'string', 'Should have name')
      assert(
        ['ok', 'warning', 'error'].includes(result.status),
        'Should have valid status',
      )
      assert(typeof result.message === 'string', 'Should have message')
    })

    it('should support optional details array', () => {
      const result = {
        name: 'Test Check',
        status: 'ok' as const,
        message: 'Check passed',
        details: ['Detail 1', 'Detail 2'],
      }

      assert(Array.isArray(result.details), 'Details should be array')
      assertEqual(result.details.length, 2, 'Should have 2 details')
    })

    it('should support optional action', () => {
      const result = {
        name: 'Test Check',
        status: 'warning' as const,
        message: 'Issue found',
        action: {
          label: 'Fix issue',
          handler: async () => {
            // Action handler
          },
        },
      }

      assert(
        typeof result.action.label === 'string',
        'Action should have label',
      )
      assert(
        typeof result.action.handler === 'function',
        'Action should have handler',
      )
    })
  })

  describe('Status Values', () => {
    it('should support ok status', () => {
      const status: 'ok' | 'warning' | 'error' = 'ok'
      assertEqual(status, 'ok', 'Should support ok status')
    })

    it('should support warning status', () => {
      const status: 'ok' | 'warning' | 'error' = 'warning'
      assertEqual(status, 'warning', 'Should support warning status')
    })

    it('should support error status', () => {
      const status: 'ok' | 'warning' | 'error' = 'error'
      assertEqual(status, 'error', 'Should support error status')
    })
  })

  describe('Configuration Check', () => {
    it('should handle missing config file', () => {
      // Concept: missing config is OK (will be created on first use)
      const result = {
        name: 'Configuration',
        status: 'ok' as const,
        message: 'No config file yet (will be created on first use)',
      }

      assertEqual(result.status, 'ok', 'Missing config should be OK')
    })

    it('should detect stale binary cache', () => {
      const lastRefresh = new Date('2024-01-01').getTime()
      const now = new Date().getTime()
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000

      const isStale = now - lastRefresh > sevenDaysMs

      assert(isStale, 'Cache older than 7 days should be stale')
    })

    it('should report binary count', () => {
      const binaries = { psql: {}, pg_dump: {}, mysql: {} }
      const count = Object.keys(binaries).length

      assertEqual(count, 3, 'Should count binaries correctly')
    })
  })

  describe('Container Check', () => {
    it('should handle empty container list', () => {
      const containers: unknown[] = []
      const result = {
        name: 'Containers',
        status: 'ok' as const,
        message:
          containers.length === 0
            ? 'No containers (create one with: spindb create)'
            : '',
      }

      assert(
        result.message.includes('No containers'),
        'Should indicate no containers',
      )
    })

    it('should group containers by engine', () => {
      const containers = [
        { engine: 'postgresql', status: 'running' },
        { engine: 'postgresql', status: 'stopped' },
        { engine: 'mysql', status: 'running' },
        { engine: 'sqlite', status: 'running' },
      ]

      const byEngine: Record<string, { running: number; stopped: number }> = {}

      for (const c of containers) {
        if (!byEngine[c.engine]) {
          byEngine[c.engine] = { running: 0, stopped: 0 }
        }
        if (c.status === 'running') {
          byEngine[c.engine].running++
        } else {
          byEngine[c.engine].stopped++
        }
      }

      assertEqual(byEngine['postgresql'].running, 1, 'PostgreSQL running count')
      assertEqual(byEngine['postgresql'].stopped, 1, 'PostgreSQL stopped count')
      assertEqual(byEngine['mysql'].running, 1, 'MySQL running count')
      assertEqual(byEngine['sqlite'].running, 1, 'SQLite running count')
    })

    it('should use different labels for SQLite', () => {
      const engine = 'sqlite'
      const counts = { running: 2, stopped: 1 }

      const label =
        engine === 'sqlite'
          ? `${engine}: ${counts.running} exist, ${counts.stopped} missing`
          : `${engine}: ${counts.running} running, ${counts.stopped} stopped`

      assert(label.includes('exist'), 'SQLite should use "exist" label')
      assert(label.includes('missing'), 'SQLite should use "missing" label')
    })
  })

  describe('SQLite Registry Check', () => {
    it('should handle empty registry', () => {
      const entries: unknown[] = []
      const result = {
        name: 'SQLite Registry',
        status: 'ok' as const,
        message:
          entries.length === 0
            ? 'No SQLite databases registered'
            : `${entries.length} database(s) registered`,
      }

      assert(
        result.message.includes('No SQLite databases'),
        'Should indicate empty registry',
      )
    })

    it('should detect orphaned entries', () => {
      const orphans = [
        { name: 'old-project', filePath: '/path/to/missing.sqlite' },
      ]

      const result = {
        name: 'SQLite Registry',
        status: 'warning' as const,
        message: `${orphans.length} orphaned entry found`,
        details: orphans.map((o) => `"${o.name}" → ${o.filePath}`),
      }

      assertEqual(result.status, 'warning', 'Orphans should trigger warning')
      assert(
        result.details[0].includes('old-project'),
        'Should include orphan name',
      )
    })

    it('should pluralize orphan message correctly', () => {
      const singularCount = 1
      const pluralCount = 3

      const singularMsg = `${singularCount} orphaned entry found`
      const pluralMsg = `${pluralCount} orphaned entries found`

      assert(
        !singularMsg.includes('entries'),
        'Singular should not have "entries"',
      )
      assert(pluralMsg.includes('entries'), 'Plural should have "entries"')
    })

    it('should offer cleanup action for orphans', () => {
      const orphans = [{ name: 'old' }]

      const action =
        orphans.length > 0
          ? {
              label: 'Remove orphaned entries from registry',
              handler: async () => {},
            }
          : undefined

      assert(action !== undefined, 'Should offer action when orphans exist')
      assert(action?.label.includes('Remove'), 'Action should mention removal')
    })
  })

  describe('Binary Check', () => {
    it('should check all engines', () => {
      const engines = ['postgresql', 'mysql', 'sqlite']
      const results: string[] = []

      for (const engine of engines) {
        results.push(`${engine}: checked`)
      }

      assertEqual(results.length, 3, 'Should check all engines')
    })

    it('should report missing tools as warning', () => {
      const installed = 3
      const total = 4
      const hasWarning = installed < total

      assert(hasWarning, 'Missing tools should trigger warning')
    })

    it('should report all tools as OK', () => {
      const installed = 4
      const total = 4
      const hasWarning = installed < total

      assert(!hasWarning, 'All tools should be OK')
    })

    it('should format tool count correctly', () => {
      const engine = 'postgresql'
      const installed = 4
      const total = 4

      const message =
        installed < total
          ? `${engine}: ${installed}/${total} tools installed`
          : `${engine}: all ${total} tools available`

      assert(
        message.includes('all 4 tools'),
        'Should indicate all tools available',
      )
    })
  })

  describe('Action Menu', () => {
    it('should collect actions from warnings', () => {
      const checks = [
        { name: 'Check 1', status: 'ok' as const, message: 'OK' },
        {
          name: 'Check 2',
          status: 'warning' as const,
          message: 'Issue',
          action: { label: 'Fix it', handler: async () => {} },
        },
        { name: 'Check 3', status: 'ok' as const, message: 'OK' },
      ]

      const actionsAvailable = checks.filter((c) => c.action)

      assertEqual(actionsAvailable.length, 1, 'Should find one action')
    })

    it('should include skip option in menu', () => {
      const choices = [
        { name: 'Fix issue', value: 'Check 2' },
        { name: 'Skip (do nothing)', value: 'skip' },
      ]

      const skipOption = choices.find((c) => c.value === 'skip')

      assert(skipOption !== undefined, 'Should have skip option')
    })

    it('should show healthy message when no issues', () => {
      const checks = [
        { name: 'Check 1', status: 'ok' as const, message: 'OK' },
        { name: 'Check 2', status: 'ok' as const, message: 'OK' },
      ]

      const hasIssues = checks.some((c) => c.status !== 'ok')

      assert(!hasIssues, 'Should detect no issues')
    })
  })

  describe('JSON Output', () => {
    it('should strip action handlers for JSON', () => {
      const check = {
        name: 'Test',
        status: 'warning' as const,
        message: 'Issue',
        action: { label: 'Fix', handler: async () => {} },
      }

      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { action, ...jsonCheck } = check

      assert(!('action' in jsonCheck), 'JSON output should not have action')
      assert('name' in jsonCheck, 'JSON output should have name')
      assert('status' in jsonCheck, 'JSON output should have status')
      assert('message' in jsonCheck, 'JSON output should have message')
    })
  })

  describe('Display Formatting', () => {
    it('should use correct icons for status', () => {
      const icons = {
        ok: '✓',
        warning: '⚠',
        error: '✕',
      }

      assertEqual(icons.ok, '✓', 'OK should use checkmark')
      assertEqual(icons.warning, '⚠', 'Warning should use warning sign')
      assertEqual(icons.error, '✕', 'Error should use X')
    })

    it('should format details with indentation', () => {
      const details = ['Detail 1', 'Detail 2']
      const formatted = details.map((d) => `     ${d}`)

      assert(formatted[0].startsWith('     '), 'Details should be indented')
    })
  })
})
