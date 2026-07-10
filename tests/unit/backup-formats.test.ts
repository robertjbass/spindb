import { describe, it } from 'node:test'
import { BACKUP_FORMATS } from '../../config/backup-formats'
import { Engine } from '../../types'
import { assert, assertEqual } from '../utils/assertions'

describe('BACKUP_FORMATS', () => {
  // The mongo/ferretdb `archive-plain` format is the uncompressed single-file
  // archive (mongodump --archive WITHOUT --gzip), added so a consumer whose
  // restore path does not pass --gzip (e.g. Layerbase Cloud's legacy
  // `mongorestore --archive`) can read spindb-produced backups. The compressed
  // `archive` stays the default.
  it('mongodb + ferretdb expose an uncompressed archive-plain format', () => {
    for (const engine of [Engine.MongoDB, Engine.FerretDB] as const) {
      const { formats, defaultFormat } = BACKUP_FORMATS[engine]
      assert(
        'archive' in formats,
        `${engine} should keep the compressed archive`,
      )
      assert(
        'archive-plain' in formats,
        `${engine} should expose archive-plain`,
      )
      assertEqual(
        formats['archive-plain'].extension,
        '.archive',
        `${engine} archive-plain extension`,
      )
      // the default stays the compressed archive (no behavior change)
      assertEqual(
        defaultFormat,
        'archive',
        `${engine} default format unchanged`,
      )
    }
  })
})
