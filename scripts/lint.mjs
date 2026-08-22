#!/usr/bin/env node
/**
 * Repo guard.
 *
 * Runs the type checker plus the checks a linter would not catch and that
 * actually matter here: no committed secrets, no shell-string command
 * construction in the media layer, no SQL built by string concatenation from
 * values, and no provider adapter fabricating a price.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'var', 'coverage', 'test-results', 'playwright-report'])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (['.ts', '.tsx', '.mjs', '.js', '.json', '.env'].includes(extname(entry))) out.push(full)
  }
  return out
}

const files = walk(root)
const problems = []

const SECRET_PATTERNS = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
  { name: 'bearer literal', re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{24,}/ },
]

for (const file of files) {
  const rel = relative(root, file)
  const content = readFileSync(file, 'utf8')

  // Test fixtures legitimately need strings shaped like credentials. The
  // exemption is an explicit, greppable marker on the same line, so it shows up
  // in a diff rather than being an invisible carve-out for test directories —
  // which is exactly how real keys end up committed in tests.
  for (const pattern of SECRET_PATTERNS) {
    for (const [index, line] of content.split('\n').entries()) {
      if (!pattern.re.test(line)) continue
      if (line.includes('lint-allow-secret-fixture')) continue
      problems.push(`${rel}:${index + 1}: possible committed secret (${pattern.name})`)
    }
  }

  // The media layer must never build a shell string: prompts and filenames
  // flow through it and both can contain shell metacharacters.
  if (rel.startsWith('packages/media-tools') && /\b(exec|execSync)\s*\(/.test(content) && !/execFile/.test(content)) {
    problems.push(`${rel}: uses exec() — media commands must use execFile with an argv array`)
  }

  // SQL values must be bound, never interpolated. Composing *structure* —
  // sanitized identifiers, pre-built WHERE fragments, `?` placeholder runs,
  // and integer-clamped LIMITs — is legitimate and allowlisted by name, so the
  // guard still catches an interpolated value without flagging every query.
  const SAFE_SQL_INTERPOLATION = [
    // A sanitized identifier, an integer-clamped LIMIT, or a composed fragment.
    /^\s*(assertIdent\(|Math\.(floor|max|min)\()/,
    /^\s*[A-Za-z_$][\w$.]*\.(join|map)\(/,
    /^\s*(where|clauses?|setClause|placeholders?|cols?|column|table|idColumn|conflict|updates|sub|prefix|orderBy|limit)\b/,
    // A ternary choosing between two SQL *literals* — no caller value reaches the string.
    /^[^'"`]*\?\s*(''|'[^']*')\s*:\s*(''|'[^']*')\s*$/,
  ]
  // Only server-side code builds SQL; the web app's template literals contain
  // words like "Create project" that would otherwise trip this.
  const buildsSql = rel.startsWith('packages/') || rel.startsWith('apps/api/') || rel.startsWith('apps/worker/') || rel.startsWith('apps/cli/')
  const SQL_SIGNATURE = /\b(SELECT\s+[\w*(]|INSERT\s+INTO\s+\w|UPDATE\s+\w+\s+SET|DELETE\s+FROM\s+\w|CREATE\s+(TABLE|INDEX|UNIQUE))/i
  if (buildsSql) {
    for (const template of content.matchAll(/`([^`]*)`/gs)) {
      const body = template[1] ?? ''
      if (!SQL_SIGNATURE.test(body)) continue
      for (const interpolation of body.matchAll(/\$\{([^}]*)\}/g)) {
        const expression = interpolation[1] ?? ''
        if (SAFE_SQL_INTERPOLATION.some((pattern) => pattern.test(expression))) continue
        problems.push(`${rel}: SQL interpolates \`${expression.trim()}\` — use a bound parameter`)
      }
    }
  }

  // A provider adapter that returns a confident zero price would make itself
  // win every routing decision on cost.
  if (/packages\/provider-(?!core|mock)/.test(rel) && /estimatedMicros:\s*0\b/.test(content) && !/confidence:\s*'unknown'/.test(content)) {
    problems.push(`${rel}: returns a zero price without marking the quote confidence as 'unknown'`)
  }
}

if (readFileSync(join(root, '.gitignore'), 'utf8').includes('.env') === false) {
  problems.push('.gitignore does not ignore .env')
}

process.stdout.write(`checked ${files.length} files\n`)
if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`  ${problem}\n`)
  process.stderr.write(`\n${problems.length} guard failure(s)\n`)
  process.exit(1)
}

execFileSync(process.execPath, [join(root, 'scripts/typecheck.mjs')], { stdio: 'inherit', cwd: root })
process.stdout.write('lint clean\n')
