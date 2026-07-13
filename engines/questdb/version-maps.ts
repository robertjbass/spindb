/**
 * QuestDB Version Maps
 *
 * Thin wrapper around the `hostdb` npm package. See engines/sqlite/version-maps.ts
 * for the architecture rationale — hostdb is the single source of truth.
 */

import {
  resolveVersion as hostdbResolveVersion,
  getSupportedMajorVersions,
} from 'hostdb'
import { buildVersionMap } from '../version-map-builder'

const ENGINE = 'questdb'

export const QUESTDB_VERSION_MAP: Record<string, string> = buildVersionMap(ENGINE)

export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export const FALLBACK_VERSION_MAP = QUESTDB_VERSION_MAP

export function normalizeVersion(version: string): string {
  return hostdbResolveVersion(ENGINE, version) ?? version
}
