import { describe, it } from 'node:test'
import { selectInstalledVersion } from '../../core/mysql-family-binary-resolver'
import { assertEqual, assertNullish } from '../utils/assertions'

describe('selectInstalledVersion', () => {
  it('prefers the exact version asked for', () => {
    // The bug this exists for: a MySQL 9.7.2 container took its remote dump
    // through mysql-9.6.0/bin/mysqldump, because the globally registered
    // binary path has no version dimension and 9.6.0 was registered first.
    assertEqual(
      selectInstalledVersion({
        installed: ['8.4.3', '8.4.9', '9.5.0', '9.6.0', '9.7.2'],
        preferVersion: '9.7.2',
      }),
      '9.7.2',
      'the container version wins when it is installed',
    )
  })

  it('takes the newest install on the requested version line', () => {
    assertEqual(
      selectInstalledVersion({
        installed: ['11.8.5', '11.8.8', '10.11.15'],
        preferVersion: '11.8',
      }),
      '11.8.8',
      'newest patch of the requested line',
    )
    assertEqual(
      selectInstalledVersion({
        installed: ['8.4.3', '8.4.9', '9.7.2'],
        preferVersion: '8',
      }),
      '8.4.9',
      'a bare major resolves to its newest install',
    )
  })

  it('matches on version segments, never as a substring', () => {
    // '9.6' must not match '9.60.x', which is the trap a startsWith check
    // falls into. Both lines are installed and 9.60.1 is the newer one, so
    // only picking the OLDER 9.6.0 proves the match is on segment boundaries:
    // a substring match would return 9.60.1, which is also what the
    // newest-install fallback returns, so a same-line-only fixture proves
    // nothing.
    assertEqual(
      selectInstalledVersion({
        installed: ['9.6.0', '9.60.1'],
        preferVersion: '9.6',
      }),
      '9.6.0',
      'the requested line beats a newer install that only shares a prefix',
    )
    assertEqual(
      selectInstalledVersion({
        installed: ['9.6.0', '9.60.1', '10.1.0'],
        preferVersion: '9.6',
      }),
      '9.6.0',
      'a strictly newer version outside the line does not win either',
    )
    assertEqual(
      selectInstalledVersion({
        installed: ['11.80.1', '10.11.15'],
        preferVersion: '11.8',
      }),
      '11.80.1',
      'no line matches, so the newest install is used instead',
    )
  })

  it('falls back to the newest installed version', () => {
    assertEqual(
      selectInstalledVersion({
        installed: ['8.4.3', '9.7.2', '9.6.0'],
        preferVersion: '10.5',
      }),
      '9.7.2',
      'nothing on that line, so newest wins',
    )
    assertEqual(
      selectInstalledVersion({ installed: ['8.4.3', '9.7.2', '9.6.0'] }),
      '9.7.2',
      'no preference at all, so newest wins',
    )
  })

  it('does not depend on the order it is handed', () => {
    // paths.findInstalledBinaries sorts newest-first, but a directory scan
    // hands back alphabetical order, which puts 8.4.3 before 9.7.2.
    assertEqual(
      selectInstalledVersion({ installed: ['9.6.0', '8.4.3', '9.7.2'] }),
      '9.7.2',
      'ordering is resolved here, not by the caller',
    )
  })

  it('sorts a prerelease below its release', () => {
    assertEqual(
      selectInstalledVersion({ installed: ['9.7.2', '9.8.0-rc1'] }),
      '9.8.0-rc1',
      'a newer prerelease is still newer than an older release',
    )
    assertEqual(
      selectInstalledVersion({ installed: ['9.7.2', '9.7.2-rc1'] }),
      '9.7.2',
      'the release beats its own prerelease',
    )
  })

  it('returns null when nothing is installed', () => {
    assertNullish(
      selectInstalledVersion({ installed: [], preferVersion: '9.7.2' }),
      'no install means the caller has to download',
    )
  })
})
