/**
 * PostgreSQL Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
} from 'hostdb'
import { buildVersionMap } from '../version-map-builder'

const ENGINE = 'postgresql'

export const POSTGRESQL_VERSION_MAP: Record<string, string> = buildVersionMap(ENGINE)

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export function getFullVersion(majorVersion: string): string | null {
  return hostdbResolveVersion(ENGINE, majorVersion)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  console.warn(
    `PostgreSQL version '${version}' not in hostdb, may not be available for download`,
  )
  return version
}
