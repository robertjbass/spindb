import { mkdir } from 'fs/promises'
import { join } from 'path'

// Server-side file access (LOAD_FILE, SELECT ... INTO OUTFILE/DUMPFILE, LOAD
// DATA INFILE) is confined to this per-container directory. It sits beside the
// data directory, never inside it, so those statements can neither read nor
// overwrite table files, the binaries or anything else the server user owns.
// LOAD DATA LOCAL INFILE reads the file on the CLIENT and is not affected.
export const SECURE_FILE_PRIV_SUBDIR = 'secure-files'

export function getSecureFilePrivDir(containerPath: string): string {
  return join(containerPath, SECURE_FILE_PRIV_SUBDIR)
}

// mysqld and mariadbd refuse to start when the directory is missing, so it is
// created on every start: containers created before this flag existed get it
// on their next start without a migration.
export async function prepareSecureFilePrivArg(
  containerPath: string,
): Promise<string> {
  const dir = getSecureFilePrivDir(containerPath)
  await mkdir(dir, { recursive: true })
  return `--secure-file-priv=${dir}`
}
