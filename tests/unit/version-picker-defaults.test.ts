import { describe, it } from 'node:test'
import {
  getMajorVersionMarkers,
  resolveDefaultMajorVersion,
} from '../../cli/ui/version-picker-defaults'
import { getEngineDefaults } from '../../config/engine-defaults'
import { assert } from '../utils/assertions'

describe('resolveDefaultMajorVersion', () => {
  it('preselects the configured default when it is in the list', () => {
    assert(
      resolveDefaultMajorVersion({
        selectableMajors: ['9.7', '9.6', '8.4', '8.0'],
        configuredDefault: '8.4',
      }) === '8.4',
      'MySQL should preselect the 8.4 LTS line, not the newest 9.x',
    )
  })

  it('falls back to the newest line when the configured default is absent', () => {
    assert(
      resolveDefaultMajorVersion({
        selectableMajors: ['0'],
        configuredDefault: '0.24',
      }) === '0',
      'an absent configured default keeps the newest-first behavior',
    )
  })

  it('falls back to the newest line when no default is configured', () => {
    assert(
      resolveDefaultMajorVersion({
        selectableMajors: ['18', '17', '16'],
      }) === '18',
      'no configured default should preselect the newest line',
    )
  })

  it('never preselects a prerelease-only line', () => {
    assert(
      resolveDefaultMajorVersion({
        selectableMajors: ['19', '18', '17'],
        prereleaseMajors: ['19'],
      }) === '18',
      'a prerelease major must not be preselected',
    )
    assert(
      resolveDefaultMajorVersion({
        selectableMajors: ['19', '18'],
        configuredDefault: '19',
        prereleaseMajors: ['19'],
      }) === '18',
      'a configured default that is prerelease-only is not eligible',
    )
  })

  it('returns undefined when nothing is selectable', () => {
    assert(
      resolveDefaultMajorVersion({
        selectableMajors: [],
        configuredDefault: '18',
      }) === undefined,
      'an empty picker has no default',
    )
    assert(
      resolveDefaultMajorVersion({
        selectableMajors: ['19'],
        prereleaseMajors: ['19'],
      }) === undefined,
      'a prerelease-only picker has no default',
    )
  })

  it('honors the configured default even when deprecation hid newer lines', () => {
    assert(
      resolveDefaultMajorVersion({
        selectableMajors: ['11.8', '11.4'],
        configuredDefault: '11.8',
      }) === '11.8',
      'the configured default survives the deprecation filter',
    )
  })
})

describe('getMajorVersionMarkers', () => {
  it('labels the newest line as latest', () => {
    const markers = getMajorVersionMarkers({
      major: '9.7',
      newestMajor: '9.7',
      defaultMajor: '8.4',
    })
    assert(markers.isNewest === true, 'newest line should be marked latest')
    assert(markers.isDefault === false, 'newest line is not the default here')
  })

  it('labels the configured default when it differs from the newest', () => {
    const markers = getMajorVersionMarkers({
      major: '8.4',
      newestMajor: '9.7',
      defaultMajor: '8.4',
    })
    assert(markers.isNewest === false, 'default line is not the newest here')
    assert(markers.isDefault === true, 'default line should be marked default')
  })

  it('does not double-label when the default is the newest', () => {
    const markers = getMajorVersionMarkers({
      major: '18',
      newestMajor: '18',
      defaultMajor: '18',
    })
    assert(markers.isNewest === true, 'should keep the latest label')
    assert(
      markers.isDefault === false,
      'latest already says it - no default label',
    )
  })

  it('labels neither for an ordinary older line', () => {
    const markers = getMajorVersionMarkers({
      major: '16',
      newestMajor: '18',
      defaultMajor: '18',
    })
    assert(markers.isNewest === false, 'older line is not latest')
    assert(markers.isDefault === false, 'older line is not the default')
  })
})

describe('configured defaults feed the picker', () => {
  it('uses the MySQL LTS policy line', () => {
    const configuredDefault = getEngineDefaults('mysql').defaultVersion
    assert(
      configuredDefault === '8.4',
      `MySQL default should be the 8.4 LTS line, got ${configuredDefault}`,
    )
    assert(
      resolveDefaultMajorVersion({
        selectableMajors: ['9.7', '9.6', '8.4'],
        configuredDefault,
      }) === '8.4',
      'the picker should follow the configured MySQL default',
    )
  })

  it('uses the MariaDB LTS policy line even when a newer line exists', () => {
    const configuredDefault = getEngineDefaults('mariadb').defaultVersion
    assert(
      resolveDefaultMajorVersion({
        // Shape of the list once hostdb publishes the 12.3 / 13.0 lines.
        selectableMajors: ['13.0', '12.3', configuredDefault, '11.4'],
        configuredDefault,
      }) === configuredDefault,
      'MariaDB should stay on its configured line, not jump to the newest',
    )
  })
})
