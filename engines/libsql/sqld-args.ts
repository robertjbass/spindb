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
 *
 * Why 60 s: the WAL grows by one interval of writes before it is truncated,
 * and while each checkpoint runs, concurrent writes fail with SQLITE_BUSY.
 * Measured at 128 writers: 10 s gave ~100 MB of WAL and 1.4% failed writes,
 * 60 s gave ~570 MB and 0.2%. Fewer client-visible errors wins; the WAL is
 * truncated to zero every minute.
 */
export const SQLD_CHECKPOINT_INTERVAL_SECONDS = 60

/**
 * Largest single response sqld will send, in bytes of the serialized result.
 *
 * sqld's own default is 10 MB, so a `SELECT` returning more than that failed
 * with "Response is too large". 50 MB matches the per-query result ceiling
 * Cloudflare D1 enforces from 2026-11-04, so a query that works on D1 works
 * here too. sqld parses "MB" as 1,000,000 bytes: measured on 0.24.32, a
 * 49,997,255-byte JSON result passes and a 52 MB one fails.
 */
export const SQLD_MAX_RESPONSE_SIZE = '50MB'

/**
 * Bytes of response that may be in flight at once across ALL of this sqld's
 * connections. sqld's default is about 32 MB, below the per-response limit
 * above, so without raising it a single 50 MB result would still fail.
 *
 * sqld buffers each response in memory. Measured on 0.24.32: one 50 MB
 * response peaks at about 190 MB RSS (baseline 26 MB, so ~3.3x the response),
 * four at once at about 580 MB, eight at about 1.2 GB. 100 MB in flight
 * (two maximum-size responses) peaks near 330 MB, which fits the smallest
 * hosted memory budget (512 MB, Layerbase Cloud Free) with room for SQLite.
 * When the total is exceeded every in-flight response over it fails with the
 * same error rather than queueing, as with sqld's default.
 */
export const SQLD_MAX_TOTAL_RESPONSE_SIZE = '100MB'

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
    '--max-response-size',
    SQLD_MAX_RESPONSE_SIZE,
    '--max-total-response-size',
    SQLD_MAX_TOTAL_RESPONSE_SIZE,
  ]
  if (options.jwtKeyPath) {
    args.push('--auth-jwt-key-file', options.jwtKeyPath)
  }
  return args
}
