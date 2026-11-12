import { createHash, createHmac } from 'node:crypto'

import {
  StorageError,
  validateStorageKey,
  validateStoragePrefix,
  type Storage,
  type StorageStat,
} from '../ports/storage'

/** Minimal structural response so the port needs no DOM/undici type dependency. */
export interface FetchResponseLike {
  readonly status: number
  readonly headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
  text?(): Promise<string>
}

export type FetchLike = (
  url: string,
  init: {
    readonly method: string
    readonly headers: Readonly<Record<string, string>>
    readonly body?: Uint8Array
  },
) => Promise<FetchResponseLike>

export interface S3StorageOptions {
  /** `http(s)://host[:port]`; requests use path-style addressing. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Injectable clock and fetch so signing and HTTP handling are unit-testable. */
  now?: () => Date
  fetchImpl?: FetchLike
}

/** Hard cap on `list` continuation pages, so a broken backend cannot loop forever. */
const MAX_LIST_PAGES = 100
const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'
const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex')

function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function hmacSha256(key: Uint8Array | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

/** RFC 3986 encoding: `encodeURIComponent` plus the characters it leaves raw. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Encode an object key for the request path, one segment at a time. */
function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/')
}

/** `20240102T030405Z` from a Date, as SigV4 requires. */
function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** Canonical query string: encode, then sort by parameter name. */
export function canonicalQueryString(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name] ?? '')}`)
    .join('&')
}

export interface SigV4Input {
  readonly method: string
  /** Canonical URI, already percent-encoded, starting with `/`. */
  readonly canonicalUri: string
  /** Raw query parameters; encoded and sorted by the signer. */
  readonly query?: Readonly<Record<string, string>>
  /** `host[:port]` exactly as sent in the Host header. */
  readonly host: string
  readonly payloadHash: string
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly now: Date
  /** Additional headers to sign (`content-type` is deliberately not signed). */
  readonly headers?: Readonly<Record<string, string>>
}

export interface SigV4Result {
  readonly amzDate: string
  readonly canonicalRequest: string
  readonly signedHeaders: string
  readonly stringToSign: string
  readonly signature: string
  /** Headers to send: `host`, the `x-amz-*` set and `authorization`. */
  readonly headers: Readonly<Record<string, string>>
}

/**
 * SigV4 for S3 over plain `fetch`.
 *
 * Core has zero runtime dependencies, so this is hand-rolled rather than an
 * SDK call. The signed set is fixed: `host`, `x-amz-content-sha256`,
 * `x-amz-date` and, when a session token is present, `x-amz-security-token`.
 * `content-type` travels unsigned.
 */
export function signV4Request(input: SigV4Input): SigV4Result {
  const timestamp = amzDate(input.now)
  const dateStamp = timestamp.slice(0, 8)
  const query = canonicalQueryString(input.query ?? {})

  const headers: Record<string, string> = {
    host: input.host,
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': timestamp,
    ...(input.headers ?? {}),
  }
  if (input.sessionToken !== undefined) headers['x-amz-security-token'] = input.sessionToken

  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort()
  const canonicalHeaders = names
    .map((name) => `${name}:${(headers[name] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n')

  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`
  const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join('\n')

  const dateKey = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp)
  const regionKey = hmacSha256(dateKey, input.region)
  const serviceKey = hmacSha256(regionKey, SERVICE)
  const signingKey = hmacSha256(serviceKey, 'aws4_request')
  const signature = hex(hmacSha256(signingKey, stringToSign))

  const authorization =
    `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    amzDate: timestamp,
    canonicalRequest,
    signedHeaders,
    stringToSign,
    signature,
    headers: { ...headers, authorization },
  }
}

