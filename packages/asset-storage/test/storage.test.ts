import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalStorage, S3Storage, objectKey, sanitizeFilename, signingKey, uriEncode, verifySignedUrl } from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'masterclip-storage-test-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const SECRET = 'test-signing-secret'

describe('local storage', () => {
  it('stores, hashes and reads back an object', async () => {
    const storage = new LocalStorage({ root, signingSecret: SECRET })
    const stored = await storage.putBuffer('proj/kind/id/file.mp4', new TextEncoder().encode('hello'), { contentType: 'video/mp4' })
    expect(stored.bytes).toBe(5)
    expect(stored.sha256).toHaveLength(64)
    expect(new TextDecoder().decode(await storage.getBuffer(stored.key))).toBe('hello')
    expect(await storage.exists(stored.key)).toBe(true)
    await storage.delete(stored.key)
    expect(await storage.exists(stored.key)).toBe(false)
  })

  it('refuses a key that escapes the storage root', async () => {
    const storage = new LocalStorage({ root, signingSecret: SECRET })
    await expect(storage.putBuffer('../../etc/passwd', new Uint8Array([1]))).rejects.toThrow(/invalid storage key/)
    await expect(storage.getBuffer('../../../etc/hosts')).rejects.toThrow(/invalid storage key/)
  })

  it('requires a signing secret — an unsigned asset URL is a public one', () => {
    expect(() => new LocalStorage({ root, signingSecret: '' })).toThrow(/signingSecret/)
  })
})

describe('signed asset URLs', () => {
  it('accepts a valid signature and rejects a tampered key', async () => {
    const storage = new LocalStorage({ root, signingSecret: SECRET, now: () => 1_000_000 })
    const url = await storage.signedUrl('proj/a/b/file.mp4', 60)
    const params = Object.fromEntries(new URL(url, 'http://x').searchParams)

    expect(verifySignedUrl(SECRET, params, 1_000_000)).toBe('proj/a/b/file.mp4')
    expect(() => verifySignedUrl(SECRET, { ...params, key: 'proj/other/file.mp4' }, 1_000_000)).toThrow(/invalid asset signature/)
    expect(() => verifySignedUrl('different-secret', params, 1_000_000)).toThrow(/invalid asset signature/)
  })

  it('rejects an expired link', async () => {
    const storage = new LocalStorage({ root, signingSecret: SECRET, now: () => 1_000_000 })
    const url = await storage.signedUrl('proj/a/b/file.mp4', 60)
    const params = Object.fromEntries(new URL(url, 'http://x').searchParams)
    expect(() => verifySignedUrl(SECRET, params, 1_000_000 + 61_000)).toThrow(/expired/)
  })

  it('rejects a request with no signature at all', () => {
    expect(() => verifySignedUrl(SECRET, {}, Date.now())).toThrow(/missing asset signature/)
  })
})

describe('key construction', () => {
  it('strips traversal and separators from filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('..\\..\\windows\\system32')).toBe('system32')
    expect(sanitizeFilename('.hidden')).toBe('hidden')
    expect(sanitizeFilename('good name (1).mp4')).toBe('good_name__1_.mp4')
  })

  it('confines every key to its project prefix', () => {
    const key = objectKey({ projectId: '../escape', kind: 'generated_video', id: 'out_1', filename: '../../x.mp4' })
    expect(key).toBe('.._escape/generated_video/out_1/x.mp4')
    expect(key.includes('../')).toBe(false)
  })
})

describe('SigV4', () => {
  /**
   * AWS's published test vector for deriving a signing key
   * (docs.aws.amazon.com — "Examples of how to derive a signing key").
   */
  it('derives the documented signing key', () => {
    const key = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam')
    expect(key.toString('hex')).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9')
  })

  it('encodes reserved characters the way S3 requires', () => {
    // encodeURIComponent leaves !'()* alone; S3 does not.
    expect(uriEncode("a b!'()*~")).toBe('a%20b%21%27%28%29%2A~')
    expect(uriEncode('a/b')).toBe('a%2Fb')
    expect(uriEncode('a/b', false)).toBe('a/b')
  })
})

describe('local path staging', () => {
  it('materializes an object to a requested path for ffmpeg', async () => {
    const storage = new LocalStorage({ root, signingSecret: SECRET })
    const source = join(root, 'source.txt')
    await writeFile(source, 'content')
    const stored = await storage.putFile('proj/k/i/source.txt', source)
    const dest = join(root, 'staged', 'copy.txt')
    expect(await storage.materialize(stored.key, dest)).toBe(dest)
    expect(storage.localPath(stored.key)).toContain(join('proj', 'k', 'i', 'source.txt'))
  })
})

/**
 * A signed URL that changes on every call silently defeats HTTP caching. The
 * review grid re-signs every clip whenever outputs reload — once per approve or
 * reject — so an unstable URL means the browser re-downloads every video in the
 * grid on every decision. These pin the fix.
 */
describe('signed URLs are cacheable', () => {
  const secret = 'stability-test-secret'

  it('returns the identical string for the same key within a window', async () => {
    let clock = 1_800_000_000_000
    const storage = new LocalStorage({ root, signingSecret: secret, now: () => clock })

    const first = await storage.signedUrl('proj/a/clip.mp4', 3600)
    clock += 60_000 // a minute of reviewing later
    const second = await storage.signedUrl('proj/a/clip.mp4', 3600)
    clock += 15 * 60_000
    const third = await storage.signedUrl('proj/a/clip.mp4', 3600)

    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('still expires, and never outlives the requested ttl', async () => {
    let clock = 1_800_000_000_000
    const storage = new LocalStorage({ root, signingSecret: secret, now: () => clock })
    const url = await storage.signedUrl('proj/a/clip.mp4', 3600)
    const exp = Number(new URL(url, 'http://x').searchParams.get('exp'))

    const remaining = exp - Math.floor(clock / 1000)
    expect(remaining).toBeLessThanOrEqual(3600)
    // Half the ttl is the floor: a request arriving at the very end of a window
    // must still get a usable link.
    expect(remaining).toBeGreaterThanOrEqual(1800)
  })

  it('rolls over to a new URL once the window advances', async () => {
    let clock = 1_800_000_000_000
    const storage = new LocalStorage({ root, signingSecret: secret, now: () => clock })
    const first = await storage.signedUrl('proj/a/clip.mp4', 3600)
    clock += 31 * 60_000 // past the 30-minute window
    expect(await storage.signedUrl('proj/a/clip.mp4', 3600)).not.toBe(first)
  })

  it('keeps different keys on different URLs', async () => {
    const storage = new LocalStorage({ root, signingSecret: secret, now: () => 1_800_000_000_000 })
    expect(await storage.signedUrl('proj/a/one.mp4', 3600)).not.toBe(await storage.signedUrl('proj/a/two.mp4', 3600))
  })

  it('presigns S3 stably too, since X-Amz-Date changes every second otherwise', async () => {
    let clock = 1_800_000_000_000
    const storage = new S3Storage({
      endpoint: 'https://s3.example.com',
      bucket: 'masterclip',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' },
      now: () => clock,
    })
    const first = await storage.signedUrl('proj/a/clip.mp4', 3600)
    clock += 5 * 60_000
    expect(await storage.signedUrl('proj/a/clip.mp4', 3600)).toBe(first)
    clock += 31 * 60_000
    expect(await storage.signedUrl('proj/a/clip.mp4', 3600)).not.toBe(first)
  })
})
