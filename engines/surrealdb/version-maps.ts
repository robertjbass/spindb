/**
 * SurrealDB Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
} from 'hostdb'
import { buildVersionMap } from '../version-map-builder'

const ENGINE = 'surrealdb'

export const SURREALDB_VERSION_MAP: Record<string, string> = buildVersionMap(ENGINE)

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const DEFAULT_VERSION = SUPPORTED_MAJOR_VERSIONS[0] ?? '2'

export function normalizeVersion(version: string): string {
  return hostdbResolveVersion(ENGINE, version) ?? version
}

export function isVersionSupported(version: string): boolean {
  return version in SURREALDB_VERSION_MAP
}

export function getLatestPatch(majorVersion: string): string | undefined {
  return SURREALDB_VERSION_MAP[majorVersion]
}
