/**
 * Copy-on-write directory cloning.
 *
 * Branching a container means duplicating its on-disk data directory. A plain
 * byte copy costs O(data size) in both time and space; a filesystem
 * reflink/clonefile is effectively O(1) and shares blocks with the source until
 * one side is written. We use the OS's CoW primitive when the underlying
 * filesystem supports it (APFS on macOS; Btrfs / XFS-with-reflink / ZFS on
 * Linux) and fall back to a full recursive copy everywhere else (ext4, NTFS).
 *
 * Callers get back which path was taken (`method`) so they can surface it — for
 * example, `spindb branch --json` reports `"method": "reflink"` vs `"copy"` so
 * consumers know whether the branch was instant or a full copy.
 */

import { cp, rm, writeFile, lstat } from 'fs/promises'
import { join } from 'path'
import { spawnAsync } from './spawn-utils'
import { logDebug } from './error-handler'

export type CopyMethod = 'reflink' | 'copy'

export type CloneResult = {
  /** 'reflink' when the OS copy-on-write primitive was used, 'copy' for a full byte copy. */
  method: CopyMethod
  durationMs: number
}

/**
 * Clone a directory (or file) from `src` to `dst`, preferring a copy-on-write
 * reflink and falling back to a deep byte copy when the filesystem can't do it.
 *
 * `dst` must not already exist (matching `containerManager.clone()` semantics,
 * where the target path is a fresh container directory).
 *
 * @param options.platform - override the detected platform (unit tests only)
 */
export async function cloneDirectory(
  src: string,
  dst: string,
  options?: { platform?: NodeJS.Platform },
): Promise<CloneResult> {
  const platform = options?.platform ?? process.platform
  const started = Date.now()
  const method = await cloneWithStrategy(src, dst, platform)
  return { method, durationMs: Date.now() - started }
}

async function cloneWithStrategy(
  src: string,
  dst: string,
  platform: NodeJS.Platform,
): Promise<CopyMethod> {
  if (platform === 'darwin') {
    // `cp -c` requests clonefile() (APFS copy-on-write); `-R` recurses into
    // directories. Fails if the volume isn't APFS or clonefile is unavailable.
    try {
      await spawnAsync('cp', ['-cR', src, dst])
      return 'reflink'
    } catch (error) {
      return fallbackToDeepCopy(src, dst, error)
    }
  }

  if (platform === 'linux') {
    // ZFS block cloning (and some other reflink filesystems) refuse to clone a
    // source whose blocks aren't on disk yet: `cp --reflink=always` then fails
    // with EAGAIN and we'd silently fall back to a full copy. Flush the source's
    // filesystem first so the reflink can proceed. Best-effort — if `sync -f`
    // isn't available the clone still tries, and the copy fallback still works.
    try {
      await spawnAsync('sync', ['-f', src])
    } catch {
      // sync unavailable/failed — proceed; worst case is a fallback full copy.
    }
    // `--reflink=always` errors out on filesystems without reflink support
    // (e.g. ext4), so a failure here cleanly means "no CoW on this volume".
    // We deliberately avoid `--reflink=auto` because it silently falls back to
    // a full copy, which would make us report 'reflink' when nothing was shared.
    try {
      await spawnAsync('cp', ['-R', '--reflink=always', src, dst])
      return 'reflink'
    } catch (error) {
      return fallbackToDeepCopy(src, dst, error)
    }
  }

  // Windows (NTFS has no reflink) and any unknown platform: full copy.
  await deepCopy(src, dst)
  return 'copy'
}

/**
 * A failed reflink may have left a partial destination behind. Remove it, then
 * perform a guaranteed full copy.
 */
async function fallbackToDeepCopy(
  src: string,
  dst: string,
  error: unknown,
): Promise<CopyMethod> {
  logDebug(
    `Copy-on-write clone of "${dst}" unavailable, falling back to full copy: ${
      (error as Error).message
    }`,
  )
  // A failed reflink may have left a partial destination behind. Remove it
  // before the full copy; if cleanup itself fails, surface that error rather
  // than copy into a dirty target. (force:true already ignores a missing dst.)
  await rm(dst, { recursive: true, force: true })
  await deepCopy(src, dst)
  return 'copy'
}

async function deepCopy(src: string, dst: string): Promise<void> {
  await cp(src, dst, {
    recursive: true,
    // Node's fs.cp throws ERR_FS_CP_SOCKET on socket/FIFO entries — e.g. a
    // running PgBouncer's `.s.PGSQL` unix socket that lives inside a Postgres
    // data dir — which fails the whole branch on a full (non-reflink) copy.
    // These are ephemeral runtime artifacts the branch's own processes recreate
    // on start, so skip any non-regular, non-directory, non-symlink entry.
    filter: async (source) => {
      try {
        const st = await lstat(source)
        return st.isFile() || st.isDirectory() || st.isSymbolicLink()
      } catch {
        // Can't stat it (e.g. it vanished mid-copy) — don't try to copy it.
        return false
      }
    },
  })
}

/**
 * Probe whether the filesystem backing `probeDir` supports copy-on-write
 * cloning, by reflinking a tiny throwaway file. Used for upfront UX hints
 * (e.g. warning before a large branch will be a full copy). The authoritative
 * answer for any given clone is the `method` returned by `cloneDirectory()`.
 */
export async function detectCowSupport(probeDir: string): Promise<boolean> {
  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'linux') {
    return false
  }

  const probeSource = join(probeDir, `.spindb-cow-probe-${process.pid}-a`)
  const probeTarget = join(probeDir, `.spindb-cow-probe-${process.pid}-b`)
  try {
    await writeFile(probeSource, 'spindb')
    const args =
      platform === 'darwin'
        ? ['-c', probeSource, probeTarget]
        : ['--reflink=always', probeSource, probeTarget]
    await spawnAsync('cp', args)
    return true
  } catch {
    return false
  } finally {
    await rm(probeSource, { force: true }).catch(() => {})
    await rm(probeTarget, { force: true }).catch(() => {})
  }
}
