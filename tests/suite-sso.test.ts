import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestDb, type Db } from '@masterclip/database'
import { LocalStorage } from '@masterclip/asset-storage'
import { loadConfig, silentLogger } from '@masterclip/shared'
import { createRuntime, type Runtime } from '@masterclip/runtime'
import { HandoffRejected, verifyHandoff } from '@masterclip/auth'
import { buildServer, SESSION_COOKIE } from '../apps/api/src/server.js'

/**
 * Street Banker signs the hand-off in Python (itsdangerous). These two tokens
 * were minted by that library with the throwaway secret below, one small and
 * one long enough to be zlib-compressed, so the Node verifier is proved
 * against the real wire format rather than against itself.
 */
const SECRET = 'fixture-secret-not-a-real-one'
const ISSUED = 1789646498
const PLAIN =
  '.eJwVjDEOwCAMA__iGVViZWqfklKGSJAgCl2q_r3Jdj5bfvEgxYDFFxJWREBpxNUC7eeW1YRQK5YPw15JDPtwfy-eXjSdrOJDlezCmWna8fcDKCYb3Q.aqvWog._K6L-hzcgPxfMEtwUzYk5BLqxgU'
const ZIPPED =
  '.eJyrVipTsjLUUSrNTFGyUio1VNJRSs1NzMwBchIdkvSS84ECeYm5qUC-4yggGgBDrSAnMQ8YagVFoCAsLs0sAYVhbn5JZn4eKEzz85JBAiB2ZmIJMA5qATr0Z8g.aqvWog.R3VDMSCHxSq0AH0FfkUvPUMB9bA'

describe('verifyHandoff', () => {
  it('reads a token minted by Street Banker', () => {
    const who = verifyHandoff(PLAIN, SECRET, ['motion'], ISSUED + 5)
    expect(who).toMatchObject({ email: 'a@b.co', name: 'A', plan: 'pro', suite: 'motion', uid: 'u1' })
    expect(verifyHandoff(ZIPPED, SECRET, ['motion'], ISSUED + 5).name).toHaveLength(300)
  })

  it('refuses the wrong secret, a tampered token, an old token and another suite', () => {
    const reason = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return error instanceof HandoffRejected ? error.reason : 'threw something else'
      }
      return 'accepted'
    }
    expect(reason(() => verifyHandoff(PLAIN, 'another-secret', ['motion'], ISSUED))).toBe('bad signature')
    expect(reason(() => verifyHandoff(PLAIN.replace('eJwV', 'eJwW'), SECRET, ['motion'], ISSUED))).toBe('bad signature')
    expect(reason(() => verifyHandoff(PLAIN, SECRET, ['motion'], ISSUED + 121))).toBe('expired')
    expect(reason(() => verifyHandoff(PLAIN, SECRET, ['tour'], ISSUED))).toBe('wrong suite')
    expect(reason(() => verifyHandoff(undefined, SECRET, ['motion'], ISSUED))).toBe('no token')
  })
})

describe('GET /auth/street-banker', () => {
  let db: Db
  let runtime: Runtime
  let app: FastifyInstance
  let storageRoot: string

  beforeEach(async () => {
    db = await createTestDb()
    storageRoot = await mkdtemp(join(tmpdir(), 'masterclip-sso-test-'))
    const config = loadConfig(
      { NODE_ENV: 'test', MASTERCLIP_MODE: 'sandbox', LOG_LEVEL: 'error', STORAGE_LOCAL_ROOT: storageRoot, ASSET_SIGNING_SECRET: 'sso-test-secret', SESSION_SECRET: 'sso-test-session-secret' },
      true,
    )
    runtime = await createRuntime({ config, db, logger: silentLogger, mockOnly: true, storage: new LocalStorage({ root: storageRoot, signingSecret: 'sso-test-secret' }) })
    app = await buildServer({ runtime, logger: silentLogger })
    await app.ready()
  })

  afterEach(async () => {
    delete process.env.SUITE_SSO_SECRET
    await app.close()
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('refuses a bare visit plainly, and says so when the suite is not connected', async () => {
    const bare = await app.inject({ method: 'GET', url: '/auth/street-banker' })
    expect(bare.statusCode).toBe(401)
    expect(bare.body).toContain('needs a link from Street Banker')
    const unconnected = await app.inject({ method: 'GET', url: '/auth/street-banker?token=x' })
    expect(unconnected.statusCode).toBe(503)
  })

  it('refuses a token it cannot verify, with the way back', async () => {
    process.env.SUITE_SSO_SECRET = SECRET
    // The fixture tokens are long expired by wall-clock time, which is the point.
    const response = await app.inject({ method: 'GET', url: `/auth/street-banker?token=${PLAIN}` })
    expect(response.statusCode).toBe(401)
    expect(response.body).toContain('expired')
    expect(response.body).toContain('https://app.streetbankermusic.com/login')
    expect(response.cookies.find((c) => c.name === SESSION_COOKIE)).toBeUndefined()
  })

  it('a vouched email founds the organization once and reuses the account after', async () => {
    const first = await runtime.auth.sessionForVouchedEmail({ email: 'Artist@Example.com', displayName: 'Artist', orgId: (await runtime.projects.createOrg('Street Banker')).id, orgRole: 'owner' })
    expect(first.created).toBe(true)
    expect((await runtime.auth.resolve(first.token)).user.email).toBe('artist@example.com')
    const org = await runtime.db.get<{ id: string }>('SELECT id FROM orgs LIMIT 1')
    const again = await runtime.auth.sessionForVouchedEmail({ email: 'artist@example.com', displayName: 'Artist', orgId: String(org!.id), orgRole: 'member' })
    expect(again.created).toBe(false)
    expect(again.user.id).toBe(first.user.id)
    expect(again.user.orgRole).toBe('owner')
  })
})
