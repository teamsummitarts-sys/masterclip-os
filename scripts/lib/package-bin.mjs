/**
 * Resolves a dependency's CLI entry script so it can be run as
 * `node <script>` on every platform.
 *
 * `node_modules/.bin/<name>` is a POSIX shell script. On Windows it is not an
 * executable, so spawning it without a shell fails with ENOENT — which is how
 * `pnpm typecheck` reported all 27 projects FAILED while `tsc` itself was
 * clean. Running the package's declared `bin` entry through the current Node
 * binary is exactly what the shim does on Linux, and it never depends on the
 * shims (or on `node` being on PATH) at all.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * @param {string} pkg   package name, e.g. 'typescript'
 * @param {string} [name] which bin when the package declares several; defaults to `pkg`
 * @returns {string} absolute path of the entry script
 */
export function packageBin(pkg, name = pkg) {
  // `<pkg>/package.json` is resolvable even when the package's `exports` map
  // hides the bin script itself (vite and tsx both do).
  const manifestPath = require.resolve(`${pkg}/package.json`)
  const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = typeof bin === 'string' ? bin : bin?.[name]
  if (!entry) throw new Error(`${pkg} does not declare a "${name}" bin in its package.json`)
  return join(dirname(manifestPath), entry)
}
