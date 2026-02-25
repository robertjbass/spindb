import { Engine, assertExhaustive } from '../types'

type DatabaseCapabilities = {
  supportsCreate: boolean
  supportsDrop: boolean
  supportsRename: 'native' | 'backup-restore' | false
  unsupportedReason?: string
}

function getDatabaseCapabilities(engine: Engine): DatabaseCapabilities {
  switch (engine) {
    // Full support — create, rename (native), drop
    case Engine.PostgreSQL:
    case Engine.CockroachDB:
    case Engine.ClickHouse:
    case Engine.Meilisearch:
      return {
        supportsCreate: true,
        supportsDrop: true,
        supportsRename: 'native',
      }

    // Full support — create, rename (backup/restore), drop
    case Engine.MySQL:
    case Engine.MariaDB:
    case Engine.MongoDB:
    case Engine.FerretDB:
    case Engine.SurrealDB:
    case Engine.TypeDB:
    case Engine.InfluxDB:
    case Engine.CouchDB:
    case Engine.Qdrant:
    case Engine.Weaviate:
      return {
        supportsCreate: true,
        supportsDrop: true,
        supportsRename: 'backup-restore',
      }

    // No support — file-based
    case Engine.SQLite:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'SQLite is file-based. The file IS the database. Use "spindb create" to make a new database file.',
      }
    case Engine.DuckDB:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'DuckDB is file-based. The file IS the database. Use "spindb create" to make a new database file.',
      }

    // No support — fixed numbered databases
    case Engine.Redis:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'Redis uses fixed numbered databases (0-15) that always exist. Select a database with: spindb run <container> -c "SELECT 3"',
      }
    case Engine.Valkey:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'Valkey uses fixed numbered databases (0-15) that always exist. Select a database with: spindb run <container> -c "SELECT 3"',
      }

    // No support — single-database model
    case Engine.QuestDB:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'QuestDB uses a single-database model ("qdb"). Create tables directly with: spindb run <container> -c "CREATE TABLE ..."',
      }

    // No support — single ledger
    case Engine.TigerBeetle:
      return {
        supportsCreate: false,
        supportsDrop: false,
        supportsRename: false,
        unsupportedReason:
          'TigerBeetle is a single ledger instance with a fixed schema. Use "spindb delete" to remove the entire ledger.',
      }

    default:
      assertExhaustive(engine, `Unknown engine: ${engine}`)
  }
}

function canCreateDatabase(engine: Engine): boolean {
  return getDatabaseCapabilities(engine).supportsCreate
}

function canRenameDatabase(engine: Engine): boolean {
  return getDatabaseCapabilities(engine).supportsRename !== false
}

function canDropDatabase(engine: Engine): boolean {
  return getDatabaseCapabilities(engine).supportsDrop
}

function getUnsupportedCreateMessage(engine: Engine): string {
  const caps = getDatabaseCapabilities(engine)
  if (caps.supportsCreate) return ''

  switch (engine) {
    case Engine.SQLite:
      return 'Database creation is not supported for SQLite. The file IS the database. Use "spindb create" to make a new database file.'
    case Engine.DuckDB:
      return 'Database creation is not supported for DuckDB. The file IS the database. Use "spindb create" to make a new database file.'
    case Engine.Redis:
      return 'Database creation is not supported for Redis. Redis uses fixed numbered databases (0-15) that always exist. Select a database with: spindb run <container> -c "SELECT 3"'
    case Engine.Valkey:
      return 'Database creation is not supported for Valkey. Valkey uses fixed numbered databases (0-15) that always exist. Select a database with: spindb run <container> -c "SELECT 3"'
    case Engine.QuestDB:
      return 'Database creation is not supported for QuestDB. QuestDB uses a single-database model ("qdb"). Create tables directly with: spindb run <container> -c "CREATE TABLE ..."'
    case Engine.TigerBeetle:
      return 'Database creation is not supported for TigerBeetle. Each container is a single ledger instance with a fixed schema.'
    default:
      return (
        caps.unsupportedReason ||
        `Database creation is not supported for ${engine}.`
      )
  }
}

function getUnsupportedRenameMessage(engine: Engine): string {
  const caps = getDatabaseCapabilities(engine)
  if (caps.supportsRename !== false) return ''

  switch (engine) {
    case Engine.SQLite:
      return 'Database rename is not supported for SQLite. Use "spindb edit --relocate" to move the file, or rename it directly and re-attach with "spindb attach".'
    case Engine.DuckDB:
      return 'Database rename is not supported for DuckDB. Use "spindb edit --relocate" to move the file, or rename it directly and re-attach with "spindb attach".'
    case Engine.Redis:
      return 'Database rename is not supported for Redis. Redis databases are identified by number (0-15) and cannot be renamed.'
    case Engine.Valkey:
      return 'Database rename is not supported for Valkey. Valkey databases are identified by number (0-15) and cannot be renamed.'
    case Engine.QuestDB:
      return 'Database rename is not supported for QuestDB. QuestDB uses a single-database model.'
    case Engine.TigerBeetle:
      return 'Database rename is not supported for TigerBeetle. Each container is a single ledger instance.'
    default:
      return (
        caps.unsupportedReason ||
        `Database rename is not supported for ${engine}.`
      )
  }
}

function getUnsupportedDropMessage(engine: Engine): string {
  const caps = getDatabaseCapabilities(engine)
  if (caps.supportsDrop) return ''

  switch (engine) {
    case Engine.SQLite:
      return 'Database drop is not supported for SQLite. Use "spindb delete" to remove the container, or delete the file directly.'
    case Engine.DuckDB:
      return 'Database drop is not supported for DuckDB. Use "spindb delete" to remove the container, or delete the file directly.'
    case Engine.Redis:
      return 'Database drop is not supported for Redis. Use "FLUSHDB" via "spindb run" to clear a numbered database.'
    case Engine.Valkey:
      return 'Database drop is not supported for Valkey. Use "FLUSHDB" via "spindb run" to clear a numbered database.'
    case Engine.QuestDB:
      return 'Database drop is not supported for QuestDB. QuestDB uses a single-database model.'
    case Engine.TigerBeetle:
      return 'Database drop is not supported for TigerBeetle. Use "spindb delete" to remove the entire ledger.'
    default:
      return (
        caps.unsupportedReason ||
        `Database drop is not supported for ${engine}.`
      )
  }
}

export {
  type DatabaseCapabilities,
  getDatabaseCapabilities,
  canCreateDatabase,
  canRenameDatabase,
  canDropDatabase,
  getUnsupportedCreateMessage,
  getUnsupportedRenameMessage,
  getUnsupportedDropMessage,
}
