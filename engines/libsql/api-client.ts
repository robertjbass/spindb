/**
 * Shared libSQL (sqld) REST API client utilities
 *
 * Uses the Hrana over HTTP protocol for SQL queries.
 * See: https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_3_SPEC.md
 */

type HranaValue =
  | { type: 'null'; value?: undefined }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string }

type HranaResult = {
  cols: { name: string; decltype: string | null }[]
  rows: HranaValue[][]
  affected_row_count: number
  last_insert_rowid: string | null
}

type HranaPipelineResponse = {
  results: Array<{
    type: 'ok' | 'error'
    response?: { type: string; result?: HranaResult }
    error?: { message: string; code?: string }
  }>
  baton: string | null
}

/**
 * Execute a SQL statement via the Hrana HTTP protocol
 *
 * @param port - The HTTP port sqld is listening on
 * @param sql - SQL statement to execute
 * @param options - Optional settings: timeoutMs (default: 30s), authToken (JWT Bearer token)
 */
export async function libsqlQuery(
  port: number,
  sql: string,
  options?: { timeoutMs?: number; authToken?: string },
): Promise<HranaResult> {
  const timeoutMs = options?.timeoutMs ?? 30000
  const url = `http://127.0.0.1:${port}/v2/pipeline`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const body = {
    requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }],
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (options?.authToken) {
    headers['Authorization'] = `Bearer ${options.authToken}`
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`libSQL API request failed (${response.status}): ${text}`)
    }

    const data = (await response.json()) as HranaPipelineResponse

    // Check for error in the pipeline response
    const firstResult = data.results[0]
    if (firstResult?.type === 'error') {
      throw new Error(
        `libSQL query error: ${firstResult.error?.message ?? 'Unknown error'}`,
      )
    }

    const result = firstResult?.response?.result
    if (!result) {
      // For statements like INSERT/UPDATE that don't return rows
      return {
        cols: [],
        rows: [],
        affected_row_count: 0,
        last_insert_rowid: null,
      }
    }

    return result
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`libSQL API request timed out after ${timeoutMs / 1000}s`)
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Make a generic HTTP request to the sqld server
 *
 * @param port - The HTTP port sqld is listening on
 * @param method - HTTP method
 * @param path - URL path
 * @param timeoutMs - Request timeout in milliseconds (default: 30s)
 * @param authToken - Optional JWT Bearer token for authentication
 */
export async function libsqlApiRequest(
  port: number,
  method: string,
  path: string,
  timeoutMs = 30000,
  authToken?: string,
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {}
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
    })

    let data: unknown
    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      data = await response.json()
    } else {
      data = await response.text()
    }

    return { status: response.status, data }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `libSQL API request timed out after ${timeoutMs / 1000}s: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Convert Hrana value to a JavaScript-friendly value
 */
export function hranaValueToJs(val: HranaValue): unknown {
  switch (val.type) {
    case 'null':
      return null
    case 'integer': {
      const n = BigInt(val.value)
      return n > BigInt(Number.MAX_SAFE_INTEGER) ||
        n < BigInt(-Number.MAX_SAFE_INTEGER)
        ? n
        : Number(val.value)
    }
    case 'float':
      return val.value
    case 'text':
      return val.value
    case 'blob':
      return `<blob:${val.base64}>`
    default:
      return String((val as { value?: unknown }).value ?? null)
  }
}
