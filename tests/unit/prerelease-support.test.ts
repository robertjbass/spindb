/**
 * Prerelease (alpha/beta/rc) support.
 *
 * hostdb ships prerelease binaries (first: PostgreSQL 19.0.0-beta.1) that
 * resolve only by their exact token. These tests lock in the wrapper, metadata,
 * and migration-guard behavior that keeps prereleases opt-in and never GA.
 */

import { describe, it } from 'node:test'
import {
  POSTGRESQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS as PG_MAJORS,
} from '../../engines/postgresql/version-maps'
import { getPrereleaseVersions } from '../../core/hostdb-metadata'
import {
  getMajorVersion,
  isVersionSupported,
  getTargetVersion,
} from '../../core/version-migration'
import { isPrereleaseVersion } from '../../core/version-utils'
import { Engine } from '../../types'
import { assert } from '../utils/assertions'

const PG_BETA = '19.0.0-beta.1'

describe('prerelease wrapper inclusion (PostgreSQL)', () => {
  it('MAP contains the exact beta token so it is creatable', () => {
    assert(
      POSTGRESQL_VERSION_MAP[PG_BETA] === PG_BETA,
      `POSTGRESQL_VERSION_MAP should map ${PG_BETA} to itself`,
    )
  })

  it('SUPPORTED_MAJOR_VERSIONS excludes the prerelease major 19', () => {
    assert(
      !PG_MAJORS.includes('19'),
      "SUPPORTED_MAJOR_VERSIONS should not include '19' (prerelease-only major)",
    )
  })

  it('no bare-major key is created for the prerelease', () => {
    assert(
      POSTGRESQL_VERSION_MAP['19'] === undefined,
      "MAP should not gain a bare '19' key from the prerelease",
    )
  })
})

describe('getPrereleaseVersions (hostdb metadata)', () => {
  it('returns the beta token mapped to its channel', async () => {
    const prereleases = await getPrereleaseVersions('postgresql')
    assert(
      prereleases.get(PG_BETA) === 'beta',
      `expected ${PG_BETA} -> 'beta' in prerelease map`,
    )
  })

  it('returns an empty map for an engine with no prereleases', async () => {
    const prereleases = await getPrereleaseVersions('mysql')
    assert(prereleases.size === 0, 'mysql should have no prereleases')
  })
})

describe('migration guard decision inputs', () => {
  it('a prerelease is detected as such', () => {
    assert(isPrereleaseVersion(PG_BETA) === true, 'beta token is a prerelease')
  })

  it('the prerelease major is not a supported migration major', () => {
    assert(
      getMajorVersion(Engine.PostgreSQL, PG_BETA) === null,
      'beta major 19 is not a supported migration target major',
    )
  })

  it('the prerelease token counts as supported (identity map), so it is not flagged outdated', () => {
    assert(
      isVersionSupported(Engine.PostgreSQL, PG_BETA) === true,
      'beta token should be a supported value in the map',
    )
  })

  it('no GA target exists for the prerelease major', () => {
    assert(
      getTargetVersion(Engine.PostgreSQL, '19') === null,
      "there is no GA target for major '19'",
    )
  })
})
