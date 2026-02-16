/**
 * hostdb Releases Module for Weaviate
 *
 * Fetches Weaviate binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { WEAVIATE_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { weaviateBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.Weaviate,
  displayName: 'Weaviate',
  versionMap: WEAVIATE_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => weaviateBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
