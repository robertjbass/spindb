/**
 * hostdb Releases Module for Valkey
 *
 * Fetches Valkey binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { VALKEY_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { valkeyBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.Valkey,
  displayName: 'Valkey',
  versionMap: VALKEY_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => valkeyBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
