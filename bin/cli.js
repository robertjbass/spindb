#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Path to the main TypeScript entry point
const mainScript = join(__dirname, '..', 'cli', 'bin.ts')

// Detect Windows
const isWindows = process.platform === 'win32'

// Use tsx to execute the TypeScript file
// On Windows, npm creates tsx.cmd which can be spawned directly without shell: true
// Using shell: true would cause argument parsing issues with special characters (semicolons, quotes, etc.)
const tsxBase = join(__dirname, '..', 'node_modules', '.bin', 'tsx')
const tsxPath = isWindows && existsSync(tsxBase + '.cmd') ? tsxBase + '.cmd' : tsxBase

// Spawn tsx process with the main script and pass through all arguments
// Keep shell: false to preserve argument integrity (especially important for SQL statements)
const child = spawn(tsxPath, [mainScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: false,
})

// Forward exit code
child.on('exit', (code) => {
  process.exit(code ?? 0)
})

// Handle errors
child.on('error', (err) => {
  console.error('Failed to start spindb:', err.message)
  process.exit(1)
})
