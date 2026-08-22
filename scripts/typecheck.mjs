#!/usr/bin/env node
// Runs `tsc --noEmit` over every workspace package that has a tsconfig.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageBin } from './lib/package-bin.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tsc = packageBin('typescript', 'tsc')
const projects = []
for (const group of ['packages', 'apps']) {
  const base = join(root, group)
  if (!existsSync(base)) continue
  for (const entry of readdirSync(base)) {
    const tsconfig = join(base, entry, 'tsconfig.json')
    if (existsSync(tsconfig)) projects.push(`${group}/${entry}`)
  }
}

let failed = 0
for (const project of projects) {
  process.stdout.write(`typecheck ${project} … `)
  try {
    execFileSync(process.execPath, [tsc, '--noEmit', '-p', join(root, project, 'tsconfig.json')], {
      cwd: root,
      stdio: 'pipe',
    })
    process.stdout.write('ok\n')
  } catch (err) {
    failed++
    process.stdout.write('FAILED\n')
    process.stdout.write(String(err.stdout ?? '') + String(err.stderr ?? '') + '\n')
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${projects.length} projects failed typecheck`)
  process.exit(1)
}
console.log(`\nall ${projects.length} projects typecheck clean`)
