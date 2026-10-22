import { createHostdbReleases } from '../../core/hostdb-releases-factory'
import { Engine } from '../../types'
import {
  DOCUMENTDB_VERSION_MAP,
  SUPPORTED_MAJOR_VERSIONS,
} from './version-maps'
import { documentdbBinaryManager } from './binary-manager'

const releases = createHostdbReleases({
  engine: Engine.DocumentDB,
  displayName: 'DocumentDB',
  versionMap: DOCUMENTDB_VERSION_MAP,
  supportedMajorVersions: SUPPORTED_MAJOR_VERSIONS,
  groupingStrategy: 'single-digit',
  listInstalled: () => documentdbBinaryManager.listInstalled(),
})
export const fetchAvailableVersions = releases.fetchAvailableVersions
export const getLatestVersion = releases.getLatestVersion
