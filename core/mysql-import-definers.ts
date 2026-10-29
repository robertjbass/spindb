import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { randomUUID } from 'node:crypto'
import { registerTempDump } from './temp-dump-cleanup'
import type { DumpResult } from '../types'

type TokenKind = 'word' | 'quoted' | 'space' | 'comment' | 'symbol' | 'opaque'
const MAX_TOKEN = 8192
const HEADER_WORDS = new Set([
  'CREATE',
  'OR',
  'REPLACE',
  'ALGORITHM',
  'UNDEFINED',
  'MERGE',
  'TEMPTABLE',
  'SQL',
  'SECURITY',
  'DEFINER',
  'INVOKER',
])

/** Rewrite object owners in remote dumps, without interpreting literals as SQL. */
export class MysqlImportDefiners extends Transform {
  count = 0
  private tail = ''
  private mode: 'code' | 'quote' | 'line' | 'block' | 'version' = 'code'
  private quote = ''
  private token = ''
  private kind: TokenKind = 'symbol'
  private oversized = false
  private executable = false
  private backslashEscapes = true
  private versionTokens: string[] | null = null
  private savedModes = new Map<string, boolean>()
  private header = false
  private pending = ''
  private stage: 'equals' | 'user' | 'at' | 'host' | null = null
  private output: string[] = []

  private applyVersionSqlMode(): void {
    const tokens = this.versionTokens
    this.versionTokens = null
    if (!tokens || tokens[0]?.toUpperCase() !== 'SET') return
    let start = 1
    for (let i = 1; i <= tokens.length; i++) {
      if (i < tokens.length && tokens[i] !== ',') continue
      const assignment = tokens.slice(start, i)
      start = i + 1
      const equals = assignment.indexOf('=')
      if (equals < 0) continue
      const left = assignment.slice(0, equals).join('').toLowerCase()
      const right = assignment.slice(equals + 1).join('')
      const name = right.toLowerCase()
      const mode =
        right.startsWith("'") || right.startsWith('"')
          ? !right.toUpperCase().includes('NO_BACKSLASH_ESCAPES')
          : name === '@@sql_mode' || name === '@@session.sql_mode'
            ? this.backslashEscapes
            : this.savedModes.get(name)
      if (
        [
          'sql_mode',
          '@@sql_mode',
          '@@session.sql_mode',
          'sessionsql_mode',
        ].includes(left)
      ) {
        if (mode === undefined)
          throw new Error(
            'Cannot normalize import DEFINER clauses with an unresolved SQL_MODE. Export using the standard mysqldump or mariadb-dump settings and retry.',
          )
        this.backslashEscapes = mode
      } else if (
        left.startsWith('@') &&
        mode !== undefined &&
        (name === '@@sql_mode' ||
          name === '@@session.sql_mode' ||
          this.savedModes.has(name))
      ) {
        if (!this.savedModes.has(left) && this.savedModes.size >= 64) {
          throw new Error(
            'Import has too many saved SQL_MODE variables. Export with standard dump settings and retry.',
          )
        }
        this.savedModes.set(left, mode)
      }
    }
  }

  private emitToken(kind: TokenKind, value: string): void {
    if (this.versionTokens && kind !== 'space' && kind !== 'comment') {
      if (this.versionTokens.length < 64) this.versionTokens.push(value)
      else this.versionTokens = null
    }
    if (this.stage) {
      if (kind === 'space') {
        this.pending += value
        if (this.pending.length > MAX_TOKEN) {
          throw new Error(
            'Import DEFINER clause is too long. Shorten the account clause and retry.',
          )
        }
        return
      }
      const account =
        kind === 'quoted' ||
        (kind === 'word' && value.toUpperCase() !== 'CURRENT_USER')
      if (this.stage === 'equals' && value === '=') this.stage = 'user'
      else if (this.stage === 'user' && account) this.stage = 'at'
      else if (this.stage === 'at' && value === '@') this.stage = 'host'
      else if (this.stage === 'host' && account) {
        this.output.push('DEFINER=CURRENT_USER')
        this.count++
        this.pending = ''
        this.stage = null
        return
      } else {
        this.output.push(this.pending)
        this.pending = ''
        this.stage = null
        this.header = false
        this.output.push(value)
        return
      }
      this.pending += value
      return
    }
    if (kind === 'word') {
      const word = value.toUpperCase()
      if (word === 'CREATE') this.header = true
      else if (this.header && word === 'DEFINER') {
        this.pending = value
        this.stage = 'equals'
        return
      } else if (!HEADER_WORDS.has(word)) this.header = false
    } else if (kind !== 'space' && kind !== 'comment' && value !== '=') {
      this.header = false
    }
    this.output.push(value)
  }

