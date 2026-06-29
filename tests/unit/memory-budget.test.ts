/**
 * Tests for memoryBudgetArgs - the engine-agnostic memory-budget translation
 * that turns a budget (MB) into per-engine server args.
 */

import { describe, it } from 'node:test'
import { Engine } from '../../types'
import { memoryBudgetArgs } from '../../core/memory-budget'
import { assert, assertEqual } from '../utils/assertions'

describe('memoryBudgetArgs', () => {
  it('returns no args when there is no budget', () => {
    assertEqual(
      memoryBudgetArgs(Engine.MySQL, undefined).length,
      0,
      'undefined budget',
    )
    assertEqual(memoryBudgetArgs(Engine.MySQL, 0).length, 0, 'zero budget')
  })

  it('MySQL turns performance_schema off and scales the buffer pool', () => {
    const args = memoryBudgetArgs(Engine.MySQL, 256)
    assert(args.includes('--performance-schema=OFF'), 'perf_schema off')
    assert(
      args.includes('--innodb-buffer-pool-size=64M'),
      'buffer pool 256/4 = 64M',
    )
  })

  it('MySQL floors the buffer pool at 64M for tiny budgets', () => {
    const args = memoryBudgetArgs(Engine.MySQL, 100)
    assert(args.includes('--innodb-buffer-pool-size=64M'), 'floored at 64M')
  })

  it('MariaDB trims buffer pool + aria pagecache, no perf_schema flag', () => {
    const args = memoryBudgetArgs(Engine.MariaDB, 256)
    assert(args.includes('--innodb-buffer-pool-size=64M'), 'buffer pool')
    assert(args.includes('--aria-pagecache-buffer-size=64M'), 'aria pagecache')
    assert(
      !args.some((a) => a.includes('performance-schema')),
      'no perf_schema flag (MariaDB defaults it off)',
    )
  })

  it('untranslated engines run at defaults (no args)', () => {
    assertEqual(
      memoryBudgetArgs(Engine.PostgreSQL, 256).length,
      0,
      'postgres no-op',
    )
    assertEqual(memoryBudgetArgs(Engine.SQLite, 256).length, 0, 'sqlite no-op')
    assertEqual(memoryBudgetArgs(Engine.Redis, 256).length, 0, 'redis no-op')
  })
})
