# SpinDB Style Guide

This document outlines the coding conventions and style guidelines for the SpinDB project. All contributors should follow these guidelines to maintain consistency across the codebase.

## TypeScript

Always use TypeScript instead of JavaScript unless specifically directed otherwise.

## Type Definitions

- Always use `type` instead of `interface` for type definitions
- Keep types close to the functions/modules they're used with (don't create separate `types.ts` files just to store types)

```ts
// Good
type UserConfig = {
  name: string
  port: number
}

// Avoid
interface UserConfig {
  name: string
  port: number
}
```

## Type Imports

Use explicit `type` keyword for type imports. This is enforced by ESLint via `@typescript-eslint/consistent-type-imports`.

```ts
// Good: Pure type imports
import type { ContainerConfig, BackupFormat } from '../types'

// Good: Mixed imports with inline type
import { Engine, type ContainerConfig } from '../types'

// Avoid: Types without explicit type keyword
import { ContainerConfig, BackupFormat } from '../types'
```

## Function Definitions

- Use `function` keyword for named functions
- Use arrow functions only for:
  - Anonymous callbacks
  - Inline functions passed to methods
  - IIFEs (Immediately Invoked Function Expressions)

```ts
// Good: Named function
function getUserById(id: string): User {
  return users.find((u) => u.id === id)
}

// Good: Arrow function for callback
const activeUsers = users.filter((user) => user.isActive)

// Good: Arrow function for inline handler
button.addEventListener('click', () => handleClick())

// Good: IIFE
const config = (() => {
  const env = process.env.NODE_ENV
  return env === 'production' ? prodConfig : devConfig
})()

// Avoid: Arrow function for named function
const getUserById = (id: string): User => {
  return users.find((u) => u.id === id)
}
```

## Options Objects Pattern

Prefer options objects over multiple function parameters for better readability and flexibility.

- Multiple positional parameters obscure argument meaning and require remembering order
- Options objects are self-documenting and easier to extend
- Exception: If a function has a clear "primary" argument, use it as the first positional parameter followed by an options object

```ts
// Good: Primary argument + options
function findContainer(name: string, options: { engine?: Engine; includeDeleted?: boolean })

// Good: All options (no clear primary)
function createBackup(options: { container: string; format: BackupFormat; outputPath: string })

// Avoid: Multiple positional parameters
function findContainer(name: string, engine: Engine, includeDeleted: boolean)
```

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | `user-service.ts`, `api-helpers.ts` |
| Functions/Variables | camelCase | `getUserById`, `isActive` |
| Types | PascalCase | `UserConfig`, `ApiResponse` |
| Constants | SCREAMING_SNAKE_CASE | `DEFAULT_TIMEOUT`, `MAX_RETRIES` |

## Error Handling

- Always use `error` (not `err`) in catch blocks
- Always use `try/catch` with `await`, never `.then()` chains
- Error messages should include actionable fix suggestions
- Use `SpinDBError` class for domain-specific errors

```ts
// Good
try {
  await startContainer(name)
} catch (error) {
  const e = error as Error
  console.error(`Failed to start container: ${e.message}`)
}

// Avoid
try {
  await startContainer(name)
} catch (err) {
  console.error(err)
}

// Good: Actionable error message
throw new SpinDBError(
  'CONTAINER_NOT_FOUND',
  `Container "${name}" not found`,
  'error',
  `Run "spindb list" to see available containers`
)
```

## Async/Await

- Always use `await` instead of `.then()` chains
- Use `Promise.all()` for concurrent operations

```ts
// Good
async function loadContainers(): Promise<Container[]> {
  const configs = await readConfigs()
  return configs.map(parseContainer)
}

// Good: Concurrent operations
const [containers, engines] = await Promise.all([
  loadContainers(),
  loadEngines(),
])

// Avoid
function loadContainers(): Promise<Container[]> {
  return readConfigs().then((configs) => configs.map(parseContainer))
}
```

## Import Organization

Organize imports in the following order:
1. Node.js standard library
2. External packages
3. Internal modules
4. Types

```ts
// Node.js stdlib
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

// External packages
import chalk from 'chalk'
import { Command } from 'commander'

// Internal modules
import { containerManager } from '../core/container-manager'
import { getEngine } from '../engines'

// Types
import type { ContainerConfig } from '../types'
```

## Module Patterns

- Use ESM (`"type": "module"` in package.json)
- Use `import/export` syntax (not CommonJS `require/module.exports`)
- Singleton pattern: class instantiation, exported at module end
- Abstract base classes for polymorphism
- **No barrel files**: Import modules directly from their source file. Do not create files that only re-export modules (e.g., `index.ts` files that just re-export from other files)

```ts
// Singleton pattern
export class ContainerManager {
  async create(name: string, options: CreateOptions): Promise<ContainerConfig> {
    // ...
  }
}

export const containerManager = new ContainerManager()
```

### Layer Separation

The codebase follows a clear layer separation:

```
cli/     → User interface (commands, menus, prompts)
core/    → Business logic (managers, services)
engines/ → Database engine implementations
config/  → Configuration and paths
types/   → TypeScript type definitions
```

Dependencies flow downward: `cli/` → `core/` → `engines/` → `config/` → `types/`

## CLI-Specific Patterns

- **Commander.js** for command structure
- **Inquirer.js** for interactive prompts
- **Chalk** for colors
- **Ora** for spinners

