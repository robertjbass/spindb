import {
  BaseBinaryManager,
  type BinaryManagerConfig,
} from '../../core/base-binary-manager'
import { paths } from '../../config/paths'
import { Engine, type Platform, type Arch } from '../../types'
import { normalizeVersion } from './version-maps'
import { getBinaryUrl } from './binary-urls'
import { verifyDocumentDBBundle } from './native-runtime'

class DocumentDBBinaryManager extends BaseBinaryManager {
  protected readonly config: BinaryManagerConfig = {
    engine: Engine.DocumentDB,
    engineName: 'documentdb',
    displayName: 'DocumentDB',
    serverBinary: 'documentdb_gateway',
  }
  protected getBinaryUrlFromModule(
    version: string,
    platform: Platform,
    arch: Arch,
  ): string {
    return getBinaryUrl(version, platform, arch)
  }
  protected normalizeVersionFromModule(version: string): string {
    return normalizeVersion(version)
  }
  protected parseVersionFromOutput(stdout: string): string | null {
    return stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null
  }
  override async verify(
    version: string,
    platform: Platform,
    arch: Arch,
  ): Promise<boolean> {
    const exactVersion = normalizeVersion(version)
    await verifyDocumentDBBundle(
      paths.getBinaryPath({
        engine: 'documentdb',
        version: exactVersion,
        platform,
        arch,
      }),
      exactVersion,
    )
    return true
  }
}
export const documentdbBinaryManager = new DocumentDBBinaryManager()
