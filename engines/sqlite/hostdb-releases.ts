/**
 * hostdb Releases Module for SQLite
 *
 * Fetches SQLite binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { SQLITE_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { sqliteBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.SQLite,
  displayName: 'SQLite',
  versionMap: SQLITE_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => sqliteBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