### CLI-First Design

All functionality must be available via command-line arguments. Interactive menus are syntactic sugar for CLI commands.

```bash
# These should be equivalent:
spindb create mydb -p 5433              # CLI
spindb → Create container → mydb → 5433 # Interactive
```

### Menu Navigation

- Submenus have "Back" and "Back to main menu" options
- Use consistent icons:
  - Back: `${chalk.blue('←')} Back`
  - Main menu: `${chalk.blue('⌂')} Back to main menu`

### Engine Icons

Engine icons are managed in `cli/constants.ts`. Always use `getEngineIcon(engine)` to get properly padded icons - never use raw emojis directly.

```ts
import { getEngineIcon } from '../constants'

// Good - uses terminal-aware padding and respects user preferences
const display = `${getEngineIcon('postgresql')}PostgreSQL`

// Bad - raw emoji causes alignment issues
const display = `🐘 PostgreSQL`
```

#### Icon Modes

SpinDB supports three icon display modes, configurable via Settings menu or `SPINDB_ICONS` environment variable:

| Mode | Description | Example |
|------|-------------|---------|
| `ascii` (default) | Colored ASCII badges (background + text colors) | `[PG]` with blue background |
| `nerd` | Nerd Font glyphs with brand colors | PostgreSQL elephant in blue |
| `emoji` | Original emoji icons (no coloring) | 🐘 |

**Priority order for icon mode:**
1. `SPINDB_ICONS` environment variable (overrides config for dev testing)
2. Config value from `~/.spindb/config.json` (`preferences.iconMode`)
3. Default: `ascii`

#### ASCII Mode with Brand Colors

In ASCII mode, icons display with database brand colors using `chalk.bgHex().hex()`:

```ts
// ENGINE_BRAND_COLORS in cli/constants.ts
{
  [Engine.PostgreSQL]: { foreground: '#FFFFFF', background: '#336791' }, // White on blue
  [Engine.MySQL]: { foreground: '#FFFFFF', background: '#00758F' },      // White on blue
  // ...
}
```

The `foreground` color is the text color and `background` is the background color.

#### Emoji Mode Caveats

Terminal emulators render emoji widths inconsistently:
- Ghostty, iTerm2: Most emojis = 2 cells, but 🛋 ⏱ = 1 cell
- VS Code: 🪶 🦭 🪳 🛋 ⏱ = 1 cell, others = 2 cells

`getEngineIcon()` detects the terminal and adds appropriate padding for consistent alignment.

**Note**: `config/engines.json` also has `icon` fields for metadata purposes, but `cli/constants.ts` is the source of truth for CLI rendering.

### Transactional Operations

If a multi-step operation fails partway through, clean up and don't leave partial state behind. Use `TransactionManager` for rollback support.

## Logging & Output

- Use centralized log functions (`logError`, `logWarning`, `logInfo`, `logDebug`)
- No direct `console.log()` for errors in production code
- Use Ora spinners for long-running operations

```ts
// Good
const spinner = ora('Starting container...').start()
try {
  await startContainer(name)
  spinner.succeed('Container started')
} catch (error) {
  spinner.fail('Failed to start container')
  logError(error)
}
```

## Validation

- Create dedicated validation functions that throw descriptive errors
- Pair `isValid*` boolean functions with `assertValid*` throwing functions

```ts
function isValidDatabaseName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)
}

function assertValidDatabaseName(name: string): void {
  if (!isValidDatabaseName(name)) {
    throw new SpinDBError(
      'INVALID_DATABASE_NAME',
      `Invalid database name: "${name}"`,
      'error',
      'Database names must start with a letter and contain only letters, numbers, and underscores'
    )
  }
}
```

## Comments

Code should be self-documenting through clear naming. Avoid unnecessary comments:

- **No file header comments** unless the file's purpose is genuinely ambiguous from its name and contents
- **No JSDoc for one-liners**: Don't use JSDoc-style `/** */` for single-line comments; use `//` instead
- **No obvious comments**: Don't comment functions/variables that are self-evident from their names
- **Only comment the "why"**: Add comments only when the reasoning isn't clear from the code itself

```ts
// Avoid: File header that restates the filename
/**
 * Container Manager
 * Handles container operations
 */

// Avoid: JSDoc for a one-line comment
/** Increment the counter */
count++

// Avoid: Comment that restates the code
// Get the user by ID
const user = getUserById(id)

// Good: Comment explains non-obvious reasoning
// Skip validation for cloned containers since source was already validated
if (container.clonedFrom) return

// Good: Complex logic that benefits from explanation
/**
 * Migrate old container configs to include databases array.
 * Ensures primary database is always in the databases array.
 */
async function migrateConfig(config: ContainerConfig): Promise<ContainerConfig> {
  // ...
}
```

## Package Manager

Use `pnpm` / `pnpx` (not npm/yarn/npx).

```bash
# Good
pnpm install
pnpm run start
pnpx tsx script.ts

# Avoid
npm install
npx tsx script.ts
```

## Git Commits

Use Conventional Commits format:

- `feat:` - New feature
- `fix:` - Bug fix
- `chore:` - Maintenance tasks
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests

```bash
git commit -m "feat: Add database backup command" -m "Supports PostgreSQL and MySQL with multiple output formats"
```
