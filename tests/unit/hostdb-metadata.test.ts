import { describe, it } from 'node:test'
import {
  isVersionEnabled,
  isVersionDeprecated,
  unwrapDatabasesJson,
} from '../../core/hostdb-metadata'
import { assertEqual } from '../utils/assertions'

describe('isVersionEnabled', () => {
  it('should return true for boolean true', () => {
    assertEqual(isVersionEnabled(true), true, 'true should be enabled')
  })

  it('should return false for boolean false', () => {
    assertEqual(isVersionEnabled(false), false, 'false should be disabled')
  })

  it('should return true for empty object (enabled by default)', () => {
    assertEqual(isVersionEnabled({}), true, 'empty object should be enabled')
  })

  it('should return true for object with enabled: true', () => {
    assertEqual(
      isVersionEnabled({ enabled: true }),
      true,
      'explicitly enabled should be true',
    )
  })

  it('should return false for object with enabled: false', () => {
    assertEqual(
      isVersionEnabled({ enabled: false }),
      false,
      'explicitly disabled should be false',
    )
  })

  it('should return true for object with platforms only', () => {
    assertEqual(
      isVersionEnabled({ platforms: ['darwin-arm64'] }),
      true,
      'object with platforms but no enabled field should be enabled',
    )
  })

  it('should return true for object with dependencies', () => {
    assertEqual(
      isVersionEnabled({
        dependencies: [
          { database: 'postgresql', cascadeDelete: true, note: 'required' },
        ],
      }),
      true,
      'object with dependencies but no enabled field should be enabled',
    )
  })

  it('should return true for deprecated version (still enabled)', () => {
    assertEqual(
      isVersionEnabled({ deprecated: true }),
      true,
      'deprecated version should still be enabled',
    )
  })
})

describe('isVersionDeprecated', () => {
  it('should return false for boolean true', () => {
    assertEqual(
      isVersionDeprecated(true),
      false,
      'boolean true is not deprecated',
    )
  })

  it('should return false for boolean false', () => {
    assertEqual(
      isVersionDeprecated(false),
      false,
      'boolean false is not deprecated',
    )
  })

  it('should return false for empty object', () => {
    assertEqual(
      isVersionDeprecated({}),
      false,
      'empty object is not deprecated',
    )
  })

  it('should return true for object with deprecated: true', () => {
    assertEqual(
      isVersionDeprecated({ deprecated: true }),
      true,
      'explicitly deprecated should be true',
    )
  })

  it('should return false for object with deprecated: false', () => {
    assertEqual(
      isVersionDeprecated({ deprecated: false }),
      false,
      'explicitly not deprecated should be false',
    )
  })

  it('should return true for deprecated version with note', () => {
    assertEqual(
      isVersionDeprecated({ deprecated: true, note: 'Use 9.6.0 instead' }),
      true,
      'deprecated with note should be true',
    )
  })

  it('should return false for object with only platforms', () => {
    assertEqual(
      isVersionDeprecated({ platforms: ['linux-x64'] }),
      false,
      'object with only platforms is not deprecated',
    )
  })
})

describe('unwrapDatabasesJson', () => {
  it('should unwrap current schema with databases wrapper', () => {
    const raw = {
      _generated: '2026-03-11',
      $schema: 'https://example.com/schema.json',
      databases: {
        mysql: { displayName: 'MySQL', versions: { '9.6.0': true } },
        postgresql: { displayName: 'PostgreSQL', versions: { '17.7.0': true } },
      },
    }
    const result = unwrapDatabasesJson(raw)
    assertEqual('mysql' in result, true, 'should have mysql key')
    assertEqual('postgresql' in result, true, 'should have postgresql key')
    assertEqual('_generated' in result, false, 'should not have metadata keys')
    assertEqual(
      'databases' in result,
      false,
      'should not have databases wrapper',
    )
  })

  it('should pass through legacy flat schema', () => {
    const raw = {
      mysql: { displayName: 'MySQL', versions: { '9.6.0': true } },
      postgresql: { displayName: 'PostgreSQL', versions: { '17.7.0': true } },
    }
    const result = unwrapDatabasesJson(raw)
    assertEqual('mysql' in result, true, 'should have mysql key')
    assertEqual('postgresql' in result, true, 'should have postgresql key')
  })

  it('should not unwrap if databases is an array', () => {
    const raw = {
      databases: ['mysql', 'postgresql'],
      mysql: { displayName: 'MySQL', versions: {} },
    }
    const result = unwrapDatabasesJson(raw)
    assertEqual('mysql' in result, true, 'should treat as flat schema')
    assertEqual(
      'databases' in result,
      true,
      'should keep databases array as-is',
    )
  })
})
