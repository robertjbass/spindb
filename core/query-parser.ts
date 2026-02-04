/**
 * Query result parsing utilities
 * Converts various output formats (CSV, JSON, tab-separated) into QueryResult
 */

import type { QueryResult, QueryResultRow } from '../types'

/**
 * Parse CSV output into QueryResult
 * Handles quoted fields and escaped quotes
 */
export function parseCSVToQueryResult(csv: string): QueryResult {
  const lines = csv.trim().split(/\r?\n/)

  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
    return { columns: [], rows: [], rowCount: 0 }
  }

  // Parse header row
  const columns = parseCSVLine(lines[0])

  // Parse data rows
  const rows: QueryResultRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const values = parseCSVLine(line)
    const row: QueryResultRow = {}

    for (let j = 0; j < columns.length; j++) {
      row[columns[j]] = parseValue(values[j])
    }

    rows.push(row)
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
  }
}

/**
 * Parse a single CSV line, handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const nextChar = line[i + 1]

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote
          current += '"'
          i++
        } else {
          // End of quoted field
          inQuotes = false
        }
      } else {
        current += char
      }
    } else {
      if (char === '"') {
        inQuotes = true
      } else if (char === ',') {
        result.push(current)
        current = ''
      } else {
        current += char
      }
    }
  }

  result.push(current)
  return result
}

/**
 * Parse tab-separated output into QueryResult (MySQL, MariaDB with -B flag)
 */
export function parseTSVToQueryResult(tsv: string): QueryResult {
  const lines = tsv.trim().split(/\r?\n/)

  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) {
    return { columns: [], rows: [], rowCount: 0 }
  }

  // Parse header row
  const columns = lines[0].split('\t')

  // Parse data rows
  const rows: QueryResultRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const values = line.split('\t')
    const row: QueryResultRow = {}

    for (let j = 0; j < columns.length; j++) {
      row[columns[j]] = parseValue(values[j])
    }

    rows.push(row)
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
  }
}

/**
 * Parse JSON output into QueryResult (ClickHouse, SurrealDB, MongoDB)
 */
export function parseJSONToQueryResult(json: string): QueryResult {
  const data = JSON.parse(json) as unknown

  // Handle array of objects (most common format)
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { columns: [], rows: [], rowCount: 0 }
    }

    // Extract columns from first row's keys
    const firstRow = data[0] as Record<string, unknown>
    const columns = Object.keys(firstRow)

    const rows: QueryResultRow[] = data.map((item) => item as QueryResultRow)

    return {
      columns,
      rows,
      rowCount: rows.length,
    }
  }

  // Handle single object result
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>
    const columns = Object.keys(obj)
    return {
      columns,
      rows: [obj as QueryResultRow],
      rowCount: 1,
    }
  }

  // Handle scalar result
  return {
    columns: ['result'],
    rows: [{ result: data }],
    rowCount: 1,
  }
}

/**
 * Parse ClickHouse JSON format output
 * ClickHouse returns: { data: [...], meta: [...], rows: N, statistics: {...} }
 */
export function parseClickHouseJSONResult(json: string): QueryResult {
  const result = JSON.parse(json) as {
    data?: unknown[]
    meta?: Array<{ name: string; type: string }>
    rows?: number
    statistics?: { elapsed?: number }
  }

  const columns = result.meta?.map((m) => m.name) || []
  const rows = (result.data || []) as QueryResultRow[]

  return {
    columns,
    rows,
    rowCount: result.rows ?? rows.length,
    executionTimeMs: result.statistics?.elapsed
      ? result.statistics.elapsed * 1000
      : undefined,
  }
}

/**
 * Parse SurrealDB JSON result format
 *
 * SurrealDB v2 with --json returns: [[{...}, {...}]] (double-nested array)
 * Legacy format: [{ result: [...], status: "OK", time: "..." }]
 */
