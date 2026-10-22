import { getSupportedMajorVersions } from 'hostdb'
import { resolveEngineVersion } from '../../core/version-resolver'
import { buildVersionMap } from '../version-map-builder'

const ENGINE = 'documentdb'
export const DOCUMENTDB_VERSION_MAP = buildVersionMap(ENGINE)
export const SUPPORTED_MAJOR_VERSIONS = getSupportedMajorVersions(ENGINE)

export function normalizeVersion(version: string): string {
  const resolved = resolveEngineVersion(ENGINE, version)
  if (!resolved)
    throw new Error(
      `DocumentDB version ${version} is not available in the installed HostDB catalog`,
    )
  return resolved
}
