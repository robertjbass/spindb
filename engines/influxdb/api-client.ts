/**
 * Shared InfluxDB REST API client utilities
 */

/**
 * Make an HTTP request to InfluxDB REST API
 *
 * @param port - The HTTP port InfluxDB is listening on
 * @param method - HTTP method (GET, POST, PUT, DELETE)
 * @param path - API path (e.g., '/health', '/api/v3/query_sql')
 * @param body - Optional JSON body for POST/PUT requests
 * @param timeoutMs - Request timeout in milliseconds (default: 30s)
 */
export async function influxdbApiRequest(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    signal: controller.signal,
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  try {
    const response = await fetch(url, options)

    // Try to parse as JSON, fall back to text for endpoints like /health
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
        `InfluxDB API request timed out after ${timeoutMs / 1000}s: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}
