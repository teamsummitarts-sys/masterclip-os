import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AppError,
  applyEnvFile,
  applyRate,
  backoffDelayMs,
  canonicalJson,
  decideRetry,
  divideMicros,
  formatUsd,
  hashObject,
  isTransient,
  maskSecret,
  microsToUsd,
  redact,
  redactUrl,
  registerSecret,
  retryCostsMoney,
  safeEqual,
  sumMicros,
  usdToMicros,
} from '../src/index.js'

describe('money', () => {
  it('keeps per-second rates exact across a large batch', () => {
    // $0.05/s × 8s × 500 clips. In floating-point dollars this drifts; the
    // whole point of micro-USD integers is that it does not.
    const perSecond = usdToMicros(0.05)
    const perClip = applyRate(perSecond, 8)
    const total = sumMicros(Array.from({ length: 500 }, () => perClip))
    expect(perClip).toBe(400_000)
    expect(total).toBe(200_000_000)
    expect(microsToUsd(total)).toBe(200)
  })

  it('handles sub-cent rates without rounding to zero', () => {
    expect(usdToMicros(0.0008)).toBe(800)
    expect(applyRate(800, 7.5)).toBe(6000)
    expect(formatUsd(6000)).toBe('$0.0060')
  })

  it('returns null rather than Infinity when there is no denominator', () => {
    // A cost-per-approved-second with zero approvals must read "no data yet",
    // never a number.
    expect(divideMicros(1_000_000, 0)).toBeNull()
    expect(divideMicros(1_000_000, 4)).toBe(250_000)
  })
})

describe('canonical hashing', () => {
  it('hashes structurally identical payloads identically regardless of key order', () => {
    const a = { model: 'x', params: { b: 2, a: 1 }, list: [1, 2] }
    const b = { list: [1, 2], params: { a: 1, b: 2 }, model: 'x' }
    expect(hashObject(a)).toBe(hashObject(b))
  })

  it('drops undefined so an absent field and an explicit undefined agree', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  it('distinguishes genuinely different requests', () => {
    expect(hashObject({ duration: 8 })).not.toBe(hashObject({ duration: 10 }))
  })
})

describe('retry classification', () => {
  it('retries rate limits and outages but not validation errors', () => {
    expect(isTransient(new AppError({ kind: 'provider_rate_limited', message: 'slow down' }))).toBe(true)
    expect(isTransient(new AppError({ kind: 'provider_unavailable', message: 'down' }))).toBe(true)
    expect(isTransient(new AppError({ kind: 'validation', message: 'bad' }))).toBe(false)
    expect(isTransient(new AppError({ kind: 'provider_rejected', message: 'unsafe' }))).toBe(false)
  })

  it('never auto-retries a failed generation, because that would re-spend', () => {
    const failed = new AppError({ kind: 'provider_failed', message: 'generation failed' })
    expect(isTransient(failed)).toBe(false)
    expect(retryCostsMoney(failed)).toBe(true)
    expect(decideRetry(failed, 1, 5).retry).toBe(false)
  })

  it("prefers the provider's own Retry-After over our curve", () => {
    const err = new AppError({ kind: 'provider_rate_limited', message: 'wait', retryAfterSeconds: 42 })
    const decision = decideRetry(err, 1, 5)
    expect(decision.retry).toBe(true)
    expect(decision.delayMs).toBe(42_000)
    expect(decision.reason).toContain('Retry-After')
  })

  it('backs off exponentially and jitters', () => {
    const noJitter = (attempt: number) => backoffDelayMs(attempt, { baseMs: 1000, jitter: 0 })
    expect(noJitter(1)).toBe(1000)
    expect(noJitter(2)).toBe(2000)
    expect(noJitter(3)).toBe(4000)
    expect(noJitter(20)).toBe(300_000)

    // Full jitter must actually spread, or every worker wakes together.
    const samples = new Set(Array.from({ length: 40 }, () => backoffDelayMs(4, { baseMs: 1000 })))
    expect(samples.size).toBeGreaterThan(20)
  })

  it('stops at the attempt ceiling', () => {
    const err = new AppError({ kind: 'timeout', message: 'slow' })
    expect(decideRetry(err, 5, 5).retry).toBe(false)
  })
})

describe('secret redaction', () => {
  it('redacts by key name and by registered value', () => {
    registerSecret('sk-ant-super-secret-value-1234') // lint-allow-secret-fixture
    const scrubbed = redact({
      authorization: 'Bearer abc',
      note: 'the key sk-ant-super-secret-value-1234 leaked into a message', // lint-allow-secret-fixture
      nested: { api_key: 'zzz', fine: 'ok' },
    })
    expect(JSON.stringify(scrubbed)).not.toContain('sk-ant-super-secret-value-1234') // lint-allow-secret-fixture
    expect(JSON.stringify(scrubbed)).not.toContain('Bearer abc')
    expect(JSON.stringify(scrubbed)).toContain('ok')
  })

  it('masks enough to identify a key and not enough to use it', () => {
    const masked = maskSecret('abcdefghijklmnop')
    expect(masked).toContain('abcd')
    expect(masked).not.toContain('efghijklmn')
    expect(maskSecret('')).toBe('(unset)')
  })

  it('strips query strings from URLs, which carry signed tokens', () => {
    expect(redactUrl('https://api.example.com/v1/jobs?token=secret123')).toBe('https://api.example.com/v1/jobs?[REDACTED]')
  })
})

describe('constant-time compare', () => {
  it('matches equal strings and rejects unequal ones without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcdef')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('.env file application', () => {
  const envFile = (content: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'masterclip-env-')), '.env')
    writeFileSync(path, content)
    return path
  }

  it('applies file values and reports names, not values', () => {
    const path = envFile('GOOGLE_API_KEY=from-file\n# comment\nLOG_LEVEL="debug"\n')
    const target: NodeJS.ProcessEnv = {}
    const applied = applyEnvFile(path, target)
    expect(target.GOOGLE_API_KEY).toBe('from-file')
    expect(target.LOG_LEVEL).toBe('debug')
    expect(applied.sort()).toEqual(['GOOGLE_API_KEY', 'LOG_LEVEL'])
    expect(applied.join(' ')).not.toContain('from-file')
  })

  it('never overrides a variable the real environment already set', () => {
    // Same precedence as `node --env-file`: a stray checkout file must not be
    // able to redirect a deployment whose configuration comes from real env.
    const path = envFile('GOOGLE_BASE_URL=https://attacker.example\nGOOGLE_API_KEY=file-key\n')
    const target: NodeJS.ProcessEnv = { GOOGLE_BASE_URL: 'https://generativelanguage.googleapis.com' }
    const applied = applyEnvFile(path, target)
    expect(target.GOOGLE_BASE_URL).toBe('https://generativelanguage.googleapis.com')
    expect(target.GOOGLE_API_KEY).toBe('file-key')
    expect(applied).toEqual(['GOOGLE_API_KEY'])
  })

  it('is a no-op without a file, so a clean checkout and production behave as before', () => {
    const target: NodeJS.ProcessEnv = { LOG_LEVEL: 'info' }
    expect(applyEnvFile(join(tmpdir(), 'masterclip-env-none', '.env'), target)).toEqual([])
    expect(target).toEqual({ LOG_LEVEL: 'info' })
  })
})
