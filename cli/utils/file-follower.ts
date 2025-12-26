/**
 * Cross-platform file following utility
 *
 * Replaces Unix `tail -f` with Node.js fs.watch for cross-platform support.
 * Works on Windows, macOS, and Linux.
 */

import { watch, createReadStream } from 'fs'
import { readFile, stat } from 'fs/promises'
import { createInterface } from 'readline'

/**
 * Get the last N lines from a string
 */
export function getLastNLines(content: string, n: number): string {
  const lines = content.split('\n')
  const nonEmptyLines =
    lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  return nonEmptyLines.slice(-n).join('\n')
}

/**
 * Follow a file and stream new content to stdout
 *
 * Uses Node.js fs.watch to monitor file changes and streams new content.
 * Handles SIGINT (Ctrl+C) gracefully and cleans up resources.
 *
 * @param filePath - Path to the file to follow
 * @param initialLines - Number of lines to display initially
 * @returns Promise that resolves when following is stopped (via SIGINT)
 */
export async function followFile(
  filePath: string,
  initialLines: number,
): Promise<void> {
  // Read and display initial content
  const content = await readFile(filePath, 'utf-8')
  const initial = getLastNLines(content, initialLines)
  if (initial) {
    console.log(initial)
  }

  // Track file position
  let fileSize = (await stat(filePath)).size

  return new Promise((resolve) => {
    let settled = false

    // Watch for changes
    const watcher = watch(filePath, async (eventType) => {
      if (eventType === 'change') {
        try {
          const newSize = (await stat(filePath)).size

          if (newSize > fileSize) {
            // Read only the new content
            const stream = createReadStream(filePath, {
              start: fileSize,
              encoding: 'utf-8',
            })

            const rl = createInterface({ input: stream })

            for await (const line of rl) {
              console.log(line)
            }

            fileSize = newSize
          } else if (newSize < fileSize) {
            // File was truncated (log rotation), reset position
            fileSize = newSize
          }
        } catch {
          // File might be temporarily unavailable, ignore
        }
      }
    })

    const cleanup = () => {
      if (!settled) {
        settled = true
        watcher.close()
        process.off('SIGINT', handleSigint)
        resolve()
      }
    }

    const handleSigint = () => {
      cleanup()
    }

    process.on('SIGINT', handleSigint)
  })
}
