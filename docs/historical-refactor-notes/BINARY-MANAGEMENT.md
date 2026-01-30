# Engine Migration Guide

## Why This Document Exists

This document contains historical instructions for migrating a database engine from system-installed binaries (via Homebrew, apt, etc.) to downloadable hostdb binaries.

**As of January 2026, all SpinDB engines use hostdb downloads.** This migration process is no longer needed for existing engines. However, this guide is preserved for:

1. **Historical reference** - Understanding how engines were migrated
2. **Future engines** - If a new engine initially uses system binaries before hostdb support is added
3. **Troubleshooting** - Understanding the binary registration system

For adding **new engines**, see [ENGINE_CHECKLIST.md](../../ENGINE_CHECKLIST.md) which covers the complete process from scratch.

---

## Migrating an Engine from System Binaries to hostdb

When hostdb adds support for a new engine, follow these steps to migrate from system-installed binaries to downloadable hostdb binaries. **Reference: MariaDB engine** as an example.

**Current status:** All engines now use hostdb downloads:
- PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Valkey: Complete bundles from hostdb (server + all client tools)
- SQLite: Tools from hostdb (sqlite3, sqldiff, sqlite3_analyzer, sqlite3_rsync)
- DuckDB: CLI from hostdb (duckdb)

### Prerequisites

**CRITICAL: Check hostdb releases.json first**

Before starting, verify binaries exist and note exact versions:
1. View https://github.com/robertjbass/hostdb/blob/main/releases.json
2. Find the engine under `databases.{engine}`
3. Note ALL available versions (e.g., `"8.0.5"`, `"8.2.0"`) - these become your version map
4. Note supported platforms (darwin-arm64, darwin-x64, linux-x64)
5. **The version-maps.ts file MUST match releases.json exactly** - any version not in releases.json will fail to download

