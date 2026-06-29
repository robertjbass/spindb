import { Engine } from '../types'

/**
 * Translate a memory budget (MB) into engine-specific server args that shrink
 * the engine's fixed RAM footprint. This is the engine-agnostic seam: every
 * engine maps the same budget its own way, and an engine with no mapping (or no
 * budget) returns [] so it just runs at its defaults.
 *
 * Set via `spindb create --memory-budget-mb <n>` and persisted on the container
 * (ContainerConfig.memoryBudgetMb), so it is re-applied on every start/wake.
 *
 * Measured 2026-06-29: a default MySQL is ~547 MB RSS vs MariaDB ~169 MB for the
 * same role, both on InnoDB - the difference is almost entirely
 * performance_schema (MySQL ships it ON, MariaDB OFF). So performance_schema is
 * the dominant lever for MySQL; the InnoDB buffer pool (128 MB default on both)
 * is secondary.
 *
 * @param engine    the container's engine
 * @param budgetMb  soft target for the engine's fixed structures, in MB.
 *                  Undefined or <= 0 means "no budget" (engine defaults).
 */
export function memoryBudgetArgs(
  engine: Engine,
  budgetMb: number | undefined,
): string[] {
  if (!budgetMb || budgetMb <= 0) return []

  // Buffer-pool / cache sizing scaled from the budget, floored so the engine
  // stays healthy (InnoDB dislikes a sub-64 MB pool).
  const cacheMb = Math.max(64, Math.floor(budgetMb / 4))

  switch (engine) {
    case Engine.MySQL:
      // performance_schema is the big consumer (~200-400 MB, auto-sized for
      // max_connections); turning it off is most of the win. The buffer pool is
      // scaled down from its 128 MB default. max_connections is left alone (a
      // pooler caps real clients; mysqld needs backend headroom).
      return [
        '--performance-schema=OFF',
        `--innodb-buffer-pool-size=${cacheMb}M`,
      ]
    case Engine.MariaDB:
      // MariaDB already ships performance_schema OFF, so it is lean by default.
      // Trim the InnoDB buffer pool and the Aria pagecache (both 128 MB by
      // default) for a marginal additional reduction.
      return [
        `--innodb-buffer-pool-size=${cacheMb}M`,
        `--aria-pagecache-buffer-size=${cacheMb}M`,
      ]
    default:
      // No translation for this engine yet -> run at engine defaults.
      return []
  }
}
