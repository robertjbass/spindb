#!/usr/bin/env node

import { register } from 'tsx/esm/api'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import { existsSync } from 'fs'

// Get the directory where this script is located
const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolve tsconfig path - it should be in the package root
const tsconfigPath = resolve(__dirname, '../tsconfig.json')

// Debug: Check if tsconfig exists
console.error('Debug: tsconfig path:', tsconfigPath)
console.error('Debug: tsconfig exists:', existsSync(tsconfigPath))

try {
  const tsconfig = require(tsconfigPath)
  console.error('Debug: tsconfig paths:', tsconfig.compilerOptions?.paths)
} catch (err) {
  console.error('Debug: Failed to read tsconfig:', err.message)
}

register({
  tsconfig: tsconfigPath,
})

await import('../src/bin/cli.ts')