export function parseSurrealDBResult(json: string): QueryResult {
  const parsed = JSON.parse(json) as unknown[]

  // SurrealDB returns an array of statement results
  // For single query, take the first result
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { columns: [], rows: [], rowCount: 0 }
  }

  const firstResult = parsed[0]

  // Determine format: SurrealDB v2 returns [[...]], legacy returns [{result: [...]}]
  let data: unknown[]
  let executionTimeMs: number | undefined

  if (Array.isArray(firstResult)) {
    // SurrealDB v2 format: [[{...}, {...}]]
    data = firstResult
  } else if (
    typeof firstResult === 'object' &&
    firstResult !== null &&
    'result' in firstResult
  ) {
    // Legacy format: [{result: [...], status: "OK", time: "..."}]
    const legacyResult = firstResult as {
      result?: unknown[]
      status?: string
      time?: string
    }
    data = legacyResult.result || []

    // Parse execution time (e.g., "1.234ms" or "1.234µs" or "1.234s")
    if (legacyResult.time) {
      const timeMatch = legacyResult.time.match(/([\d.]+)(µs|ms|s)/)
      if (timeMatch) {
        const value = parseFloat(timeMatch[1])
        const unit = timeMatch[2]
        if (unit === 'µs') executionTimeMs = value / 1000
        else if (unit === 'ms') executionTimeMs = value
        else if (unit === 's') executionTimeMs = value * 1000
      }
    }
  } else {
    return { columns: [], rows: [], rowCount: 0 }
  }

  if (!Array.isArray(data) || data.length === 0) {
    return { columns: [], rows: [], rowCount: 0 }
  }

  const firstRow = data[0] as Record<string, unknown>
  const columns = Object.keys(firstRow)
  const rows = data as QueryResultRow[]

  return {
    columns,
    rows,
    rowCount: rows.length,
    executionTimeMs,
  }
}

/**
 * Parse MongoDB shell output (EJSON format from mongosh --json=relaxed)
 */
export function parseMongoDBResult(json: string): QueryResult {
  const data = JSON.parse(json) as unknown

  // Handle cursor result (array of documents)
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { columns: [], rows: [], rowCount: 0 }
    }

    // MongoDB documents may have different fields per document
    // Collect all unique keys
    const columnSet = new Set<string>()
    for (const doc of data) {
      if (typeof doc === 'object' && doc !== null) {
        for (const key of Object.keys(doc)) {
          columnSet.add(key)
        }
      }
    }
    const columns = Array.from(columnSet)

    const rows = data.map((doc) => {
      if (typeof doc === 'object' && doc !== null) {
        return doc as QueryResultRow
      }
      return { value: doc } as QueryResultRow
    })

    return {
      columns,
      rows,
      rowCount: rows.length,
    }
  }

  // Handle single document or scalar
  return parseJSONToQueryResult(json)
}

/**
 * Parse Redis command output based on command type
 */
export function parseRedisResult(output: string, command: string): QueryResult {
  const trimmed = output.trim()
  const lines = trimmed.split(/\r?\n/)
  const upperCommand = command.trim().toUpperCase()

  // Determine command type from first word
  const cmdWord = upperCommand.split(/\s+/)[0]

  // Commands that return lists (one value per line)
  const listCommands = ['KEYS', 'SMEMBERS', 'LRANGE', 'SINTER', 'SUNION']
  if (listCommands.includes(cmdWord)) {
    const rows = lines
      .filter((line) => line.trim())
      .map((line) => ({ value: line }))
    return {
      columns: ['value'],
      rows,
      rowCount: rows.length,
    }
  }

  // HGETALL returns alternating key/value pairs
  if (cmdWord === 'HGETALL') {
    const rows: QueryResultRow[] = []
    for (let i = 0; i < lines.length - 1; i += 2) {
      rows.push({
        key: lines[i],
        value: lines[i + 1],
      })
    }
    return {
      columns: ['key', 'value'],
      rows,
      rowCount: rows.length,
    }
  }

  // ZRANGE with WITHSCORES returns alternating member/score pairs
  if (cmdWord === 'ZRANGE' && upperCommand.includes('WITHSCORES')) {
    const rows: QueryResultRow[] = []
    for (let i = 0; i < lines.length - 1; i += 2) {
      rows.push({
        member: lines[i],
        score: parseFloat(lines[i + 1]),
      })
    }
    return {
      columns: ['member', 'score'],
      rows,
      rowCount: rows.length,
    }
  }

  // SCAN returns cursor then list of keys
  if (cmdWord === 'SCAN') {
    // First line is cursor, rest are keys
    const keys = lines.slice(1).filter((line) => line.trim())
    const rows = keys.map((key) => ({ value: key }))
    return {
      columns: ['value'],
      rows,
      rowCount: rows.length,
    }
  }

  // TYPE returns a single type string
  if (cmdWord === 'TYPE') {
    return {
      columns: ['type'],
      rows: [{ type: trimmed }],
      rowCount: 1,
    }
  }

  // INFO returns key:value pairs
  if (cmdWord === 'INFO') {
    const rows: QueryResultRow[] = []
    for (const line of lines) {
      if (line.startsWith('#') || !line.trim()) continue
      const colonIdx = line.indexOf(':')
      if (colonIdx > 0) {
        rows.push({
          key: line.slice(0, colonIdx),
          value: line.slice(colonIdx + 1),
        })
      }
    }
    return {
      columns: ['key', 'value'],
      rows,
      rowCount: rows.length,
    }
  }

  // Default: single result value
  return {
    columns: ['result'],
    rows: [{ result: trimmed }],
    rowCount: 1,
  }
}

