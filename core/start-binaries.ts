import { isFileBasedEngine, type Engine, type ProgressCallback } from '../types'
import { describeThrown, logDebug } from './error-handler'

/**
 * The slice of BaseEngine the pre-start binary check needs. Kept structural so
 * the check can be unit-tested with a fake engine.
 */
export type StartBinariesEngine = {
  displayName: string
  hasStartableBinaries(version: string): Promise<boolean>
  ensureBinaries(
    version: string,
    onProgress?: ProgressCallback,
  ): Promise<string>
}

export type EnsureStartBinariesResult =
  // File-based engine, no pinned version, or the check itself failed: nothing
  // was downloaded and engine.start() stays the backstop for a missing binary.
  | { kind: 'skipped' }
  | { kind: 'installed' }
  | { kind: 'downloaded' }
  // The caller's confirm callback answered no. Nothing was started.
  | { kind: 'declined'; manualCommand: string }

/** The command a user runs to install the binaries start needs by hand. */
export function startBinariesDownloadCommand(
  engine: Engine,
  version: string,
): string {
  return `spindb engines download ${engine} ${version}`
}

/**
 * Whether start should check for the pinned binaries at all. File-based
 * engines (SQLite, DuckDB) have no server to start, and a container with no
 * usable version ('unknown', or missing) has nothing to download; both fall
 * through to engine.start() exactly as before.
 */
export function needsStartBinariesCheck(
  engine: Engine,
  version: string | undefined,
): version is string {
  return !isFileBasedEngine(engine) && !!version && version !== 'unknown'
}

/**
 * Make sure the binaries a container is pinned to are on disk before
 * engine.start() runs, downloading that EXACT version when they are not.
 *
 * Runs the same way for every server engine. The engine decides what
 * "startable" means through `hasStartableBinaries` (the exact pinned version
 * by default; PostgreSQL also accepts same-major binaries because its start()
 * self-heals onto them), and the download goes through `ensureBinaries` with
 * the pinned version, never a shorthand, so a container pinned to 10.11.16 is
 * never started on an installed 10.11.15.
 *
 * `confirm` is the prompt. Omit it to download without asking (--json,
 * --force, or stdin that is not a TTY): it is the caller's job to never pass
 * a prompt that cannot be answered. A declined prompt returns 'declined' and
 * nothing is downloaded or started. A failed download throws an error that
 * names the version and the manual download command.
 */
export async function ensureStartBinaries(options: {
  engine: StartBinariesEngine
  engineName: Engine
  version: string | undefined
  confirm?: (message: string) => Promise<boolean>
  onDownloadStart?: () => void
  onProgress?: ProgressCallback
}): Promise<EnsureStartBinariesResult> {
  const { engine, engineName, version } = options
  if (!needsStartBinariesCheck(engineName, version)) {
    return { kind: 'skipped' }
  }

  let startable: boolean
  try {
    startable = await engine.hasStartableBinaries(version)
  } catch (error) {
    // Could not even tell (a version hostdb no longer resolves, an unreadable
    // bin dir). Let engine.start() report whatever is actually wrong.
    logDebug(
      `Binary check for ${engineName} ${version} failed: ${describeThrown(error).message}`,
    )
    return { kind: 'skipped' }
  }
  if (startable) {
    return { kind: 'installed' }
  }

  const manualCommand = startBinariesDownloadCommand(engineName, version)

  if (options.confirm) {
    const confirmed = await options.confirm(
      `${engine.displayName} ${version} is not installed. Download now?`,
    )
    if (!confirmed) {
      return { kind: 'declined', manualCommand }
    }
  }

  options.onDownloadStart?.()
  try {
    await engine.ensureBinaries(version, options.onProgress)
  } catch (error) {
    // Same shape as `spindb create` uses for a failed download, so callers that
    // parse it (Layerbase Cloud's exact-version retry, the layerbase TUI's
    // "download it" offer) see one wording for both commands.
    throw new Error(
      `${engine.displayName} ${version} not available: ${describeThrown(error).message}\n` +
        `Download it manually: ${manualCommand}`,
    )
  }
  return { kind: 'downloaded' }
}
