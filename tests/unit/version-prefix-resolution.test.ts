/**
 * Version prefix resolution
 *
 * Covers the engine-agnostic resolver behind `--db-version`: exact matches win,
 * a prefix resolves to the newest release matching it on version-segment
 * boundaries, and a prefix that matches nothing resolves to null instead of
 * being passed through as a download URL nobody can serve.
 */

import { describe, it } from 'node:test'
import {
  isVersionPrefixOf,
  resolveVersionPrefix,
} from '../../core/version-utils'
import {
  resolveEngineVersion,
  listAvailableVersions,
  formatAvailableVersions,
  binariesNotFoundMessage,
} from '../../core/version-resolver'
import { assert, assertEqual } from '../utils/assertions'

// Representative of the shapes hostdb actually ships across the 21 engines:
// 3-part semver, 4-part ClickHouse, 2-part-major lines, and prereleases.
const POSTGRES = [
  '19.0.0-beta.3',
  '19.0.0-beta.1',
  '18.6.0',
  '18.4.0',
  '18.1.0',
  '17.10.0',
  '17.7.0',
  '16.14.0',
]
const INFLUX = ['3.10.5', '3.8.0']
const CLICKHOUSE = ['25.12.3.21', '25.8.1.4']

describe('isVersionPrefixOf', () => {
  it('matches on segment boundaries', () => {
    assert(isVersionPrefixOf('3', '3.10.5'), "'3' is a prefix of 3.10.5")
    assert(isVersionPrefixOf('3.10', '3.10.5'), "'3.10' is a prefix of 3.10.5")
    assert(
      isVersionPrefixOf('25.12.3', '25.12.3.21'),
      "'25.12.3' is a prefix of the 4-part ClickHouse version",
    )
  })

  it('does not match a partial segment', () => {
    assert(
      isVersionPrefixOf('3.1', '3.10.5') === false,
      "'3.1' must not match 3.10.5 (segment boundary, not substring)",
    )
    assert(
      isVersionPrefixOf('1', '18.6.0') === false,
      "'1' must not match 18.6.0",
    )
    assert(
      isVersionPrefixOf('18.6.0', '18.6.0.1') === true,
      'a shorter full version is a legitimate prefix of a longer one',
    )
  })

  it('treats an identical version as a prefix of itself', () => {
    assert(isVersionPrefixOf('18.6.0', '18.6.0'), 'exact equality is a prefix')
  })

  it('never matches a longer prefix than the candidate', () => {
    assert(
      isVersionPrefixOf('18.6.0.1', '18.6.0') === false,
      'a longer request cannot be a prefix of a shorter version',
    )
  })

  it('handles empty input without matching', () => {
    assert(
      isVersionPrefixOf('', '18.6.0') === false,
      'empty prefix matches nothing',
    )
    assert(
      isVersionPrefixOf('18', '') === false,
      'empty candidate matches nothing',
    )
  })
})

describe('resolveVersionPrefix', () => {
  it('resolves a major-minor prefix to the newest matching patch', () => {
    assertEqual(
      resolveVersionPrefix('3.10', INFLUX),
      '3.10.5',
      "'3.10' should resolve to 3.10.5",
    )
    assertEqual(
      resolveVersionPrefix('18', POSTGRES),
      '18.6.0',
      "'18' should resolve to the newest 18.x",
    )
  })

  it('resolves a bare major to the newest release on that line', () => {
    assertEqual(
      resolveVersionPrefix('3', INFLUX),
      '3.10.5',
      "'3' should resolve to 3.10.5, not 3.8.0",
    )
    assertEqual(
      resolveVersionPrefix('17', POSTGRES),
      '17.10.0',
      "'17' should resolve to 17.10.0, not 17.7.0",
    )
  })

  it('respects segment boundaries', () => {
    assertEqual(
      resolveVersionPrefix('3.1', INFLUX),
      null,
      "'3.1' must not resolve to 3.10.5",
    )
    assertEqual(
      resolveVersionPrefix('1', POSTGRES),
      null,
      "'1' must not resolve to 18.6.0 or 19.x",
    )
  })

  it('returns an exact match unchanged', () => {
    assertEqual(
      resolveVersionPrefix('18.4.0', POSTGRES),
      '18.4.0',
      'an exact version resolves to itself, not to the newest 18.x',
    )
  })

  it('handles 4-part ClickHouse versions', () => {
    assertEqual(
      resolveVersionPrefix('25.12', CLICKHOUSE),
      '25.12.3.21',
      "'25.12' resolves into the 4-part scheme",
    )
    assertEqual(
      resolveVersionPrefix('25', CLICKHOUSE),
      '25.12.3.21',
      "'25' picks the newest 4-part release",
    )
    assertEqual(
      resolveVersionPrefix('25.1', CLICKHOUSE),
      null,
      "'25.1' must not match 25.12.3.21",
    )
  })

  it('returns null for a no-match prefix and for an empty candidate list', () => {
    assertEqual(
      resolveVersionPrefix('99', POSTGRES),
      null,
      'unknown major resolves to null',
    )
    assertEqual(
      resolveVersionPrefix('18', []),
      null,
      'empty list resolves to null',
    )
    assertEqual(
      resolveVersionPrefix('', POSTGRES),
      null,
      'empty prefix resolves to null',
    )
  })

  it('ranks candidates with compareVersions, prerelease suffixes included', () => {
    // The pure resolver ranks whatever list it is handed; keeping prereleases
    // out of that list is resolveEngineVersion's job, not this function's.
    assertEqual(
      resolveVersionPrefix('19', ['19.0.0-rc.1', '19.0.0']),
      '19.0.0',
      'GA outranks the prerelease of the same version',
    )
    assertEqual(
      resolveVersionPrefix('19', ['19.0.0-rc.1', '19.0.0-rc.2']),
      '19.0.0-rc.2',
      'newer prerelease wins when both are prereleases',
    )
  })
})