**MySQL Migration Note (Historical):** MySQL now uses hostdb binaries on ALL platforms. Previously, SpinDB used MariaDB as a drop-in replacement for MySQL on Linux (since MySQL wasn't easily available via apt). With hostdb providing MySQL binaries directly, this workaround is no longer needed. MySQL and MariaDB are now fully separate engines with their own binaries.

### Step 1: Create Binary Management Files

Create these new files in `engines/{engine}/`:

**`version-maps.ts`** - Maps major versions to full versions

**SYNC REQUIREMENT:** This file must match hostdb releases.json exactly. Check releases.json first, then create this file with those exact versions.

```ts
/**
 * TEMPORARY: This version map will be replaced by the hostdb npm package once published.
 * Until then, manually keep this in sync with robertjbass/hostdb releases.json:
 * https://github.com/robertjbass/hostdb/blob/main/releases.json
 *
 * To update: Check releases.json, find databases.{engine}, copy all version strings.
 */
export const {ENGINE}_VERSION_MAP: Record<string, string> = {
  // Copy ALL versions from releases.json - extract major version as key
  '8': '8.0.5',    // From releases.json: "8.0.5"
  '8.2': '8.2.0',  // From releases.json: "8.2.0" (if minor versions differ)
}

export const SUPPORTED_MAJOR_VERSIONS = Object.keys({ENGINE}_VERSION_MAP)
export const FALLBACK_VERSION_MAP = {ENGINE}_VERSION_MAP
```

**`binary-urls.ts`** - Generates download URLs for hostdb releases
```ts
const HOSTDB_BASE_URL = 'https://github.com/robertjbass/hostdb/releases/download'

export function getBinaryUrl(version: string, platform: string, arch: string): string {
  const fullVersion = FALLBACK_VERSION_MAP[version] || version
  const platformKey = `${platform}-${arch}`
  return `${HOSTDB_BASE_URL}/{engine}-${fullVersion}/${engine}-${fullVersion}-${platformKey}.tar.gz`
}
```

**`binary-manager.ts`** - Handles download, extraction, verification
- Copy structure from `engines/mariadb/binary-manager.ts` or `engines/postgresql/binary-manager.ts`
- Update engine name, binary names, and verification logic

### Step 2: Update Main Engine File (`index.ts`)

Key changes to make:

1. **Import new modules:**
   ```ts
   import { {engine}BinaryManager } from './binary-manager'
   import { getBinaryUrl, SUPPORTED_MAJOR_VERSIONS, FALLBACK_VERSION_MAP } from './binary-urls'
   ```

2. **Update `supportedVersions`:**
   ```ts
   supportedVersions = SUPPORTED_MAJOR_VERSIONS
   ```

3. **Update `ensureBinaries()` to register engine-native binaries only:**
   ```ts
   async ensureBinaries(version: string, onProgress?: ProgressCallback): Promise<string> {
     const { platform, arch } = this.getPlatformInfo()
     const binPath = await binaryManager.ensureInstalled(version, platform, arch, onProgress)

     // CRITICAL: Register ONLY engine-native binary names to avoid conflicts
     // e.g., for MariaDB: 'mariadb', 'mariadb-dump', 'mariadb-admin'
     // NOT: 'mysql', 'mysqldump', 'mysqladmin' (those belong to MySQL engine)
     const ext = platformService.getExecutableExtension()
     const clientTools = ['{engine}', '{engine}-dump', '{engine}-admin'] as const

     for (const tool of clientTools) {
       const toolPath = join(binPath, 'bin', `${tool}${ext}`)
       if (existsSync(toolPath)) {
         await configManager.setBinaryPath(tool, toolPath, 'bundled')
       }
     }
     return binPath
   }
   ```

4. **Create engine-specific client path method:**
   ```ts
   override async get{Engine}ClientPath(): Promise<string> {
     const configPath = await configManager.getBinaryPath('{engine}')
     if (configPath) return configPath
     throw new Error('{engine} client not found. Run: spindb engines download {engine}')
   }
   ```

5. **Update all internal methods to use engine-specific client:**
   - Replace calls like `getMysqlClientPath()` with `get{Engine}ClientPath()`
   - Update dump/restore methods to use engine-specific binary keys

### Step 3: Update Type Definitions (`types/index.ts`)

1. **Add to `BinaryTool` type:**
   ```ts
   // {Engine} tools (native names only - no conflicts with other engines)
   | '{engine}'
   | '{engine}-dump'
   | '{engine}d'  // server binary if applicable
   | '{engine}-admin'
   ```

2. **Add to `SpinDBConfig.binaries`:**
   ```ts
   // {Engine} tools
   {engine}?: BinaryConfig
   '{engine}-dump'?: BinaryConfig
   '{engine}d'?: BinaryConfig
   '{engine}-admin'?: BinaryConfig
   ```

### Step 4: Update BaseEngine (`engines/base-engine.ts`)

Add the engine-specific client path method with default implementation:
```ts
/**
 * Get the path to the {engine} client if available
 * Default implementation throws; {Engine} engine overrides this method.
 */
async get{Engine}ClientPath(): Promise<string> {
  throw new Error('{engine} client not found')
}
```

### Step 5: Update Test Helpers (`tests/integration/helpers.ts`)

**CRITICAL:** Each engine must have its own case in `executeSQL()` and `executeSQLFile()`:

```ts
} else if (engine === Engine.{Engine}) {
  const engineImpl = getEngine(engine)
  const clientPath = await engineImpl.get{Engine}ClientPath().catch(() => '{engine}')
  const cmd = `"${clientPath}" -h 127.0.0.1 -P ${port} -u root ${database} -e "${sql}"`
  return execAsync(cmd)
}
```

**Why separate cases?** Using a shared case (e.g., `MySQL || MariaDB`) and calling `getMysqlClientPath()` will fail for the new engine because that method returns the wrong binary. Each engine must call its own client path method.

### Step 6: Update Shell Handlers (`cli/commands/menu/shell-handlers.ts`)

1. **Add to shell option selection (around line 110):**
   ```ts
   } else if (config.engine === '{engine}') {
     defaultShellName = '{engine}'
     engineSpecificCli = 'mycli'  // or appropriate enhanced CLI
     // ...
   }
   ```

2. **Add to `launchShell()` function (around line 435):**
   ```ts
   } else if (config.engine === '{engine}') {
     const clientPath = await configManager.getBinaryPath('{engine}')
     shellCmd = clientPath || '{engine}'
     shellArgs = ['-u', 'root', '-h', '127.0.0.1', '-P', String(config.port), config.database]
     installHint = 'spindb engines download {engine}'
   }
   ```

### Step 7: Update Manage Engines Screen

**Why this matters:** System-installed engines (MySQL, MongoDB, Redis) don't appear in the "Manage Engines" menu because there's nothing to manage - they're installed via Homebrew/apt. Once migrated to hostdb, the engine WILL appear in this menu and users can download/delete versions. This requires adding detection functions.

1. **Add type in `cli/helpers.ts`:**
   ```ts
   export type Installed{Engine}Engine = {
     engine: '{engine}'
     version: string
     platform: string
     arch: string
     path: string
     sizeBytes: number
     source: 'downloaded'
   }
   ```

2. **Add detection function in `cli/helpers.ts`:**
   ```ts
   export async function getInstalled{Engine}Engines(): Promise<Installed{Engine}Engine[]> {
     const binDir = paths.binaries
     if (!existsSync(binDir)) return []

     const entries = await readdir(binDir, { withFileTypes: true })
     const engines: Installed{Engine}Engine[] = []

     for (const entry of entries) {
       if (!entry.isDirectory()) continue
       // Match pattern: {engine}-{version}-{platform}-{arch}
       const match = entry.name.match(/^{engine}-(\d+\.\d+\.\d+)-(\w+)-(\w+)$/)
       if (!match) continue

       const [, version, platform, arch] = match
       const fullPath = join(binDir, entry.name)
       const stats = await stat(fullPath)

       engines.push({
         engine: '{engine}',
         version,
         platform,
         arch,
         path: fullPath,
         sizeBytes: await getDirectorySize(fullPath),
         source: 'downloaded',
       })
     }
     return engines
   }
   ```

3. **Export from `cli/helpers.ts`** - add to exports

4. **Update `cli/commands/menu/engine-handlers.ts`:**
   ```ts
   import { type Installed{Engine}Engine } from '../../helpers'

   // Add filter for the new engine type
   const {engine}Engines = engines.filter(
     (e): e is Installed{Engine}Engine => e.engine === '{engine}',
   )

   // Add totalSize calculation
   const total{Engine}Size = {engine}Engines.reduce((acc, e) => acc + e.sizeBytes, 0)

   // Add to allEnginesSorted array (maintains display grouping)
   const allEnginesSorted = [
     ...pgEngines,
     ...mariadbEngines,
     // ... other engines ...
     ...{engine}Engines,
   ]

   // Add summary display block
   if ({engine}Engines.length > 0) {
     console.log(chalk.gray(`  {Engine}: ${{{engine}Engines.length}} version(s), ${formatBytes(total{Engine}Size)}`))
   }
   ```

   Note: The delete functionality works automatically via `allEnginesSorted` - no additional changes needed.

### Step 8: Update Config Defaults (`config/engine-defaults.ts`)

```ts
{engine}: {
  supportedVersions: ['8', '9'],  // Keep in sync with version-maps.ts
  defaultVersion: '8',
  latestVersion: '9',
  // ...
}
```

### Step 9: Clean Up and Test

1. **Clear stale config entries:** Users with old installations may have binaries registered under wrong keys. They need to:
   ```bash
   # Delete old config entries pointing to wrong binaries
   # Re-download engine: spindb engines download {engine}
   ```

2. **Run all tests:**
   ```bash
   pnpm lint                    # TypeScript compilation
   pnpm test:unit              # Unit tests
   pnpm test:{engine}          # Integration tests for this engine
   pnpm test:mysql             # Verify no regression on similar engines
   ```

### Common Pitfalls

1. **Binary key conflicts:** Never register binaries under keys used by another engine. MariaDB must use `mariadb`, not `mysql`.

2. **Forgetting BaseEngine method:** If you add `get{Engine}ClientPath()` to the engine but not to `BaseEngine`, TypeScript will fail when test helpers call it.

3. **Shared test helper cases:** Don't combine engines in test helpers like `MySQL || MariaDB`. Each needs its own case calling its own client path method.

4. **Stale config.json:** After migration, old binary registrations may point to wrong paths. Clear and re-register.

5. **Missing `override` keyword:** When overriding BaseEngine methods, always use `override` keyword.
