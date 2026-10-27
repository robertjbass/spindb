/**
 * Load one engine module on demand instead of the whole registry.
 *
 * `engines/index.ts` statically imports every engine (22 of them, roughly 200
 * modules). Anything that imports it pays for all of them at startup, which
 * made a cheap command like `spindb list --json` spend most of its time
 * loading code it never runs. Layerbase Cloud runs that command once a minute
 * in every container on a 0.5-CPU budget, so startup cost is real money there.
 *
 * Code on hot startup paths (`core/container-manager.ts`, `cli/commands/list.ts`)
 * uses `loadEngine()` so only the engines actually needed are imported. The
 * returned object is the same singleton `getEngine()` returns, because ESM
 * caches each module. Everything else may keep using the synchronous
 * `getEngine()` from `engines/index.ts`.
 */
import { Engine } from '../types'
import type { BaseEngine } from './base-engine'

const ENGINE_LOADERS: Record<Engine, () => Promise<BaseEngine>> = {
  [Engine.PostgreSQL]: async () =>
    (await import('./postgresql')).postgresqlEngine,
  [Engine.MySQL]: async () => (await import('./mysql')).mysqlEngine,
  [Engine.MariaDB]: async () => (await import('./mariadb')).mariadbEngine,
  [Engine.SQLite]: async () => (await import('./sqlite')).sqliteEngine,
  [Engine.DuckDB]: async () => (await import('./duckdb')).duckdbEngine,
  [Engine.MongoDB]: async () => (await import('./mongodb')).mongodbEngine,
  [Engine.FerretDB]: async () => (await import('./ferretdb')).ferretdbEngine,
  [Engine.DocumentDB]: async () =>
    (await import('./documentdb')).documentdbEngine,
  [Engine.Redis]: async () => (await import('./redis')).redisEngine,
  [Engine.Valkey]: async () => (await import('./valkey')).valkeyEngine,
  [Engine.ClickHouse]: async () =>
    (await import('./clickhouse')).clickhouseEngine,
  [Engine.Qdrant]: async () => (await import('./qdrant')).qdrantEngine,
  [Engine.Meilisearch]: async () =>
    (await import('./meilisearch')).meilisearchEngine,
  [Engine.CouchDB]: async () => (await import('./couchdb')).couchdbEngine,
  [Engine.CockroachDB]: async () =>
    (await import('./cockroachdb')).cockroachdbEngine,
  [Engine.SurrealDB]: async () => (await import('./surrealdb')).surrealdbEngine,
  [Engine.QuestDB]: async () => (await import('./questdb')).questdbEngine,
  [Engine.TypeDB]: async () => (await import('./typedb')).typedbEngine,
  [Engine.InfluxDB]: async () => (await import('./influxdb')).influxdbEngine,
  [Engine.Weaviate]: async () => (await import('./weaviate')).weaviateEngine,
  [Engine.TigerBeetle]: async () =>
    (await import('./tigerbeetle')).tigerbeetleEngine,
  [Engine.LibSQL]: async () => (await import('./libsql')).libsqlEngine,
}

function isCanonicalEngine(name: string): name is Engine {
  return Object.hasOwn(ENGINE_LOADERS, name)
}

/**
 * Async twin of `getEngine()`. Canonical engine names load only that engine;
 * aliases and unknown names fall back to the full registry so they resolve
 * (or throw) exactly as `getEngine()` does.
 */
export async function loadEngine(name: string): Promise<BaseEngine> {
  if (isCanonicalEngine(name)) {
    return ENGINE_LOADERS[name]()
  }
  const { getEngine } = await import('./index')
  return getEngine(name)
}
