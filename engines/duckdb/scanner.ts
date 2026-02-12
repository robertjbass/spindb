/**
 * DuckDB Scanner — thin wrapper around shared file-based-utils
 */

import { Engine } from '../../types'
import {
  scanForUnregisteredFiles,
  deriveContainerName as sharedDeriveContainerName,
  type UnregisteredFile,
} from '../file-based-utils'

export type { UnregisteredFile }

export async function scanForUnregisteredDuckDBFiles(
  directory?: string,
): Promise<UnregisteredFile[]> {
  return scanForUnregisteredFiles(Engine.DuckDB, directory)
}

export function deriveContainerName(fileName: string): string {
  return sharedDeriveContainerName(fileName, Engine.DuckDB)
}