function stripQuotes(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim().replace(/^W\//, '')
  return trimmed.replace(/^"|"$/g, '')
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function xmlTag(body: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)
  return match?.[1] === undefined ? null : decodeXmlEntities(match[1])
}

function defaultFetch(): FetchLike {
  const candidate = (globalThis as { fetch?: unknown }).fetch
  if (typeof candidate !== 'function') {
    throw new StorageError('IO', 'global fetch is unavailable; S3Storage needs Node >= 18')
  }
  return candidate as FetchLike
}

async function responseText(response: FetchResponseLike): Promise<string> {
  if (typeof response.text === 'function') return response.text()
  return new TextDecoder().decode(new Uint8Array(await response.arrayBuffer()))
}

/**
 * S3-compatible object storage over `fetch` with hand-rolled SigV4.
 *
 * Path-style addressing (`<endpoint>/<bucket>/<key>`) is used throughout so the
 * same class works against MinIO, rustfs and AWS without virtual-host DNS.
 * Failures are never degraded to a local fallback: auth errors and HTTP errors
 * surface as `StorageError` with the status and a short body excerpt, never the
 * credentials.
 */
export class S3Storage implements Storage {
  readonly id: string
  private readonly endpoint: string
  private readonly host: string
  private readonly bucket: string
  private readonly region: string
  private readonly accessKeyId: string
  private readonly secretAccessKey: string
  private readonly sessionToken: string | undefined
  private readonly now: () => Date
  private readonly fetchImpl: FetchLike

  constructor(options: S3StorageOptions) {
    let parsed: URL
    try {
      parsed = new URL(options.endpoint)
    } catch {
      throw new StorageError('HTTP', `s3 endpoint is not a URL: ${options.endpoint}`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new StorageError('HTTP', `s3 endpoint must be http(s): ${parsed.protocol}`)
    }
    if (options.bucket === '') throw new StorageError('INVALID_KEY', 's3 bucket must not be empty')

    this.endpoint = options.endpoint.replace(/\/+$/, '')
    this.host = parsed.host
    this.bucket = options.bucket
    this.region = options.region
    this.accessKeyId = options.accessKeyId
    this.secretAccessKey = options.secretAccessKey
    this.sessionToken = options.sessionToken
    this.now = options.now ?? (() => new Date())
    this.fetchImpl = options.fetchImpl ?? defaultFetch()
    this.id = `s3:${options.bucket}`
  }

  private sign(input: {
    method: string
    canonicalUri: string
    query?: Readonly<Record<string, string>>
    payloadHash: string
  }): SigV4Result {
    return signV4Request({
      method: input.method,
      canonicalUri: input.canonicalUri,
      query: input.query,
      host: this.host,
      payloadHash: input.payloadHash,
      region: this.region,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      now: this.now(),
    })
  }

  private async send(input: {
    method: string
    /** Canonical URI, already encoded. */
    canonicalUri: string
    query?: Readonly<Record<string, string>>
    key: string
    body?: Uint8Array
    contentType?: string
  }): Promise<FetchResponseLike> {
    const payloadHash =
      input.body === undefined ? EMPTY_BODY_SHA256 : sha256Hex(new Uint8Array(input.body))
    const signed = this.sign({
      method: input.method,
      canonicalUri: input.canonicalUri,
      query: input.query,
      payloadHash,
    })

    const queryString =
      input.query === undefined ? '' : canonicalQueryString(input.query)
    const url = `${this.endpoint}${input.canonicalUri}${queryString === '' ? '' : `?${queryString}`}`

    const headers: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': signed.amzDate,
      authorization: signed.headers.authorization ?? '',
    }
    if (this.sessionToken !== undefined) headers['x-amz-security-token'] = this.sessionToken
    if (input.contentType !== undefined) headers['content-type'] = input.contentType

    try {
      return await this.fetchImpl(url, {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: input.body }),
      })
    } catch (err) {
      if (err instanceof StorageError) throw err
      throw new StorageError(
        'IO',
        `${input.method} ${input.key} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** Map a non-2xx response to the port's error codes. Never echoes credentials. */
  private async raise(
    method: string,
    key: string,
    response: FetchResponseLike,
  ): Promise<never> {
    const status = response.status
    if (status === 401 || status === 403) {
      throw new StorageError(
        'AUTH',
        `${method} ${key}: HTTP ${status} (credentials rejected)`,
      )
    }
    let excerpt = ''
    try {
      excerpt = (await responseText(response)).replace(/\s+/g, ' ').trim().slice(0, 200)
    } catch {
      excerpt = ''
    }
    throw new StorageError(
      'HTTP',
      `${method} ${key}: HTTP ${status}${excerpt === '' ? '' : `: ${excerpt}`}`,
    )
  }

  private statFromHeaders(key: string, response: FetchResponseLike, bytes: number): StorageStat {
    const contentLength = response.headers.get('content-length')
    const parsedLength = contentLength === null ? Number.NaN : Number(contentLength)
    return {
      key,
      bytes: Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : bytes,
      digest: stripQuotes(response.headers.get('etag')),
      modifiedAt: response.headers.get('last-modified') ?? this.now().toISOString(),
    }
  }

  async put(
    key: string,
    data: Uint8Array | string,
    options?: { contentType?: string },
  ): Promise<StorageStat> {
    const validKey = validateStorageKey(key)
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const response = await this.send({
      method: 'PUT',
      canonicalUri: `/${this.bucket}/${encodeKeyPath(validKey)}`,
      key: validKey,
      body,
      contentType: options?.contentType ?? 'application/octet-stream',
    })

    if (response.status < 200 || response.status >= 300) {
      await this.raise('PUT', validKey, response)
    }

    const stat = this.statFromHeaders(validKey, response, body.byteLength)
    return {
      ...stat,
      // The bytes we sent are the authoritative length; Content-Length is a
      // server echo and only a fallback.
      bytes: body.byteLength,
      digest: stat.digest,
      modifiedAt: response.headers.get('last-modified') ?? this.now().toISOString(),
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const validKey = validateStorageKey(key)
    const response = await this.send({
      method: 'GET',
      canonicalUri: `/${this.bucket}/${encodeKeyPath(validKey)}`,
      key: validKey,
    })

    if (response.status === 404) {
      throw new StorageError('NOT_FOUND', `GET ${validKey}: object not found`)
    }
    if (response.status < 200 || response.status >= 300) {
      await this.raise('GET', validKey, response)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  async stat(key: string): Promise<StorageStat | null> {
    const validKey = validateStorageKey(key)
    const response = await this.send({
      method: 'HEAD',
      canonicalUri: `/${this.bucket}/${encodeKeyPath(validKey)}`,
      key: validKey,
    })

    if (response.status === 404) return null
    if (response.status >= 400) {
      await this.raise('HEAD', validKey, response)
    }
    if (response.status < 200 || response.status >= 300) {
      await this.raise('HEAD', validKey, response)
    }
    return this.statFromHeaders(validKey, response, 0)
  }

  async list(prefix = ''): Promise<StorageStat[]> {
    const validPrefix = validateStoragePrefix(prefix)
    const results: StorageStat[] = []
    let continuationToken: string | undefined

    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query: Record<string, string> = { 'list-type': '2' }
      if (validPrefix !== '') query.prefix = validPrefix
      if (continuationToken !== undefined) query['continuation-token'] = continuationToken

      const response = await this.send({
        method: 'GET',
        canonicalUri: `/${this.bucket}`,
        query,
        key: validPrefix,
      })
      if (response.status < 200 || response.status >= 300) {
        await this.raise('LIST', validPrefix, response)
      }

      const body = await responseText(response)
      for (const block of body.match(/<Contents>([\s\S]*?)<\/Contents>/g) ?? []) {
        const inner = block
        const key = xmlTag(inner, 'Key')
        if (key === null) continue
        // Defensive: a misbehaving backend must not widen the requested scope.
        if (!key.startsWith(validPrefix)) continue
        const size = xmlTag(inner, 'Size')
        results.push({
          key,
          bytes: size === null ? 0 : Number.parseInt(size, 10) || 0,
          digest: stripQuotes(xmlTag(inner, 'ETag')),
          modifiedAt: xmlTag(inner, 'LastModified'),
        })
      }

      const truncated = xmlTag(body, 'IsTruncated') === 'true'
      const next = xmlTag(body, 'NextContinuationToken')
      if (!truncated || next === null || next === '') return results
      continuationToken = next
    }

    throw new StorageError(
      'IO',
      `LIST ${validPrefix}: exceeded ${MAX_LIST_PAGES} continuation pages`,
    )
  }

  async delete(key: string): Promise<boolean> {
    const validKey = validateStorageKey(key)
    const response = await this.send({
      method: 'DELETE',
      canonicalUri: `/${this.bucket}/${encodeKeyPath(validKey)}`,
      key: validKey,
    })

    if (response.status === 404) return false
    if (response.status < 200 || response.status >= 300) {
      await this.raise('DELETE', validKey, response)
    }
    return true
  }
}
