import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'crypto'
import { readFile, rm, mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  exportToDocker,
  getDefaultDockerExportPath,
  getDockerConnectionString,
} from '../../core/docker-exporter'
import { Engine } from '../../types'

for (const engine of [Engine.MongoDB, Engine.FerretDB]) {
  test(`${engine} Docker export retains MongoDB entrypoint and connection URLs`, async () => {
    const name = `docker-regression-${randomUUID()}`
    const outputDir = getDefaultDockerExportPath(name, engine)
    try {
      const result = await exportToDocker(
        {
          name,
          engine,
          version: engine === Engine.MongoDB ? '8.0.23' : '2.7.0',
          database: 'proof',
          port: 27017,
          status: 'stopped',
          created: new Date().toISOString(),
        },
        { outputDir, includeData: false, skipTLS: true },
      )
      assert.match(
        await readFile(join(outputDir, 'entrypoint.sh'), 'utf8'),
        /createUser/,
      )
      assert.match(
        await readFile(join(outputDir, 'README.md'), 'utf8'),
        /mongodb:\/\//,
      )
      const url = await getDockerConnectionString(name, engine)
      assert.ok(url)
      const parsed = new URL(url)
      assert.equal(parsed.protocol, 'mongodb:')
      assert.equal(
        decodeURIComponent(parsed.username),
        result.credentials.username,
      )
      assert.equal(
        decodeURIComponent(parsed.password),
        result.credentials.password,
      )
      assert.equal(parsed.pathname, '/proof')
    } finally {
      await rm(dirname(outputDir), { recursive: true, force: true })
    }
  })
}

test('DocumentDB Docker export remains explicitly unavailable', async () => {
  const name = `docker-refusal-${randomUUID()}`
  const outputDir = getDefaultDockerExportPath(name, Engine.DocumentDB)
  try {
    await assert.rejects(
      exportToDocker(
        {
          name,
          engine: Engine.DocumentDB,
          version: '1.0.0',
          database: 'proof',
          port: 27017,
          status: 'stopped',
          created: new Date().toISOString(),
        },
        { outputDir, includeData: false, skipTLS: true },
      ),
      /DocumentDB Docker export is unavailable/,
    )
    await mkdir(outputDir, { recursive: true })
    await writeFile(
      join(outputDir, '.env'),
      'SPINDB_USER=test\nSPINDB_PASSWORD=test\nPORT=27017\nDATABASE=proof\n',
    )
    await assert.rejects(
      getDockerConnectionString(name, Engine.DocumentDB),
      /DocumentDB Docker export is unavailable/,
    )
  } finally {
    await rm(dirname(outputDir), { recursive: true, force: true })
  }
})
