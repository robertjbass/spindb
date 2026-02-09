# Cloud Database Alternatives

Every database engine supported by SpinDB and its managed cloud (DBaaS/BaaS) equivalents.

## PostgreSQL

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [Supabase](https://supabase.com) | BaaS | PostgreSQL | PostgreSQL + auth, real-time, auto-generated APIs, storage |
| [Neon](https://neon.tech) | DBaaS | PostgreSQL | Serverless PostgreSQL with scale-to-zero and database branching |
| [Crunchy Bridge](https://www.crunchydata.com/products/crunchy-bridge) | DBaaS | PostgreSQL | Enterprise-focused managed PostgreSQL |
| [Tembo](https://tembo.io) | DBaaS | PostgreSQL | Managed PostgreSQL with stacks (pre-configured extension bundles) |
| [Xata](https://xata.io) | BaaS | PostgreSQL | PostgreSQL + built-in search, file attachments, branching |
| [Timescale](https://www.timescale.com/cloud) | DBaaS | PostgreSQL | PostgreSQL optimized for time-series with TimescaleDB extension |
| [Railway](https://railway.app) | PaaS | PostgreSQL, MySQL, Redis | One-click PostgreSQL with instant provisioning |
| [Render](https://render.com) | PaaS | PostgreSQL, Redis | Managed PostgreSQL with automatic backups |
| [Heroku Postgres](https://www.heroku.com/postgres) | PaaS | PostgreSQL, Redis | Managed PostgreSQL integrated with Heroku platform |
| [Aiven](https://aiven.io/postgresql) | DBaaS | PostgreSQL, MySQL, MariaDB, Redis, Valkey, ClickHouse | Multi-cloud (AWS/GCP/Azure/DO) managed PostgreSQL |
| [AWS RDS](https://aws.amazon.com/rds/postgresql/) | DBaaS | PostgreSQL, MySQL, MariaDB | Fully managed on AWS |
| [Amazon Aurora](https://aws.amazon.com/rds/aurora/) | DBaaS | PostgreSQL, MySQL | AWS-enhanced PostgreSQL (3x throughput) |
| [Google Cloud SQL](https://cloud.google.com/sql/postgresql) | DBaaS | PostgreSQL, MySQL | Fully managed on GCP |
| [Google AlloyDB](https://cloud.google.com/alloydb) | DBaaS | PostgreSQL | PostgreSQL-compatible with enhanced analytics |
| [Azure Database for PostgreSQL](https://azure.microsoft.com/en-us/products/postgresql/) | DBaaS | PostgreSQL, MySQL | Fully managed on Azure |
| [DigitalOcean](https://www.digitalocean.com/products/managed-databases-postgresql) | DBaaS | PostgreSQL, MySQL, Redis, Valkey, MongoDB | Simple managed PostgreSQL |

## MySQL

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [PlanetScale](https://planetscale.com) | DBaaS | MySQL, PostgreSQL | Vitess-powered MySQL with branching, zero-downtime migrations, sharding |
| [TiDB Cloud](https://www.pingcap.com/tidb-cloud/) | DBaaS | MySQL | MySQL-compatible distributed SQL (HTAP) |
| [SingleStore](https://www.singlestore.com) | DBaaS | MySQL | MySQL wire-compatible, unified analytics + transactions |
| [Aiven](https://aiven.io/mysql) | DBaaS | PostgreSQL, MySQL, MariaDB, Redis, Valkey, ClickHouse | Multi-cloud managed MySQL |
| [Railway](https://railway.app) | PaaS | PostgreSQL, MySQL, Redis | One-click MySQL provisioning |
| [AWS RDS](https://aws.amazon.com/rds/mysql/) | DBaaS | PostgreSQL, MySQL, MariaDB | Fully managed on AWS |
| [Amazon Aurora](https://aws.amazon.com/rds/aurora/) | DBaaS | PostgreSQL, MySQL | AWS-enhanced MySQL (5x throughput) |
| [Google Cloud SQL](https://cloud.google.com/sql/mysql) | DBaaS | PostgreSQL, MySQL | Fully managed on GCP |
| [Azure Database for MySQL](https://azure.microsoft.com/en-us/products/mysql/) | DBaaS | PostgreSQL, MySQL | Fully managed on Azure |
| [DigitalOcean](https://www.digitalocean.com/products/managed-databases-mysql) | DBaaS | PostgreSQL, MySQL, Redis, Valkey, MongoDB | Simple managed MySQL |

## MariaDB

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [MariaDB Cloud (SkySQL)](https://mariadb.com/products/cloud/) | DBaaS | MariaDB | Official managed service, serverless + provisioned options |
| [Aiven](https://aiven.io) | DBaaS | PostgreSQL, MySQL, MariaDB, Redis, Valkey, ClickHouse | Multi-cloud managed MariaDB |
| [AWS RDS](https://aws.amazon.com/rds/mariadb/) | DBaaS | PostgreSQL, MySQL, MariaDB | Fully managed on AWS |

## MongoDB

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [MongoDB Atlas](https://www.mongodb.com/atlas) | DBaaS | MongoDB | Official managed MongoDB on AWS/GCP/Azure, serverless + dedicated |
| [AWS DocumentDB](https://aws.amazon.com/documentdb/) | DBaaS | MongoDB | MongoDB-compatible (not full API parity) |
| [Azure Cosmos DB (MongoDB API)](https://learn.microsoft.com/en-us/azure/cosmos-db/mongodb/) | DBaaS | MongoDB | MongoDB wire protocol on Cosmos DB, global distribution |
| [DigitalOcean](https://www.digitalocean.com/products/managed-databases-mongodb) | DBaaS | PostgreSQL, MySQL, Redis, Valkey, MongoDB | Simple managed MongoDB |

## FerretDB

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [FerretDB Cloud](https://www.ferretdb.com/cloud/) | DBaaS | FerretDB | Official managed FerretDB, MongoDB-compatible with PostgreSQL backend |

## Redis

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [Redis Cloud](https://redis.io/cloud/) | DBaaS | Redis | Official managed Redis by Redis Inc. |
| [Upstash](https://upstash.com) | DBaaS | Redis | Serverless Redis with HTTP API, pay-per-request pricing |
| [Dragonfly Cloud](https://www.dragonflydb.io/cloud) | DBaaS | Redis | Redis-compatible, multi-threaded drop-in replacement |
| [Aiven](https://aiven.io/redis) | DBaaS | PostgreSQL, MySQL, MariaDB, Redis, Valkey, ClickHouse | Multi-cloud managed Redis |
| [Railway](https://railway.app) | PaaS | PostgreSQL, MySQL, Redis | Managed Redis with instant provisioning |
| [Render](https://render.com) | PaaS | PostgreSQL, Redis | Managed Redis with automatic backups |
| [Heroku](https://www.heroku.com) | PaaS | PostgreSQL, Redis | Managed Redis integrated with Heroku platform |
| [AWS ElastiCache](https://aws.amazon.com/elasticache/redis/) | DBaaS | Redis, Valkey | Managed on AWS (frozen at Redis 7.2, migrating to Valkey) |
| [Azure Cache for Redis](https://azure.microsoft.com/en-us/products/cache/) | DBaaS | Redis | Managed on Azure |
| [Google Memorystore](https://cloud.google.com/memorystore) | DBaaS | Redis, Valkey | Managed on GCP (migrating to Valkey) |
| [DigitalOcean](https://www.digitalocean.com/products/managed-databases-redis) | DBaaS | PostgreSQL, MySQL, Redis, Valkey, MongoDB | Simple managed Redis |

## Valkey

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [Aiven](https://aiven.io/valkey) | DBaaS | PostgreSQL, MySQL, MariaDB, Redis, Valkey, ClickHouse | Multi-cloud managed Valkey |
| [AWS ElastiCache](https://aws.amazon.com/elasticache/valkey/) | DBaaS | Redis, Valkey | AWS's primary managed key-value store (replaced Redis) |
| [Google Memorystore](https://cloud.google.com/memorystore) | DBaaS | Redis, Valkey | GCP's primary managed key-value store |
| [DigitalOcean](https://www.digitalocean.com/products/managed-databases-valkey) | DBaaS | PostgreSQL, MySQL, Redis, Valkey, MongoDB | Simple managed Valkey |

## ClickHouse

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [ClickHouse Cloud](https://clickhouse.com/cloud) | DBaaS | ClickHouse | Official managed ClickHouse on AWS/GCP/Azure |
| [Tinybird](https://www.tinybird.co) | DBaaS | ClickHouse | ClickHouse-powered real-time analytics with API-first approach |
| [Aiven](https://aiven.io/clickhouse) | DBaaS | PostgreSQL, MySQL, MariaDB, Redis, Valkey, ClickHouse | Multi-cloud managed ClickHouse |
| [Altinity.Cloud](https://altinity.com/cloud-database/) | DBaaS | ClickHouse | Kubernetes-native managed ClickHouse |

## SQLite

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [Turso](https://turso.tech) | DBaaS | SQLite | Edge-hosted libSQL (SQLite fork) with embedded replicas |
| [Cloudflare D1](https://developers.cloudflare.com/d1/) | DBaaS | SQLite | Serverless SQLite on Cloudflare's edge network |
| [LiteFS Cloud](https://fly.io/docs/litefs/) | DBaaS | SQLite | Distributed SQLite replication on Fly.io |

## DuckDB

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [MotherDuck](https://motherduck.com) | DBaaS | DuckDB | Serverless DuckDB with hybrid local+cloud query execution |

## Qdrant

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [Qdrant Cloud](https://qdrant.tech/cloud/) | DBaaS | Qdrant | Official managed Qdrant on AWS/GCP/Azure |
| [Qdrant Hybrid Cloud](https://qdrant.tech/hybrid-cloud/) | DBaaS | Qdrant | Managed Qdrant deployed in your own infrastructure |

## Meilisearch

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [Meilisearch Cloud](https://www.meilisearch.com/cloud) | DBaaS | Meilisearch | Official managed Meilisearch with analytics and monitoring |

## CouchDB

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [IBM Cloudant](https://www.ibm.com/products/cloudant) | DBaaS | CouchDB | CouchDB-based, replication-compatible, serverless scaling |

## CockroachDB

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [CockroachDB Cloud](https://www.cockroachlabs.com/product/cloud/) | DBaaS | CockroachDB | Official managed CockroachDB, serverless + dedicated tiers |

## SurrealDB

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [Surreal Cloud](https://surrealdb.com/cloud) | DBaaS | SurrealDB | Official managed SurrealDB on AWS |

## QuestDB

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [QuestDB Enterprise (BYOC)](https://questdb.com/enterprise/) | DBaaS | QuestDB | Bring-your-own-cloud on AWS/Azure, managed by QuestDB ops team |

## TypeDB

| Service | Type | Databases | Notes |
|---------|------|-----------|-------|
| [TypeDB Cloud](https://cloud.typedb.com) | DBaaS | TypeDB | Official managed TypeDB on AWS/GCP |