describe('resolveEngineVersion (against the bundled hostdb registry)', () => {
  it('resolves an exact full version to itself', () => {
    const available = listAvailableVersions('postgresql')
    assert(available.length > 0, 'hostdb should know PostgreSQL versions')
    const newest = available[0]
    assertEqual(
      resolveEngineVersion('postgresql', newest),
      newest,
      'an exact version resolves to itself',
    )
  })

  it('resolves a major to a full version that actually exists', () => {
    const resolved = resolveEngineVersion('postgresql', '18')
    assert(resolved !== null, "'18' should resolve")
    assert(
      listAvailableVersions('postgresql').includes(resolved as string),
      `'18' resolved to ${resolved}, which is not an available release`,
    )
  })

  it('resolves a major-minor prefix for every engine that publishes one', () => {
    for (const engine of ['postgresql', 'influxdb', 'mysql', 'mariadb']) {
      const available = listAvailableVersions(engine)
      assert(available.length > 0, `hostdb should know ${engine} versions`)
      for (const full of available) {
        const parts = full.split('.')
        const majorMinor = `${parts[0]}.${parts[1]}`
        const resolved = resolveEngineVersion(engine, majorMinor)
        assert(
          resolved !== null && available.includes(resolved),
          `${engine} '${majorMinor}' should resolve to an available release, got ${resolved}`,
        )
        assert(
          resolved!.startsWith(`${majorMinor}.`) || resolved === majorMinor,
          `${engine} '${majorMinor}' resolved outside its own line: ${resolved}`,
        )
      }
    }
  })

  it('keeps prereleases opt-in', () => {
    // '19' has no GA release; the beta must not be picked up implicitly.
    const resolved = resolveEngineVersion('postgresql', '19')
    const ga = listAvailableVersions('postgresql')
    assert(
      resolved === null || ga.includes(resolved),
      `'19' resolved to ${resolved}, which is a prerelease`,
    )
  })

  it('resolves an explicitly requested prerelease prefix', () => {
    const prereleases = listAvailableVersions('postgresql', {
      includePrerelease: true,
    }).filter((v) => v.includes('-'))
    if (prereleases.length === 0) return
    const channelPrefix = prereleases[0].slice(
      0,
      prereleases[0].lastIndexOf('.'),
    )
    const resolved = resolveEngineVersion('postgresql', channelPrefix)
    assert(
      resolved !== null && resolved.startsWith(channelPrefix),
      `'${channelPrefix}' should resolve to a prerelease, got ${resolved}`,
    )
  })

  it('returns null for a version that does not exist', () => {
    assertEqual(
      resolveEngineVersion('postgresql', '99.99.99'),
      null,
      'a nonexistent version resolves to null',
    )
    assertEqual(
      resolveEngineVersion('postgresql', ''),
      null,
      'an empty version resolves to null',
    )
  })

  it('returns null for an unknown engine instead of throwing', () => {
    assertEqual(
      resolveEngineVersion('not-a-real-engine', '1.2.3'),
      null,
      'unknown engines resolve to null',
    )
  })
})

describe('binariesNotFoundMessage', () => {
  it('lists what is actually available', () => {
    const message = binariesNotFoundMessage({
      engine: 'influxdb',
      displayName: 'InfluxDB',
      version: '3.1',
    })
    assert(message.includes('InfluxDB 3.1'), 'names the requested version')
    assert(message.includes('404'), 'keeps the 404 signal')
    for (const version of listAvailableVersions('influxdb')) {
      assert(
        message.includes(version),
        `message should list available version ${version}`,
      )
    }
  })

  it('degrades gracefully for an engine hostdb does not know', () => {
    assertEqual(
      formatAvailableVersions('not-a-real-engine'),
      '',
      'no version list for an unknown engine',
    )
    const message = binariesNotFoundMessage({
      engine: 'not-a-real-engine',
      displayName: 'Nope',
      version: '1.0.0',
    })
    assert(message.includes('Nope 1.0.0'), 'still names the request')
  })
})
