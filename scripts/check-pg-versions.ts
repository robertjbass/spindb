#!/usr/bin/env tsx
/**
 * Check if new PostgreSQL major versions are available on zonky.io
 * that aren't yet supported by SpinDB.
 *
 * Exits with code 1 if new versions are found, 0 otherwise.
 * Used in pre-commit hook to alert developers when new PG versions are available.
 */

import { SUPPORTED_MAJOR_VERSIONS } from '../engines/postgresql/binary-urls'
import { platformService } from '../core/platform-service'

const TIMEOUT_MS = 10000
const MIN_SUPPORTED_MAJOR = 14 // Don't alert for ancient versions

async function checkForNewVersions(): Promise<void> {
  const zonkyPlatform = platformService.getZonkyPlatform()
  if (!zonkyPlatform) {
    // Can't check on unsupported platforms, skip silently
    console.log('Skipping PostgreSQL version check (unsupported platform)')
    process.exit(0)
  }

  const url = `https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${zonkyPlatform}/`

  console.log('Checking for new PostgreSQL versions on zonky.io...')

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      console.log(
        `Warning: Could not fetch zonky.io versions (HTTP ${response.status}), skipping check`,
      )
      process.exit(0)
    }

    const html = await response.text()

    // Parse version directories from the HTML listing
    // Format: <a href="14.15.0/">14.15.0/</a>
    const versionRegex = /href="(\d+)\.\d+\.\d+\/"/g
    const majorVersions = new Set<string>()
    let match

    while ((match = versionRegex.exec(html)) !== null) {
      const major = match[1]
      const majorNum = parseInt(major, 10)
      // Only consider versions >= MIN_SUPPORTED_MAJOR
      if (majorNum >= MIN_SUPPORTED_MAJOR) {
        majorVersions.add(major)
      }
    }

    // Find versions available on zonky.io but not in SUPPORTED_MAJOR_VERSIONS
    const supportedSet = new Set(SUPPORTED_MAJOR_VERSIONS)
    const newVersions = [...majorVersions]
      .filter((v) => !supportedSet.has(v))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))

    if (newVersions.length > 0) {
      console.error('\n' + '='.repeat(70))
      console.error('NEW POSTGRESQL VERSION(S) AVAILABLE ON ZONKY.IO!')
      console.error('='.repeat(70))
      console.error(`\nNew major version(s): ${newVersions.join(', ')}`)
      console.error(
        `Currently supported:  ${SUPPORTED_MAJOR_VERSIONS.join(', ')}`,
      )
      console.error('\nTo add support:')
      console.error('1. Add the new version to SUPPORTED_MAJOR_VERSIONS in:')
      console.error('   engines/postgresql/binary-urls.ts')
      console.error('2. Add a fallback version to FALLBACK_VERSION_MAP')
      console.error('3. Update config/defaults.ts if needed')
      console.error('4. Update documentation (README.md, CLAUDE.md)')
      console.error('\n' + '='.repeat(70) + '\n')
      process.exit(1)
    }

    console.log(
      `All available versions are supported (${SUPPORTED_MAJOR_VERSIONS.join(', ')})`,
    )
    process.exit(0)
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      console.log('Warning: Timeout checking zonky.io versions, skipping check')
    } else {
      console.log('Warning: Could not check zonky.io versions, skipping check')
    }
    process.exit(0)
  }
}

checkForNewVersions()
