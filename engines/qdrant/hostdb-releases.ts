/**
 * hostdb Releases Module for Qdrant
 *
 * Fetches Qdrant binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { QDRANT_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { qdrantBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.Qdrant,
  displayName: 'Qdrant',
  versionMap: QDRANT_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => qdrantBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
