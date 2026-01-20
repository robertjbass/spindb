/**
 * hostdb Releases Module for DuckDB
 *
 * Fetches DuckDB binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { DUCKDB_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { duckdbBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.DuckDB,
  displayName: 'DuckDB',
  versionMap: DUCKDB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => duckdbBinaryManager.listInstalled(),
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
