/**
 * hostdb Releases Module for InfluxDB
 *
 * Fetches InfluxDB binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { INFLUXDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { influxdbBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.InfluxDB,
  displayName: 'InfluxDB',
  versionMap: INFLUXDB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => influxdbBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
