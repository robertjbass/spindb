/**
 * Command-line arguments for sqld (libsql-server).
 *
 * Checkpointing is time-based on purpose. With the default frame-count
 * auto-checkpoint, every committing connection runs a PASSIVE checkpoint once
 * the WAL passes 1000 pages. In sqld 0.24.32 a writer that is already queued
 * for the write lock and wakes while such a checkpoint holds the lock returns
 * SQLITE_BUSY without leaving the queue (connection_manager.rs `acquire()`).
 * The scheduler later hands the lock to that departed writer and nothing ever
 * takes it back, so every later write and checkpoint waits forever while
 * reads keep working. A burst of concurrent writes triggers it.
 *
 * `--checkpoint-interval-s` makes sqld set SQLite's auto-checkpoint to 0 and
 * checkpoint from a timer instead, always in TRUNCATE mode. That path removes
 * every queued writer from the queue before it checkpoints, so no stale entry
 * can be scheduled afterwards. Clients cannot start a checkpoint of their own:
 * sqld rejects `PRAGMA wal_checkpoint` and `PRAGMA wal_autocheckpoint = N`.
 */
export const SQLD_CHECKPOINT_INTERVAL_SECONDS = 60

export function buildSqldArgs(options: {
  bindAddress: string
  port: number
  dbPath: string
  jwtKeyPath?: string
}): string[] {
  const args = [
    '--http-listen-addr',
    `${options.bindAddress}:${options.port}`,
    '--db-path',
    options.dbPath,
    '--checkpoint-interval-s',
    String(SQLD_CHECKPOINT_INTERVAL_SECONDS),
  ]
  if (options.jwtKeyPath) {
    args.push('--auth-jwt-key-file', options.jwtKeyPath)
  }
  return args
}
