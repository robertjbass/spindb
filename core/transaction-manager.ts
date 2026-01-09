/**
 * Transaction Manager
 *
 * Provides rollback support for multi-step operations like container creation.
 * If any step fails, all previously completed steps are rolled back in reverse order.
 */

import { logError, logDebug, ErrorCodes } from './error-handler'

export type RollbackAction = {
  description: string
  execute: () => Promise<void>
}

/**
 * Manages a stack of rollback actions for transactional operations.
 *
 * Usage:
 * ```ts
 * const tx = new TransactionManager()
 *
 * try {
 *   await createDirectory()
 *   tx.addRollback({
 *     description: 'Delete directory',
 *     execute: () => deleteDirectory()
 *   })
 *
 *   await initDatabase()
 *   // Directory rollback covers this too
 *
 *   await startServer()
 *   tx.addRollback({
 *     description: 'Stop server',
 *     execute: () => stopServer()
 *   })
 *
 *   tx.commit() // Success - clear rollback stack
 * } catch (error) {
 *   await tx.rollback() // Error - undo everything
 *   throw error
 * }
 * ```
 */
export class TransactionManager {
  private rollbackStack: RollbackAction[] = []
  private committed = false

  /**
   * Add a rollback action to the stack.
   * Actions are executed in reverse order during rollback.
   */
  addRollback(action: RollbackAction): void {
    if (this.committed) {
      throw new Error('Cannot add rollback action after commit')
    }
    this.rollbackStack.push(action)
    logDebug(`Added rollback action: ${action.description}`, {
      totalActions: this.rollbackStack.length,
    })
  }

  /**
   * Execute all rollbacks in reverse order.
   * Continues even if individual rollback actions fail.
   */
  async rollback(): Promise<void> {
    if (this.committed) {
      logDebug('Skipping rollback - transaction was committed')
      return
    }

    if (this.rollbackStack.length === 0) {
      logDebug('No rollback actions to execute')
      return
    }

    logDebug(`Starting rollback of ${this.rollbackStack.length} actions`)

    // Execute in reverse order (LIFO)
    while (this.rollbackStack.length > 0) {
      const action = this.rollbackStack.pop()!

      try {
        logDebug(`Executing rollback: ${action.description}`)
        await action.execute()
        logDebug(`Rollback successful: ${action.description}`)
      } catch (error) {
        // Log error but continue with other rollbacks
        logError({
          code: ErrorCodes.ROLLBACK_FAILED,
          message: `Failed to rollback: ${action.description}`,
          severity: 'warning',
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        })
      }
    }

    logDebug('Rollback complete')
  }

  /**
   * Mark the transaction as committed.
   * Clears the rollback stack since we don't need to undo anything.
   */
  commit(): void {
    if (this.committed) {
      return // Already committed
    }

    logDebug(`Committing transaction with ${this.rollbackStack.length} actions`)
    this.rollbackStack = []
    this.committed = true
  }

  /**
   * Check if the transaction has been committed.
   */
  isCommitted(): boolean {
    return this.committed
  }

  /**
   * Get the number of pending rollback actions.
   */
  getPendingCount(): number {
    return this.rollbackStack.length
  }
}

/**
 * Helper function to execute an operation with automatic rollback on failure.
 *
 * Usage:
 * ```ts
 * await withTransaction(async (tx) => {
 *   await step1()
 *   tx.addRollback({ description: 'Undo step1', execute: undoStep1 })
 *
 *   await step2()
 *   tx.addRollback({ description: 'Undo step2', execute: undoStep2 })
 *
 *   // If we get here without throwing, transaction commits automatically
 * })
 * ```
 */
export async function withTransaction<T>(
  operation: (tx: TransactionManager) => Promise<T>,
): Promise<T> {
  const tx = new TransactionManager()

  try {
    const result = await operation(tx)
    tx.commit()
    return result
  } catch (error) {
    await tx.rollback()
    throw error
  }
}
