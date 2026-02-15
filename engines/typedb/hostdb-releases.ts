/**
 * hostdb Releases Module for TypeDB
 *
 * Fetches TypeDB binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { TYPEDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { typedbBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.TypeDB,
  displayName: 'TypeDB',
  versionMap: TYPEDB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => typedbBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
