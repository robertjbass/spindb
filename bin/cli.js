#!/usr/bin/env node

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Path to the main TypeScript entry point and package root
const packageRoot = join(__dirname, '..')
const mainScript = join(packageRoot, 'cli', 'bin.ts')

// Use Node.js with tsx as ESM loader
// This approach works reliably on all platforms because:
// 1. We use process.execPath (always the current Node.js executable)
// 2. We use --import with tsx's ESM loader module
// 3. Arguments pass through without shell interpretation (shell: false)
// 4. Works on Windows without needing to spawn .cmd files

// Find tsx ESM loader - check common paths
const tsxLoaderPaths = [
  join(packageRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs'),
  join(packageRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
]

const tsxLoader = tsxLoaderPaths.find((p) => existsSync(p))

if (!tsxLoader) {
  console.error('Error: tsx loader not found.')
  console.error('Searched paths:')
  tsxLoaderPaths.forEach((p) => console.error(`  - ${p}`))
  console.error('\nTry running: pnpm install')
  process.exit(1)
}

// Convert to file URL for --import (required on Windows)
const tsxLoaderUrl = pathToFileURL(tsxLoader).href

const child = spawn(
  process.execPath,
  ['--import', tsxLoaderUrl, mainScript, ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    shell: false,
    cwd: packageRoot,
  },
)

// Forward exit code
child.on('exit', (code) => {
  process.exit(code ?? 0)
})

// Handle errors
child.on('error', (err) => {
  console.error('Failed to start spindb:', err.message)
  process.exit(1)
})
