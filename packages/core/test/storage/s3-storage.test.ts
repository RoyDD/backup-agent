import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { StorageError, type StorageErrorCode } from '../../src/ports/storage'
import {
  S3Storage,
  signV4Request,
  type FetchLike,
  type S3StorageOptions,
} from '../../src/storage/s3-storage'

const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'
const SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const NOW = new Date('2024-01-02T03:04:05.000Z')
const ENDPOINT = 'http://minio.local:9000'
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: Uint8Array
}

interface Reply {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

function makeFetch(replies: readonly Reply[]): {
  fetchImpl: FetchLike
  calls: Call[]
} {
  const calls: Call[] = []
  let index = 0
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: { ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    const reply = replies[index] ?? { status: 500, body: 'no reply queued' }
    index += 1
    const headers = new Map(
      Object.entries(reply.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    )
    return {
      status: reply.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      arrayBuffer: async () => {
        const encoded = new TextEncoder().encode(reply.body ?? '')
        return encoded.buffer.slice(0) as ArrayBuffer
      },
      text: async () => reply.body ?? '',
    }
  }
  return { fetchImpl, calls }
}

function makeStorage(fetchImpl: FetchLike, overrides: Partial<S3StorageOptions> = {}): S3Storage {
  return new S3Storage({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    bucket: 'backups',
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    now: () => NOW,
    fetchImpl,
    ...overrides,
  })
}

async function captureError(promise: Promise<unknown>): Promise<StorageError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError)
    return err as StorageError
  }
  throw new Error('expected a StorageError')
}

async function expectCode(promise: Promise<unknown>, code: StorageErrorCode): Promise<StorageError> {
  const err = await captureError(promise)
  expect(err.code).toBe(code)
  return err
}

/** No error message may leak either half of the credential pair. */
function expectNoCredentials(message: string): void {
  expect(message).not.toContain(SECRET_ACCESS_KEY)
  expect(message).not.toContain(ACCESS_KEY_ID)
  expect(message).not.toContain('Signature=')
}

describe('S3Storage signing', () => {
  it('is deterministic for the same request', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, headers: { etag: '"abc123"', 'content-length': '7' } },
      { status: 200, headers: { etag: '"abc123"', 'content-length': '7' } },
    ])
    const storage = makeStorage(fetchImpl)

    await storage.put('target/base.dump', 'payload', { contentType: 'application/octet-stream' })
    await storage.put('target/base.dump', 'payload', { contentType: 'application/octet-stream' })

    const first = calls[0]?.headers.authorization
    const second = calls[1]?.headers.authorization
    expect(first).toBeDefined()
    expect(first).toBe(second)
    expect(first?.startsWith('AWS4-HMAC-SHA256 Credential=')).toBe(true)
    expect(first).toContain(`Credential=${ACCESS_KEY_ID}/20240102/us-east-1/s3/aws4_request`)
    expect(first).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date')
  })

  it('builds the documented canonical request for a PUT', () => {
    const payloadHash = createHash('sha256').update('payload').digest('hex')
    const signed = signV4Request({
      method: 'PUT',
      canonicalUri: '/backups/target/base.dump',
      host: 'minio.local:9000',
      payloadHash,
      region: 'us-east-1',
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      now: NOW,
    })

    expect(signed.canonicalRequest).toContain(
      'PUT\n' +
        '/backups/target/base.dump\n' +
        '\n' +
        'host:minio.local:9000\n' +
        `x-amz-content-sha256:${payloadHash}\n` +
        'x-amz-date:20240102T030405Z\n' +
        '\n' +
        'host;x-amz-content-sha256;x-amz-date\n' +
        payloadHash,
    )
    expect(signed.canonicalRequest.split('\n')[0]).toBe('PUT')
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/)
    expect(signed.stringToSign).toContain('20240102/us-east-1/s3/aws4_request')
  })

  it('matches the AWS SigV4 GET Object example vector', () => {
    // AWS S3 SigV4 documentation example (GET with a Range header).
    const signed = signV4Request({
      method: 'GET',
      canonicalUri: '/test.txt',
      host: 'examplebucket.s3.amazonaws.com',
      payloadHash: EMPTY_SHA256,
      headers: { range: 'bytes=0-9' },
      region: 'us-east-1',
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      now: new Date('2013-05-24T00:00:00.000Z'),
    })

    expect(signed.canonicalRequest).toContain('host:examplebucket.s3.amazonaws.com')
    expect(signed.canonicalRequest).toContain('range:bytes=0-9')
    expect(signed.signedHeaders).toBe('host;range;x-amz-content-sha256;x-amz-date')
    expect(signed.signature).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  it('signs the session token when one is configured', async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 200, headers: { etag: '"e"' } }])
    const storage = makeStorage(fetchImpl, { sessionToken: 'session-token-value' })

    await storage.put('obj.bin', 'x')

    const headers = calls[0]?.headers ?? {}
    expect(headers['x-amz-security-token']).toBe('session-token-value')
    expect(headers.authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
    )
  })
})

