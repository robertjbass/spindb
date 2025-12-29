import { describe, it } from 'node:test'
import {
  TransactionManager,
  withTransaction,
} from '../../core/transaction-manager'
import { assert, assertEqual } from '../integration/helpers'

describe('TransactionManager', () => {
  describe('addRollback', () => {
    it('should add rollback actions to the stack', () => {
      const tx = new TransactionManager()

      tx.addRollback({
        description: 'Action 1',
        execute: async () => {},
      })
      tx.addRollback({
        description: 'Action 2',
        execute: async () => {},
      })

      assertEqual(tx.getPendingCount(), 2, 'Should have 2 pending actions')
    })

    it('should throw if adding rollback after commit', () => {
      const tx = new TransactionManager()
      tx.commit()

      let threw = false
      try {
        tx.addRollback({
          description: 'Should fail',
          execute: async () => {},
        })
      } catch (error) {
        threw = true
        assert(
          (error as Error).message.includes('after commit'),
          'Error message should mention commit',
        )
      }

      assert(threw, 'Should have thrown an error')
    })
  })

  describe('rollback', () => {
    it('should execute rollback actions in reverse order', async () => {
      const tx = new TransactionManager()
      const executionOrder: number[] = []

      tx.addRollback({
        description: 'First added',
        execute: async () => {
          executionOrder.push(1)
        },
      })
      tx.addRollback({
        description: 'Second added',
        execute: async () => {
          executionOrder.push(2)
        },
      })
      tx.addRollback({
        description: 'Third added',
        execute: async () => {
          executionOrder.push(3)
        },
      })

      await tx.rollback()

      assertEqual(executionOrder.length, 3, 'All actions should execute')
      assertEqual(
        executionOrder[0],
        3,
        'Third added should execute first (LIFO)',
      )
      assertEqual(executionOrder[1], 2, 'Second added should execute second')
      assertEqual(executionOrder[2], 1, 'First added should execute last')
    })

    it('should continue rollback even if one action fails', async () => {
      const tx = new TransactionManager()
      const executionOrder: string[] = []

      tx.addRollback({
        description: 'Will succeed',
        execute: async () => {
          executionOrder.push('success1')
        },
      })
      tx.addRollback({
        description: 'Will fail',
        execute: async () => {
          executionOrder.push('fail')
          throw new Error('Rollback failed')
        },
      })
      tx.addRollback({
        description: 'Will also succeed',
        execute: async () => {
          executionOrder.push('success2')
        },
      })

      // Should not throw
      await tx.rollback()

      assertEqual(
        executionOrder.length,
        3,
        'All actions should attempt to execute',
      )
      assert(
        executionOrder.includes('fail'),
        'Failed action should have been attempted',
      )
      assert(
        executionOrder.includes('success1'),
        'Success actions should execute',
      )
      assert(
        executionOrder.includes('success2'),
        'Success actions should execute',
      )
    })

    it('should clear the stack after rollback', async () => {
      const tx = new TransactionManager()

      tx.addRollback({
        description: 'Action',
        execute: async () => {},
      })

      await tx.rollback()

      assertEqual(
        tx.getPendingCount(),
        0,
        'Stack should be empty after rollback',
      )
    })

    it('should do nothing if stack is empty', async () => {
      const tx = new TransactionManager()

      // Should not throw
      await tx.rollback()

      assertEqual(tx.getPendingCount(), 0, 'Stack should remain empty')
    })

    it('should skip rollback if already committed', async () => {
      const tx = new TransactionManager()
      let executed = false

      tx.addRollback({
        description: 'Should not execute',
        execute: async () => {
          executed = true
        },
      })

      tx.commit()
      await tx.rollback()

      assert(!executed, 'Rollback should not execute after commit')
    })
  })

  describe('commit', () => {
    it('should clear the rollback stack', () => {
      const tx = new TransactionManager()

      tx.addRollback({
        description: 'Action 1',
        execute: async () => {},
      })
      tx.addRollback({
        description: 'Action 2',
        execute: async () => {},
      })

      tx.commit()

      assertEqual(tx.getPendingCount(), 0, 'Stack should be empty after commit')
      assert(tx.isCommitted(), 'Should be marked as committed')
    })

    it('should be idempotent', () => {
      const tx = new TransactionManager()

      tx.addRollback({
        description: 'Action',
        execute: async () => {},
      })

      tx.commit()
      tx.commit() // Should not throw

      assert(tx.isCommitted(), 'Should remain committed')
    })
  })

  describe('isCommitted', () => {
    it('should return false before commit', () => {
      const tx = new TransactionManager()

      assert(!tx.isCommitted(), 'Should not be committed initially')

      tx.addRollback({
        description: 'Action',
        execute: async () => {},
      })

      assert(!tx.isCommitted(), 'Should not be committed after adding rollback')
    })

    it('should return true after commit', () => {
      const tx = new TransactionManager()
      tx.commit()

      assert(tx.isCommitted(), 'Should be committed after commit()')
    })
  })

  describe('getPendingCount', () => {
    it('should return correct count', () => {
      const tx = new TransactionManager()

      assertEqual(tx.getPendingCount(), 0, 'Should start at 0')

      tx.addRollback({
        description: 'Action 1',
        execute: async () => {},
      })
      assertEqual(tx.getPendingCount(), 1, 'Should be 1 after adding one')

      tx.addRollback({
        description: 'Action 2',
        execute: async () => {},
      })
      assertEqual(tx.getPendingCount(), 2, 'Should be 2 after adding two')
    })
  })
})

describe('withTransaction', () => {
  it('should commit on successful operation', async () => {
    let rollbackExecuted = false

    const result = await withTransaction(async (tx) => {
      tx.addRollback({
        description: 'Should not execute',
        execute: async () => {
          rollbackExecuted = true
        },
      })

      return 'success'
    })

    assertEqual(result, 'success', 'Should return operation result')
    assert(!rollbackExecuted, 'Rollback should not execute on success')
  })

  it('should rollback and rethrow on failure', async () => {
    let rollbackExecuted = false

    let threw = false
    try {
      await withTransaction(async (tx) => {
        tx.addRollback({
          description: 'Should execute',
          execute: async () => {
            rollbackExecuted = true
          },
        })

        throw new Error('Operation failed')
      })
    } catch (error) {
      threw = true
      assertEqual(
        (error as Error).message,
        'Operation failed',
        'Should rethrow original error',
      )
    }

    assert(threw, 'Should have thrown')
    assert(rollbackExecuted, 'Rollback should have executed')
  })

  it('should execute rollbacks in reverse order on failure', async () => {
    const executionOrder: number[] = []

    try {
      await withTransaction(async (tx) => {
        tx.addRollback({
          description: 'First',
          execute: async () => {
            executionOrder.push(1)
          },
        })
        tx.addRollback({
          description: 'Second',
          execute: async () => {
            executionOrder.push(2)
          },
        })
        tx.addRollback({
          description: 'Third',
          execute: async () => {
            executionOrder.push(3)
          },
        })

        throw new Error('Failure')
      })
    } catch {
      // Expected
    }

    assertEqual(executionOrder[0], 3, 'Should execute in reverse order')
    assertEqual(executionOrder[1], 2, 'Should execute in reverse order')
    assertEqual(executionOrder[2], 1, 'Should execute in reverse order')
  })
})
