/**
 * hostdb Releases Module for ClickHouse
 *
 * Fetches ClickHouse binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * ClickHouse uses YY.MM versioning (e.g., 25.12.3.21), so major version is YY.MM.
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import {
  CLICKHOUSE_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
  getMajorVersion,
} from './version-maps'
import { clickhouseBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.ClickHouse,
  displayName: 'ClickHouse',
  versionMap: CLICKHOUSE_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'xy-format',
  listInstalled: () => clickhouseBinaryManager.listInstalled(),
  getMajorVersion,
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
