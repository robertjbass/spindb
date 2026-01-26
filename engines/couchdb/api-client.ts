/**
 * Shared CouchDB REST API client utilities
 */

// Default admin credentials for local development
// CouchDB 3.x requires admin account to start
export const DEFAULT_ADMIN_USER = 'admin'
export const DEFAULT_ADMIN_PASSWORD = 'admin'

/**
 * Make an HTTP request to CouchDB REST API
 *
 * @param port - The HTTP port CouchDB is listening on
 * @param method - HTTP method (GET, POST, PUT, DELETE)
 * @param path - API path (e.g., '/', '/_all_dbs', '/mydb')
 * @param body - Optional JSON body for POST/PUT requests
 * @param timeoutMs - Request timeout in milliseconds (default: 30s)
 * @param auth - Optional authentication credentials (defaults to admin:admin)
 */
export async function couchdbApiRequest(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = 30000,
  auth: { username: string; password: string } | null = {
    username: DEFAULT_ADMIN_USER,
    password: DEFAULT_ADMIN_PASSWORD,
  },
): Promise<{ status: number; data: unknown }> {
  const url = `http://127.0.0.1:${port}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  // Add basic auth header if credentials provided
  if (auth) {
    const credentials = Buffer.from(
      `${auth.username}:${auth.password}`,
    ).toString('base64')
    headers['Authorization'] = `Basic ${credentials}`
  }

  const options: RequestInit = {
    method,
    headers,
    signal: controller.signal,
  }

  if (body) {
    options.body = JSON.stringify(body)
  }

  try {
    const response = await fetch(url, options)

    // Try to parse as JSON, CouchDB always returns JSON
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
        `CouchDB API request timed out after ${timeoutMs / 1000}s: ${method} ${path}`,
      )
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}
