#!/usr/bin/env node
/**
 * Production build.
 *
 * The API, worker, and CLI are bundled with esbuild into single files (which is
 * why migrations are inlined TypeScript rather than loose .sql — no runtime
 * file lookups). The web app is built by Vite and served by the API, so a
 * deployment is one process plus one worker.
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageBin } from './lib/package-bin.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'dist'), { recursive: true })

const targets = [
  { entry: 'apps/api/src/main.ts', out: 'dist/api.js' },
  { entry: 'apps/worker/src/main.ts', out: 'dist/worker.js' },
  { entry: 'apps/cli/src/main.ts', out: 'dist/masterclip.js' },
  // Bundled so a deployment can seed before it is reachable, without shipping
  // tsx and the TypeScript sources to production.
  { entry: 'scripts/seed.ts', out: 'dist/seed.js' },
]

for (const target of targets) {
  await build({
    entryPoints: [join(root, target.entry)],
    outfile: join(root, target.out),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    // Native and optional deps stay external; everything workspace-internal is
    // bundled so the output has no @masterclip/* resolution at runtime.
    external: ['pg', 'pg-native', 'node:sqlite', 'fsevents'],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  })
  console.log(`built ${target.out}`)
}

execFileSync(process.execPath, [packageBin('vite'), 'build'], { cwd: join(root, 'apps/web'), stdio: 'inherit' })
console.log('built apps/web/dist')
