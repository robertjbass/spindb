/**
 * hostdb Releases Module for PostgreSQL
 *
 * Fetches PostgreSQL binary information from the hostdb repository at
 * https://github.com/robertjbass/hostdb
 */

import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import {
  POSTGRESQL_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
  isCronBuildRevision,
} from './version-maps'
import { postgresqlBinaryManager } from './binary-manager'
import { Engine } from '../../types'

const hostdbReleases = createHostdbReleases({
  engine: Engine.PostgreSQL,
  displayName: 'PostgreSQL',
  versionMap: POSTGRESQL_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => postgresqlBinaryManager.listInstalled(),
})

/**
 * Available PostgreSQL versions grouped by major. Legacy pg_cron build
 * revisions (`18.6.0-cron.1`, hostdb 0.44.0) are never offered: pg_cron ships
 * inside the standard builds now. A database already pinned to one keeps
 * starting from it; see isCronBuildRevision.
 */
export async function fetchAvailableVersions(): Promise<
  Record<string, string[]>
> {
  const grouped = await hostdbReleases.fetchAvailableVersions()
  const result: Record<string, string[]> = {}
  for (const [major, versions] of Object.entries(grouped)) {
    const offered = versions.filter((version) => !isCronBuildRevision(version))
    if (offered.length > 0) result[major] = offered
  }
  return result
}

export const getLatestVersion = hostdbReleases.getLatestVersion