describe('S3Storage requests', () => {
  it('addresses path-style with per-segment key encoding', async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 200, headers: { etag: '"e"' } }])
    const storage = makeStorage(fetchImpl)

    await storage.put('a b/c+d', 'x')

    expect(calls[0]?.url).toBe(`${ENDPOINT}/backups/a%20b/c%2Bd`)
    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update('x').digest('hex'),
    )
    expect(calls[0]?.headers['content-type']).toBe('application/octet-stream')
  })

  it('returns the ETag digest and the sent length from put', async () => {
    const { fetchImpl } = makeFetch([
      {
        status: 200,
        headers: { etag: '"9b2cf535f27731c974343645a3985328"', 'last-modified': 'Mon, 02 Jan 2024 03:04:05 GMT' },
      },
    ])
    const storage = makeStorage(fetchImpl)

    const stat = await storage.put('obj.bin', 'payload', { contentType: 'text/plain' })
    expect(stat).toEqual({
      key: 'obj.bin',
      bytes: 7,
      digest: '9b2cf535f27731c974343645a3985328',
      modifiedAt: 'Mon, 02 Jan 2024 03:04:05 GMT',
    })
  })

  it('reads bytes and maps HEAD to a stat', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: 'file-bytes' },
      {
        status: 200,
        headers: { etag: 'W/"d41d8cd9"', 'content-length': '10', 'last-modified': 'Tue, 02 Jan 2024 03:04:05 GMT' },
      },
      { status: 404 },
    ])
    const storage = makeStorage(fetchImpl)

    expect(Buffer.from(await storage.get('obj.bin')).toString('utf8')).toBe('file-bytes')
    await expect(storage.stat('obj.bin')).resolves.toEqual({
      key: 'obj.bin',
      bytes: 10,
      digest: 'd41d8cd9',
      modifiedAt: 'Tue, 02 Jan 2024 03:04:05 GMT',
    })
    await expect(storage.stat('missing.bin')).resolves.toBeNull()
    expect(calls[1]?.method).toBe('HEAD')
  })

  it('maps 404 to NOT_FOUND, 403 to AUTH and 500 to HTTP without leaking credentials', async () => {
    const missing = makeStorage(makeFetch([{ status: 404 }]).fetchImpl)
    const notFound = await expectCode(missing.get('gone.bin'), 'NOT_FOUND')
    expectNoCredentials(notFound.message)

    const forbidden = makeStorage(makeFetch([{ status: 403, body: '<Error>AccessDenied</Error>' }]).fetchImpl)
    const auth = await expectCode(forbidden.get('obj.bin'), 'AUTH')
    expect(auth.message).toContain('403')
    expectNoCredentials(auth.message)

    const broken = makeStorage(makeFetch([{ status: 500, body: '<Error>InternalError</Error>' }]).fetchImpl)
    const http = await expectCode(broken.get('obj.bin'), 'HTTP')
    expect(http.message).toContain('500')
    expect(http.message).toContain('InternalError')
    expectNoCredentials(http.message)
  })

  it('surfaces network failures as IO without leaking credentials', async () => {
    const failing: FetchLike = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:9000')
    }
    const err = await expectCode(makeStorage(failing).get('obj.bin'), 'IO')
    expect(err.message).toContain('ECONNREFUSED')
    expectNoCredentials(err.message)
  })
})