/**
 * Parse REST API JSON response for vector/search databases
 */
export function parseRESTAPIResult(json: string): QueryResult {
  const data = JSON.parse(json) as unknown

  // Handle Qdrant/Meilisearch result format with 'result' wrapper
  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>

    // Qdrant format: { result: {...}, status: "ok", time: 0.001 }
    if ('result' in obj) {
      const result = obj.result

      // If result is an array
      if (Array.isArray(result)) {
        if (result.length === 0) {
          return { columns: [], rows: [], rowCount: 0 }
        }

        const firstItem = result[0]
        if (typeof firstItem === 'object' && firstItem !== null) {
          const columns = Object.keys(firstItem)
          return {
            columns,
            rows: result as QueryResultRow[],
            rowCount: result.length,
          }
        }

        // Array of primitives
        return {
          columns: ['value'],
          rows: result.map((v) => ({ value: v })),
          rowCount: result.length,
        }
      }

      // Single object result
      if (typeof result === 'object' && result !== null) {
        const columns = Object.keys(result)
        return {
          columns,
          rows: [result as QueryResultRow],
          rowCount: 1,
        }
      }

      // Scalar result
      return {
        columns: ['result'],
        rows: [{ result }],
        rowCount: 1,
      }
    }

    // Meilisearch search format: { hits: [...], query: "...", processingTimeMs: ... }
    if ('hits' in obj && Array.isArray(obj.hits)) {
      const hits = obj.hits as QueryResultRow[]
      if (hits.length === 0) {
        return { columns: [], rows: [], rowCount: 0 }
      }

      const columns = Object.keys(hits[0])
      return {
        columns,
        rows: hits,
        rowCount: hits.length,
        executionTimeMs: obj.processingTimeMs as number | undefined,
      }
    }

    // CouchDB format: { rows: [...] }
    if ('rows' in obj && Array.isArray(obj.rows)) {
      const rows = obj.rows as QueryResultRow[]
      if (rows.length === 0) {
        return { columns: [], rows: [], rowCount: 0 }
      }

      const columns = Object.keys(rows[0])
      return {
        columns,
        rows,
        rowCount: rows.length,
      }
    }
  }

  // Fallback to generic JSON parsing
  return parseJSONToQueryResult(json)
}

/**
 * Parse a string value into appropriate type (number, boolean, null)
 */
function parseValue(value: string | undefined): unknown {
  if (value === undefined || value === '') return null
  if (value === 'NULL' || value === '\\N') return null
  if (value === 'true' || value === 't') return true
  if (value === 'false' || value === 'f') return false

  // Try parsing as number
  const num = Number(value)
  if (!isNaN(num) && value.trim() !== '') {
    return num
  }

  return value
}
