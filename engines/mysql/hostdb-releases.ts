/**
 * hostdb Releases Module for MySQL
 *
 * Fetches MySQL binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 *
 * MySQL uses conditional version grouping: X.Y if X.Y is a supported major version,
 * otherwise falls back to X (e.g., 8.0.40 groups to "8.0", but 9.5.0 groups to "9.5").
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { MYSQL_VERSION_MAP, SUPPORTED_MAJOR_VERSIONS } from './version-maps'
import { mysqlBinaryManager } from './binary-manager'
import { Engine } from '../../types'

/**
 * MySQL uses conditional X.Y vs X grouping based on SUPPORTED_MAJOR_VERSIONS.
 * If X.Y is in SUPPORTED_MAJOR_VERSIONS, use X.Y; otherwise use X.
 */
function getMajorVersion(version: string): string {
  const parts = version.split('.')
  const majorXY = parts.length >= 2 ? `${parts[0]}.${parts[1]}` : parts[0]
  const majorX = parts[0]
  return SUPPORTED_MAJOR_VERSIONS.includes(majorXY) ? majorXY : majorX
}

// When getMajorVersion is provided, groupingStrategy only affects fallback version
// synthesis in getLatestVersion (e.g., 'xy-format' produces `${major}.0` as fallback).
// The actual version grouping uses getMajorVersion, not groupingStrategy.
const hostdbReleases = createHostdbReleases({
  engine: Engine.MySQL,
  displayName: 'MySQL',
  versionMap: MYSQL_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'xy-format',
  listInstalled: () => mysqlBinaryManager.listInstalled(),
  getMajorVersion,
})

export const fetchAvailableVersions = hostdbReleases.fetchAvailableVersions
export const getLatestVersion = hostdbReleases.getLatestVersion
