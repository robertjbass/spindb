/**
 * Shared binary archive download with a stall watchdog.
 *
 * A registry download can stop sending bytes while its socket stays open.
 * Without a watchdog that hangs the command until the overall timeout (or
 * forever, when the timeout only covers the response headers). The watchdog
 * aborts an attempt that receives no bytes for `stallTimeoutMs` and starts
 * the download again from scratch. The overall timeout is one deadline for
 * the whole download, across every attempt and retry delay, and is never
 * retried.
 */

import { createWriteStream } from 'fs'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { fetchWithRegistryFallback } from './hostdb-client'
import type { ProgressCallback } from '../types'

export const ARCHIVE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000
export const ARCHIVE_DOWNLOAD_STALL_TIMEOUT_MS = 30 * 1000
const DEFAULT_RETRY_DELAYS_MS = [0, 1000, 3000]

type AbortCause = 'stalled' | 'timeout'

type DownloadAttempt = {
  signal: AbortSignal
  progress: Transform
  abortCause: () => AbortCause | null
  dispose: () => void
}

function startDownloadAttempt(options: {
  stallTimeoutMs: number
  totalTimeoutMs: number
}): DownloadAttempt {
  const controller = new AbortController()
  let cause: AbortCause | null = null
  function abortWith(nextCause: AbortCause): void {
    if (cause) return
    cause = nextCause
    controller.abort()
  }
  const totalTimer = setTimeout(
    () => abortWith('timeout'),
    options.totalTimeoutMs,
  )
  let stallTimer = setTimeout(
    () => abortWith('stalled'),
    options.stallTimeoutMs,
  )
  function resetStallTimer(): void {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => abortWith('stalled'), options.stallTimeoutMs)
  }
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      resetStallTimer()
      callback(null, chunk)
    },
  })
  return {
    signal: controller.signal,
    progress,
    abortCause: () => cause,
    dispose: () => {
      clearTimeout(totalTimer)
      clearTimeout(stallTimer)
    },
  }
}

function stalledError(options: {
  displayName: string
  stallTimeoutMs: number
  maxAttempts: number
}): Error {
  return new Error(
    `Download of ${options.displayName} binaries stalled (no data for ${options.stallTimeoutMs / 1000}s) on all ${options.maxAttempts} attempts. ` +
      `Check your network connection and try again.`,
  )
}

function timeoutError(totalTimeoutMs: number): Error {
  return new Error(
    `Download timed out after ${totalTimeoutMs / 1000 / 60} minutes. ` +
      `Check your network connection and try again.`,
  )
}

/**
 * Download `url` to `destination`, retrying an attempt that stalls or whose
 * body stream breaks mid-flight. HTTP errors, a missing body and the overall
 * timeout are not retried. A 404 throws the error from `createNotFoundError`.
 */
export async function downloadArchiveToFile(options: {
  url: string
  destination: string
  displayName: string
  createNotFoundError: () => Error
  onProgress?: ProgressCallback
  stallTimeoutMs?: number
  totalTimeoutMs?: number
  retryDelaysMs?: number[]
}): Promise<void> {
  const stallTimeoutMs =
    options.stallTimeoutMs ?? ARCHIVE_DOWNLOAD_STALL_TIMEOUT_MS
  const totalTimeoutMs = options.totalTimeoutMs ?? ARCHIVE_DOWNLOAD_TIMEOUT_MS
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const maxAttempts = retryDelaysMs.length
  const deadline = Date.now() + totalTimeoutMs

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const delay = retryDelaysMs[attempt - 1]
    if (delay >= deadline - Date.now()) throw timeoutError(totalTimeoutMs)
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))

    const download = startDownloadAttempt({
      stallTimeoutMs,
      totalTimeoutMs: deadline - Date.now(),
    })
    try {
      let response: Response
      try {
        // fetchWithRegistryFallback already retries transient connection
        // errors; only a watchdog abort is handled here.
        response = await fetchWithRegistryFallback(options.url, {
          signal: download.signal,
        })
      } catch (error) {
        if (download.abortCause() === 'timeout')
          throw timeoutError(totalTimeoutMs)
        if (download.abortCause() !== 'stalled') throw error
        if (attempt >= maxAttempts)
          throw stalledError({
            displayName: options.displayName,
            stallTimeoutMs,
            maxAttempts,
          })
        options.onProgress?.({
          stage: 'downloading',
          message: `Download stalled, retrying (attempt ${attempt + 1}/${maxAttempts})...`,
        })
        continue
      }

      if (!response.ok) {
        if (response.status === 404) throw options.createNotFoundError()
        throw new Error(
          `Failed to download ${options.displayName} binaries: ${response.status} ${response.statusText}`,
        )
      }
      if (!response.body) {
        throw new Error(
          `Download failed: response has no body (status ${response.status})`,
        )
      }

      try {
        // A fresh write stream truncates any earlier attempt's partial file.
        await pipeline(
          Readable.fromWeb(response.body),
          download.progress,
          createWriteStream(options.destination),
        )
        return
      } catch (error) {
        const cause = download.abortCause()
        if (cause === 'timeout') throw timeoutError(totalTimeoutMs)
        if (attempt >= maxAttempts) {
          if (cause === 'stalled') {
            throw stalledError({
              displayName: options.displayName,
              stallTimeoutMs,
              maxAttempts,
            })
          }
          throw error
        }
        options.onProgress?.({
          stage: 'downloading',
          message:
            cause === 'stalled'
              ? `Download stalled, retrying (attempt ${attempt + 1}/${maxAttempts})...`
              : `Download interrupted, retrying (attempt ${attempt + 1}/${maxAttempts})...`,
        })
      }
    } finally {
      download.dispose()
    }
  }
}