  private flushToken(): void {
    if (this.token)
      this.emitToken(this.oversized ? 'opaque' : this.kind, this.token)
    this.token = ''
    this.oversized = false
  }

  private append(value: string, kind: TokenKind): void {
    if (this.token && this.kind !== kind) this.flushToken()
    this.kind = kind
    this.token += value
    if (this.token.length >= MAX_TOKEN) {
      // Large row literals/comments must not make memory scale with dump size.
      this.emitToken(
        kind === 'comment' || kind === 'space' ? kind : 'opaque',
        this.token,
      )
      this.token = ''
      this.oversized = true
    }
  }

  private consume(input: string, final: boolean): void {
    const data = this.tail + input
    let i = 0
    const end = final ? data.length : Math.max(0, data.length - 4)
    while (i < end) {
      const ch = data[i]
      const next = data[i + 1]
      if (this.mode === 'quote') {
        this.append(ch, 'quoted')
        i++
        if (this.backslashEscapes && ch === '\\' && next !== undefined) {
          this.append(next, 'quoted')
          i++
        } else if (ch === this.quote) {
          if (next === this.quote) {
            this.append(next, 'quoted')
            i++
          } else {
            this.flushToken()
            this.mode = 'code'
          }
        }
        continue
      }
      if (this.mode === 'line') {
        this.append(ch, 'comment')
        i++
        if (ch === '\n') {
          this.flushToken()
          this.mode = 'code'
        }
        continue
      }
      if (this.mode === 'block') {
        this.append(ch, 'comment')
        i++
        if (ch === '*' && next === '/') {
          this.append('/', 'comment')
          i++
          this.flushToken()
          this.mode = 'code'
        }
        continue
      }
      if (this.mode === 'version') {
        if (/[0-9]/.test(ch)) {
          this.append(ch, 'comment')
          i++
          continue
        }
        this.flushToken()
        this.mode = 'code'
      }
      if (this.executable && ch === '*' && next === '/') {
        this.flushToken()
        this.applyVersionSqlMode()
        this.emitToken('comment', '*/')
        i += 2
        this.executable = false
      } else if (ch === '/' && next === '*') {
        this.flushToken()
        const prefix = data.slice(i, i + 4)
        if (prefix.startsWith('/*!') || prefix === '/*M!') {
          const size = prefix === '/*M!' ? 4 : 3
          this.append(data.slice(i, i + size), 'comment')
          i += size
          this.mode = 'version'
          this.executable = true
          this.versionTokens = []
        } else {
          this.append('/*', 'comment')
          i += 2
          this.mode = 'block'
        }
      } else if (
        ch === '#' ||
        (ch === '-' && next === '-' && /\s/.test(data[i + 2] ?? ''))
      ) {
        this.flushToken()
        this.mode = 'line'
      } else if (ch === "'" || ch === '"' || ch === '`') {
        this.flushToken()
        this.quote = ch
        this.mode = 'quote'
        this.append(ch, 'quoted')
        i++
      } else if (/[a-zA-Z0-9_$%.-]/.test(ch)) {
        this.append(ch, 'word')
        i++
      } else if (/\s/.test(ch)) {
        this.append(ch, 'space')
        i++
      } else {
        this.flushToken()
        this.emitToken('symbol', ch)
        i++
      }
    }
    this.tail = data.slice(i)
    if (final) {
      this.flushToken()
      this.output.push(this.pending)
      this.pending = ''
    }
    this.push(Buffer.from(this.output.join(''), 'latin1'))
    this.output = []
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      this.consume(chunk.toString('latin1'), false)
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.consume('', true)
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }
}

/** A separate output keeps a failed normalization from replacing a valid dump. */
export async function normalizeRemoteDumpDefiners(
  result: DumpResult,
): Promise<DumpResult> {
  const temporary = `${result.filePath}.${randomUUID()}.definers`
  const release = registerTempDump(temporary)
  const transform = new MysqlImportDefiners()
  try {
    await pipeline(
      createReadStream(result.filePath),
      transform,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
    )
    await rename(temporary, result.filePath)
  } finally {
    await rm(temporary, { force: true })
    release()
  }
  return {
    ...result,
    warnings: [
      ...(result.warnings ?? []),
      ...(transform.count
        ? [
            `Reassigned ${transform.count} object DEFINER clauses to the importing account; SQL SECURITY settings are unchanged.`,
          ]
        : []),
    ],
    remoteSource: {
      ...(result.remoteSource ?? { flavor: 'unknown', dumpTool: 'unknown' }),
      rewrites: {
        ...result.remoteSource?.rewrites,
        definersRewritten: transform.count,
      },
    },
  }
}
