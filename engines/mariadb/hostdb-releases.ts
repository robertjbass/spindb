/**
 * hostdb Releases Module for MariaDB
 *
 * Fetches MariaDB binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { MARIADB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { mariadbBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.MariaDB,
  displayName: 'MariaDB',
  versionMap: MARIADB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'xy-format',
  listInstalled: () => mariadbBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
