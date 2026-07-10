/**
 * FerretDB Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 *
 * FerretDB has two engines in hostdb: 'ferretdb' (the proxy) and
 * 'postgresql-documentdb' (the v2 backend). Both are looked up here.
 *
 * v1.x uses plain PostgreSQL as backend (all platforms incl. Windows)
 * v2.x uses postgresql-documentdb as backend (macOS/Linux only)
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
  listVersions,
} from 'hostdb'
import { logDebug } from '../../core/error-handler'

const ENGINE = 'ferretdb'
const DOCUMENTDB_ENGINE = 'postgresql-documentdb'

function buildVersionMap(engine: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const major of getSupportedMajorVersions(engine)) {
    const r = hostdbResolveVersion(engine, major)
    if (r) map[major] = r
  }
  for (const minor of listVersions(engine, { format: 'major-minor' })) {
    const r = hostdbResolveVersion(engine, minor)
    if (r) map[minor] = r
  }
  for (const full of listVersions(engine, { format: 'full' })) {
    map[full] = full
  }
  return map
}

export const FERRETDB_VERSION_MAP: Record<string, string> =
  buildVersionMap(ENGINE)

export const DOCUMENTDB_VERSION_MAP: Record<string, string> =
  buildVersionMap(DOCUMENTDB_ENGINE)

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const DEFAULT_DOCUMENTDB_VERSION =
  hostdbResolveVersion(DOCUMENTDB_ENGINE, '17') ?? '17-0.107.0'

export const DEFAULT_V1_POSTGRESQL_VERSION = '17'

export const FALLBACK_VERSION_MAP: Record<string, string> = {
  ...FERRETDB_VERSION_MAP,
}

export function isV1(version: string): boolean {
  const normalized = normalizeVersion(version)
  return normalized.startsWith('1.')
}

export function getFullVersion(version: string): string | null {
  return hostdbResolveVersion(ENGINE, version)
}

export function normalizeVersion(version: string): string {
  const resolved = hostdbResolveVersion(ENGINE, version)
  if (resolved) return resolved
  logDebug(
    `FerretDB version '${version}' not in hostdb, may not be available for download`,
  )
  return version
}

export function normalizeDocumentDBVersion(version: string): string {
  return hostdbResolveVersion(DOCUMENTDB_ENGINE, version) ?? version
}
