import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { inflateSync } from 'node:zlib'

/**
 * Street Banker's suite sign-in hand-off, verifier side.
 *
 * Street Banker (app.streetbankermusic.com) is the account of record for every
 * suite. It sends the person across with a short-lived signed token; this
 * module checks that token. The token is minted in Python by itsdangerous'
 * URLSafeTimedSerializer (sb_suite_sso.py), so the wire format here is that
 * library's, reproduced exactly:
 *
 *   [.]base64url(payload) . base64url(timestamp) . base64url(HMAC-SHA1)
 *
 * a leading "." means the JSON payload is zlib-compressed; the timestamp is
 * big-endian seconds since the epoch; the key is SHA1(salt + "signer" + secret)
 * and the signature covers "payload.timestamp".
 */
export const SUITE_SSO_SALT = 'street-banker-suite-sso-v1'
export const SUITE_SSO_MAX_AGE_SECONDS = 120

export type HandoffRejection = 'no token' | 'bad signature' | 'expired' | 'wrong suite' | 'malformed'

export class HandoffRejected extends Error {
  constructor(readonly reason: HandoffRejection) {
    super(`hand-off rejected: ${reason}`)
  }
}

export interface HandoffIdentity {
  uid: string
  email: string
  name: string
  plan: string
  suite: string
}

const fromB64Url = (value: string): Buffer => Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
const toB64Url = (value: Buffer): string => value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function verifyHandoff(
  token: string | undefined,
  secret: string,
  acceptedSuites: readonly string[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): HandoffIdentity {
  if (!token) throw new HandoffRejected('no token')
  const lastDot = token.lastIndexOf('.')
  const signed = token.slice(0, lastDot)
  const stampDot = signed.lastIndexOf('.')
  if (lastDot < 1 || stampDot < 1) throw new HandoffRejected('bad signature')

  const key = createHash('sha1').update(`${SUITE_SSO_SALT}signer${secret}`).digest()
  const expected = createHmac('sha1', key).update(signed).digest()
  const given = fromB64Url(token.slice(lastDot + 1))
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new HandoffRejected('bad signature')
  // Round-trip the signature so a non-canonical base64 spelling is refused too.
  if (toB64Url(given) !== token.slice(lastDot + 1)) throw new HandoffRejected('bad signature')

  const stamp = fromB64Url(signed.slice(stampDot + 1))
  let issued = 0
  for (const byte of stamp) issued = issued * 256 + byte
  if (nowSeconds - issued > SUITE_SSO_MAX_AGE_SECONDS || issued - nowSeconds > 30) throw new HandoffRejected('expired')

  let body = signed.slice(0, stampDot)
  let payload: Record<string, unknown>
  try {
    const compressed = body.startsWith('.')
    if (compressed) body = body.slice(1)
    const raw = compressed ? inflateSync(fromB64Url(body)) : fromB64Url(body)
    payload = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
  } catch {
    throw new HandoffRejected('malformed')
  }
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  const suite = typeof payload.suite === 'string' ? payload.suite : ''
  if (payload.v !== 1 || !email.includes('@')) throw new HandoffRejected('malformed')
  if (!acceptedSuites.includes(suite)) throw new HandoffRejected('wrong suite')
  return {
    uid: String(payload.uid ?? ''),
    email,
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : email.split('@')[0]!,
    plan: typeof payload.plan === 'string' ? payload.plan : '',
    suite,
  }
}
