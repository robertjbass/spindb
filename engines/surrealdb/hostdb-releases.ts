/**
 * hostdb Releases Module for SurrealDB
 *
 * Fetches SurrealDB binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { SURREALDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { surrealdbBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.SurrealDB,
  displayName: 'SurrealDB',
  versionMap: SURREALDB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => surrealdbBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
