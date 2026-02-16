import { describe, it } from 'node:test'
import {
  filterEnginesByPlatform,
  type EngineConfig,
  type EnginesJson,
} from '../../config/engines-registry'
import { assert, assertEqual, assertDeepEqual } from '../utils/assertions'
import type { Engine } from '../../types'

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    displayName: 'Test',
    icon: '🧪',
    status: 'integrated',
    binarySource: 'hostdb',
    supportedVersions: ['1.0.0'],
    defaultVersion: '1.0.0',
    defaultPort: 5432,
    runtime: 'server',
    queryLanguage: 'sql',
    scriptFileLabel: 'Run SQL file',
    connectionScheme: 'postgresql',
    superuser: null,
    clientTools: [],
    ...overrides,
  }
}

function makeEnginesJson(engines: Record<string, EngineConfig>): EnginesJson {
  return { engines: engines as Record<Engine, EngineConfig> }
}

describe('filterEnginesByPlatform', () => {
  it('should pass through engines with no platform restrictions', () => {
    const data = makeEnginesJson({
      postgresql: makeConfig({ displayName: 'PostgreSQL' }),
    })

    const result = filterEnginesByPlatform(data, 'darwin-arm64')

    assert(
      'postgresql' in result.engines,
      'postgresql should be present when no platform restrictions',
    )
    assertEqual(
      result.engines['postgresql' as Engine].displayName,
      'PostgreSQL',
      'Config should be unchanged',
    )
  })

  it('should remove engines whose platforms exclude the current platform', () => {
    const data = makeEnginesJson({
      postgresql: makeConfig(),
      clickhouse: makeConfig({
        displayName: 'ClickHouse',
        platforms: ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'],
      }),
    })

    const result = filterEnginesByPlatform(data, 'win32-x64')

    assert(
      'postgresql' in result.engines,
      'postgresql should remain (no platform restriction)',
    )
    assert(
      !('clickhouse' in result.engines),
      'clickhouse should be removed on win32-x64',
    )
  })

  it('should keep engines whose platforms include the current platform', () => {
    const data = makeEnginesJson({
      clickhouse: makeConfig({
        platforms: ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'],
      }),
    })

    const result = filterEnginesByPlatform(data, 'darwin-arm64')

    assert(
      'clickhouse' in result.engines,
      'clickhouse should be present on darwin-arm64',
    )
  })

  it('should filter versions based on versionPlatforms', () => {
    const data = makeEnginesJson({
      ferretdb: makeConfig({
        supportedVersions: ['1.24.2', '2.7.0'],
        defaultVersion: '2.7.0',
        versionPlatforms: {
          '1.24.2': [
            'darwin-arm64',
            'darwin-x64',
            'linux-arm64',
            'linux-x64',
            'win32-x64',
          ],
          '2.7.0': ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'],
        },
      }),
    })

    const result = filterEnginesByPlatform(data, 'win32-x64')
    const ferretdb = result.engines['ferretdb' as Engine]

    assert('ferretdb' in result.engines, 'ferretdb should still be present')
    assertDeepEqual(
      ferretdb.supportedVersions,
      ['1.24.2'],
      'Only v1 should remain on Windows',
    )
    assertEqual(
      ferretdb.defaultVersion,
      '1.24.2',
      'Default should be adjusted to first remaining version',
    )
  })

  it('should keep both versions on supported platforms', () => {
    const data = makeEnginesJson({
      ferretdb: makeConfig({
        supportedVersions: ['1.24.2', '2.7.0'],
        defaultVersion: '2.7.0',
        versionPlatforms: {
          '1.24.2': [
            'darwin-arm64',
            'darwin-x64',
            'linux-arm64',
            'linux-x64',
            'win32-x64',
          ],
          '2.7.0': ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'],
        },
      }),
    })

    const result = filterEnginesByPlatform(data, 'darwin-arm64')
    const ferretdb = result.engines['ferretdb' as Engine]

    assertDeepEqual(
      ferretdb.supportedVersions,
      ['1.24.2', '2.7.0'],
      'Both versions should remain on macOS',
    )
    assertEqual(
      ferretdb.defaultVersion,
      '2.7.0',
      'Default should remain unchanged',
    )
  })

  it('should remove engine when all versions are filtered out', () => {
    const data = makeEnginesJson({
      testengine: makeConfig({
        supportedVersions: ['1.0.0', '2.0.0'],
        defaultVersion: '2.0.0',
        versionPlatforms: {
          '1.0.0': ['linux-x64'],
          '2.0.0': ['linux-x64'],
        },
      }),
    })

    const result = filterEnginesByPlatform(data, 'darwin-arm64')

    assert(
      !('testengine' in result.engines),
      'Engine should be removed when all versions are filtered out',
    )
  })

  it('should keep versions with no versionPlatforms entry', () => {
    const data = makeEnginesJson({
      testengine: makeConfig({
        supportedVersions: ['1.0.0', '2.0.0', '3.0.0'],
        defaultVersion: '3.0.0',
        versionPlatforms: {
          '1.0.0': ['linux-x64'],
          // 2.0.0 has no entry — should be kept on all platforms
          '3.0.0': ['darwin-arm64', 'linux-x64'],
        },
      }),
    })

    const result = filterEnginesByPlatform(data, 'darwin-arm64')
    const engine = result.engines['testengine' as Engine]

    assertDeepEqual(
      engine.supportedVersions,
      ['2.0.0', '3.0.0'],
      'Versions without versionPlatforms entry should be kept',
    )
    assertEqual(
      engine.defaultVersion,
      '3.0.0',
      'Default should remain since 3.0.0 is still present',
    )
  })
})