describe('S3Storage list', () => {
  const pageOne =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<ListBucketResult>' +
    '<IsTruncated>true</IsTruncated>' +
    '<NextContinuationToken>token page/2</NextContinuationToken>' +
    '<Contents><Key>target/a b.dump</Key><Size>10</Size>' +
    '<LastModified>2024-01-02T03:04:05.000Z</LastModified><ETag>&quot;aaa111&quot;</ETag></Contents>' +
    '</ListBucketResult>'

  const pageTwo =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<ListBucketResult>' +
    '<IsTruncated>false</IsTruncated>' +
    '<Contents><Key>target/b.dump</Key><Size>20</Size>' +
    '<LastModified>2024-01-03T03:04:05.000Z</LastModified><ETag>"bbb222"</ETag></Contents>' +
    '</ListBucketResult>'

  it('follows one continuation page then stops', async () => {
    const { fetchImpl, calls } = makeFetch([
      { status: 200, body: pageOne },
      { status: 200, body: pageTwo },
    ])
    const storage = makeStorage(fetchImpl)

    const listed = await storage.list('target/')

    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toContain('list-type=2')
    expect(calls[0]?.url).toContain('prefix=target%2F')
    expect(calls[0]?.url).not.toContain('continuation-token')
    expect(calls[1]?.url).toContain('continuation-token=token%20page%2F2')

    expect(listed).toEqual([
      {
        key: 'target/a b.dump',
        bytes: 10,
        digest: 'aaa111',
        modifiedAt: '2024-01-02T03:04:05.000Z',
      },
      {
        key: 'target/b.dump',
        bytes: 20,
        digest: 'bbb222',
        modifiedAt: '2024-01-03T03:04:05.000Z',
      },
    ])
  })

  it('ignores entries outside the prefix and stops on a non-truncated page', async () => {
    const { fetchImpl, calls } = makeFetch([
      {
        status: 200,
        body:
          '<ListBucketResult><IsTruncated>false</IsTruncated>' +
          '<Contents><Key>other/x</Key><Size>1</Size><ETag>"e"</ETag></Contents>' +
          '<Contents><Key>target/keep</Key><Size>2</Size><ETag>"f"</ETag></Contents>' +
          '</ListBucketResult>',
      },
    ])
    const storage = makeStorage(fetchImpl)

    const listed = await storage.list('target/')
    expect(listed.map((entry) => entry.key)).toEqual(['target/keep'])
    expect(calls).toHaveLength(1)
  })
})

describe('S3Storage delete', () => {
  it('returns true on 204 and false on 404', async () => {
    const { fetchImpl, calls } = makeFetch([{ status: 204 }, { status: 404 }])
    const storage = makeStorage(fetchImpl)

    await expect(storage.delete('obj.bin')).resolves.toBe(true)
    await expect(storage.delete('obj.bin')).resolves.toBe(false)
    expect(calls[0]?.method).toBe('DELETE')
    expect(calls[1]?.method).toBe('DELETE')
  })

  it('refuses invalid keys before issuing a request', async () => {
    const { fetchImpl, calls } = makeFetch([])
    const storage = makeStorage(fetchImpl)

    await expectCode(storage.delete('../obj.bin'), 'INVALID_KEY')
    await expectCode(storage.put('/abs', 'x'), 'INVALID_KEY')
    expect(calls).toHaveLength(0)
  })
})
