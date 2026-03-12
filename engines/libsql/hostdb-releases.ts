/**
 * hostdb Releases Module for libSQL
 *
 * Fetches libSQL binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { LIBSQL_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { libsqlBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.LibSQL,
  displayName: 'libSQL',
  versionMap: LIBSQL_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'xy-format',
  listInstalled: () => libsqlBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
