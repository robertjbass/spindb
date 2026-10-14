import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getDatabaseEntry } from 'hostdb'
import {
  assertVersionBuiltForPlatform,
  filterVersionMapForPlatform,
  getVersionPlatformList,
  isVersionBuiltForPlatform,
} from '../../core/version-platforms'
import { buildHostdbUrl } from '../../core/hostdb-client'
import { getBinaryUrl } from '../../engines/postgresql/binary-urls'
import { Arch, Platform } from '../../types'

// PostgreSQL 19 betas list their own platforms without win32-x64 in every
// hostdb snapshot this spindb has pinned, so they exercise the same code path
// as the Linux-only -cron.N revisions without depending on the pin.
const BETA = '19.0.0-beta.3'

describe('version-level platform support', () => {
  it('reads the version-level list and ignores versions without one', () => {
    assert.ok(getVersionPlatformList('postgresql', BETA)?.includes('linux-x64'))
    assert.equal(getVersionPlatformList('postgresql', '18.6.0'), null)
    assert.equal(getVersionPlatformList('postgresql', '0.0.0-nope'), null)
    assert.equal(getVersionPlatformList('no-such-engine', '1.0.0'), null)
  })

  it('treats unlisted platforms as unavailable and everything else as available', () => {
    assert.equal(
      isVersionBuiltForPlatform('postgresql', BETA, 'win32-x64'),
      false,
    )
    assert.equal(
      isVersionBuiltForPlatform('postgresql', BETA, 'darwin-arm64'),
      true,
    )
    assert.equal(
      isVersionBuiltForPlatform('postgresql', '18.6.0', 'win32-x64'),
      true,
    )
    assert.equal(
      isVersionBuiltForPlatform('postgresql', '0.0.0-nope', 'win32-x64'),
      true,
    )
  })

  it('keeps retired platforms downloadable because their artifact exists', () => {
    const entry = getDatabaseEntry('ferretdb')
    const value = entry?.versions['2.7.0']
    if (
      !value ||
      typeof value !== 'object' ||
      !value.retiredPlatforms?.['win32-x64']
    )
      return
    assert.equal(
      isVersionBuiltForPlatform('ferretdb', '2.7.0', 'win32-x64'),
      true,
    )
  })

  it('filters the picker map and hides majors left empty', () => {
    const input = { '18': ['18.6.0', '18.4.0'], '19': [BETA], '20': [] }
    const windows = filterVersionMapForPlatform(
      'postgresql',
      input,
      'win32-x64',
    )
    assert.deepEqual(windows.versions, { '18': ['18.6.0', '18.4.0'], '20': [] })
    assert.deepEqual([...windows.hiddenMajors], ['19'])
    const mac = filterVersionMapForPlatform('postgresql', input, 'darwin-arm64')
    assert.deepEqual(mac.versions, input)
    assert.equal(mac.hiddenMajors.size, 0)
  })

  it('fails early with an actionable message instead of building a 404 URL', () => {
    assert.throws(
      () =>
        assertVersionBuiltForPlatform('postgresql', {
          version: BETA,
          platformKey: 'win32-x64',
        }),
      (error: Error) =>
        /postgresql 19\.0\.0-beta\.3 is not built for win32-x64 \(built for: .*linux-x64/.test(
          error.message,
        ) && /--db-version 19/.test(error.message),
    )
    assert.throws(
      () =>
        buildHostdbUrl('postgresql', {
          version: BETA,
          hostdbPlatform: 'win32-x64',
          extension: 'zip',
        }),
      /is not built for win32-x64/,
    )
    assert.throws(
      () => getBinaryUrl(BETA, Platform.Win32, Arch.X64),
      /is not built for win32-x64/,
    )
    assert.match(
      getBinaryUrl(BETA, Platform.Darwin, Arch.ARM64),
      /postgresql-19\.0\.0-beta\.3-darwin-arm64\.tar\.gz$/,
    )
    assert.match(
      getBinaryUrl('18.6.0', Platform.Win32, Arch.X64),
      /postgresql-18\.6\.0-win32-x64\.zip$/,
    )
  })

  it('hides Linux-only -cron.N revisions on macOS when the bundled hostdb has them', (t) => {
    const cron = '18.6.0-cron.1'
    if (!getDatabaseEntry('postgresql')?.versions[cron]) {
      t.skip('bundled hostdb data predates the -cron.N revisions')
      return
    }
    const { versions } = filterVersionMapForPlatform(
      'postgresql',
      { '18': [cron, '18.6.0'] },
      'darwin-arm64',
    )
    assert.deepEqual(versions, { '18': ['18.6.0'] })
    assert.equal(
      isVersionBuiltForPlatform('postgresql', cron, 'linux-x64'),
      true,
    )
    assert.throws(
      () => getBinaryUrl(cron, Platform.Darwin, Arch.ARM64),
      /18\.6\.0-cron\.1 is not built for darwin-arm64/,
    )
  })
})
