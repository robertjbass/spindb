#!/usr/bin/env node
/**
 * Flip the `hostdb` dependency from `file:../hostdb` (dev wiring) to an exact
 * pinned npm version (`0.31.0`). Run this AFTER hostdb has been published to
 * npm and BEFORE merging spindb to dev/main.
 *
 * Usage:
 *   node scripts/flip-hostdb-pin.mjs              # auto-detect target version
 *   node scripts/flip-hostdb-pin.mjs 0.31.0       # specify version explicitly
 *
 * What it does:
 *   1. Reads `../hostdb/package.json` to determine the target version (or
 *      uses the version argument).
 *   2. Verifies that version is actually published on npm (refuses to flip
 *      otherwise — saves you from a broken merge).
 *   3. Updates `spindb/package.json` dependencies.hostdb to the exact version.
 *   4. Runs `pnpm install` to regenerate pnpm-lock.yaml against the npm-hosted
 *      hostdb (no longer the local file: path).
 *   5. Runs the full test suite to verify behavior matches the local dev tree.
 *
 * Exits non-zero on any failure; the merge should not proceed.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const HOSTDB_PKG = join(ROOT, '..', 'hostdb', 'package.json')

function exec(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    ...opts,
  })
}

function execCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf-8',
    cwd: ROOT,
    ...opts,
  }).trim()
}

const targetVersionArg = process.argv[2]
let targetVersion = targetVersionArg

if (!targetVersion) {
  try {
    const hostdbPkg = JSON.parse(readFileSync(HOSTDB_PKG, 'utf-8'))
    targetVersion = hostdbPkg.version
    console.log(
      `Auto-detected target version from ${HOSTDB_PKG}: ${targetVersion}`,
    )
  } catch (err) {
    console.error(
      `Could not auto-detect hostdb version (no ../hostdb sibling?). ` +
        `Pass version explicitly: node scripts/flip-hostdb-pin.mjs 0.31.0`,
    )
    console.error(`Underlying error: ${err.message}`)
    process.exit(1)
  }
}

if (!/^\d+\.\d+\.\d+$/.test(targetVersion)) {
  console.error(`Target version must be exact semver (e.g., 0.31.0). Got: ${targetVersion}`)
  process.exit(2)
}

console.log(`\nVerifying hostdb@${targetVersion} exists on npm...`)
try {
  const published = execCapture('npm', ['view', `hostdb@${targetVersion}`, 'version'])
  if (published !== targetVersion) {
    throw new Error(`npm returned ${published}, not ${targetVersion}`)
  }
  console.log(`  ✓ hostdb@${targetVersion} is published on npm`)
} catch (err) {
  console.error(
    `\n✗ hostdb@${targetVersion} is NOT on npm yet. The publish workflow needs to complete first.`,
  )
  console.error(
    `  Check: gh workflow view publish.yml (in ~/dev/hostdb)`,
  )
  console.error(`  Or:    npm view hostdb version  (should return ${targetVersion})`)
  console.error(`\nUnderlying error: ${err.message}`)
  process.exit(3)
}

console.log(`\nUpdating package.json: hostdb -> ${targetVersion} (exact pin)...`)
const pkgPath = join(ROOT, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
const previous = pkg.dependencies.hostdb
if (previous === targetVersion) {
  console.log(`  hostdb is already pinned to ${targetVersion}; nothing to do`)
  process.exit(0)
}
pkg.dependencies.hostdb = targetVersion
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
console.log(`  ${previous} -> ${targetVersion}`)

console.log(`\nRegenerating pnpm-lock.yaml...`)
exec('pnpm', ['install'])

console.log(`\nRunning test suite...`)
exec('pnpm', ['lint'])
exec('pnpm', ['test:unit'])
exec('pnpm', ['test:hostdb-sync'])

console.log(`\n✓ Done. Review the diff, then:`)
console.log(
  `  git add package.json pnpm-lock.yaml && git commit -m "chore(deps): pin hostdb ${targetVersion}"`,
)
console.log(`  git push`)
console.log(`\nNow safe to merge upgrade/spindb-hostdb-integration -> dev -> main.`)
