#!/usr/bin/env node
/**
 * Boots the API for browser tests against a throwaway database, serving the
 * production web build. Renders go to the mock provider, so the suite exercises
 * the shipping code path without spending anything.
 */
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packageBin } from './lib/package-bin.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'masterclip-e2e-'))
const port = process.env.E2E_PORT ?? '4399'

const webDist = join(root, 'apps/web/dist')
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('web build missing — run `pnpm -F @masterclip/web build` first')
  process.exit(1)
}

// The screenshot run needs renders to actually complete, so start a worker too.
const children = []
const spawnService = (entry) =>
  spawn(process.execPath, [packageBin('tsx'), entry], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    MASTERCLIP_MODE: 'sandbox',
    LOG_LEVEL: 'warn',
    API_PORT: port,
    API_HOST: '127.0.0.1',
    SQLITE_PATH: join(scratch, 'e2e.sqlite'),
    STORAGE_LOCAL_ROOT: join(scratch, 'storage'),
    ASSET_SIGNING_SECRET: 'e2e-asset-signing-secret',
    SESSION_SECRET: 'e2e-session-secret',
    WEB_ROOT: webDist,
    // Providers stay unconfigured: only the mock is usable, which is the point.
    MUAPI_API_KEY: '',
    GOOGLE_API_KEY: '',
    FAL_KEY: '',
    ANTHROPIC_API_KEY: '',
  },
})

children.push(spawnService('apps/api/src/main.ts'))
if (process.env.CAPTURE_SCREENSHOTS) children.push(spawnService('apps/worker/src/main.ts'))

const stop = (signal) => { for (const c of children) c.kill(signal) }
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
children[0].on('exit', (code) => { stop('SIGTERM'); process.exit(code ?? 0) })
