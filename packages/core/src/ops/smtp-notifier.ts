/**
 * Dependency-free SMTP notifier (plan §3.1: `notifier: webhook / smtp`).
 *
 * The dialogue is deliberately small: the greeting, `EHLO`, optional
 * `AUTH PLAIN`, one `MAIL FROM`, one `RCPT TO` per recipient, `DATA`, `QUIT`.
 * There is **no STARTTLS and no implicit TLS** in this pass: the notifier is
 * meant for a loopback or trusted relay endpoint (or a smarthost reachable over
 * a private network), and it refuses nothing on that basis — it simply does not
 * offer the capability. Point it at an endpoint whose transport you already
 * trust, and terminate TLS in front of that endpoint.
 *
 * Wire-format guarantees:
 * - CRLF line endings, dot-stuffed body lines, and `.` as the DATA terminator.
 * - Header values are flattened to a single line, so an alert title that
 *   carries `\r\n` cannot inject headers (`event.title` is data, not text).
 * - The password never appears in an `SmtpError`, and the `AUTH PLAIN` token is
 *   redacted from any server reply that echoes it.
 */

import { connect as netConnect, type Socket } from 'node:net'
import { hostname as osHostname } from 'node:os'

import type { AlertEvent, Notifier } from './notify'

export interface SmtpNotifierOptions {
  host: string
  port?: number
  from: string
  /** At least one recipient. */
  to: readonly string[]
  /** AUTH PLAIN credentials; omit for an open relay hand-off. */
  user?: string
  pass?: string
  /** Envelope + header subject prefix, default `[bkagent]`. */
  subjectPrefix?: string
  /** Per-step reply (and connect) timeout, default 10_000 ms. */
  connectTimeoutMs?: number
  /** Injectable clock (ISO 8601 string) and connector, so the dialogue is unit-testable. */
  now?: () => string
  connect?: (options: { host: string; port: number }) => Socket
}

export type SmtpStage = 'greeting' | 'ehlo' | 'auth' | 'mail-from' | 'rcpt-to' | 'data' | 'quit'

export class SmtpError extends Error {
  readonly stage: SmtpStage
  /** Server reply text (or a transport message); never contains the password. */
  readonly reply: string

  constructor(stage: SmtpStage, reply: string) {
    super(`smtp ${stage} failed: ${reply}`)
    this.name = 'SmtpError'
    this.stage = stage
    this.reply = reply
  }
}

const CRLF = '\r\n'
const DEFAULT_SMTP_PORT = 25
const DEFAULT_SUBJECT_PREFIX = '[bkagent]'
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

interface Reply {
  code: number
  text: string
}

interface SmtpEnvelope {
  from: string
  to: readonly string[]
  subjectPrefix: string
}

/** Reads complete SMTP replies (including multi-line `250-…` replies) off a byte stream. */
class ReplyReader {
  private buffer = ''
  private waiter: ((reply: Reply) => void) | null = null
  private rejecter: ((error: Error) => void) | null = null
  private failure: Error | null = null

  push(chunk: string): void {
    this.buffer += chunk
    this.settle()
  }

  next(): Promise<Reply> {
    const ready = this.extract()
    if (ready !== null) return Promise.resolve(ready)
    if (this.failure !== null) return Promise.reject(this.failure)
    return new Promise<Reply>((resolve, reject) => {
      this.waiter = resolve
      this.rejecter = reject
    })
  }

  fail(error: Error): void {
    this.failure ??= error
    const reject = this.rejecter
    this.waiter = null
    this.rejecter = null
    reject?.(this.failure)
  }

  private settle(): void {
    if (this.waiter === null) return
    const ready = this.extract()
    if (ready === null) return
    const resolve = this.waiter
    this.waiter = null
    this.rejecter = null
    resolve(ready)
  }

  private extract(): Reply | null {
    let cursor = 0
    let code = -1
    const text: string[] = []
    for (;;) {
      const eol = this.buffer.indexOf(CRLF, cursor)
      if (eol < 0) return null // incomplete line: wait for more bytes
      const line = this.buffer.slice(cursor, eol)
      const match = /^(\d{3})([- ])([\s\S]*)$/.exec(line)
      if (match === null) return null // not a reply line; the timeout will surface it
      if (code < 0) code = Number(match[1])
      text.push(match[3] ?? '')
      cursor = eol + CRLF.length
      if (match[2] === ' ') break // final line of the reply
    }
    this.buffer = this.buffer.slice(cursor)
    return { code, text: text.join(' ').trim() }
  }
}

const TIMEOUT = Symbol('smtp-timeout')

/** One socket plus the request/response sequencing for a single `send`. */
class SmtpConnection {
  private readonly reader = new ReplyReader()
  private readonly secrets: string[] = []
  private socketError: Error | null = null
  private closed = false

  constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string | Buffer) => {
      this.reader.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    socket.on('error', (error: Error) => {
      this.socketError ??= error
      this.reader.fail(error)
    })
    socket.on('close', () => {
      this.closed = true
      this.reader.fail(new Error('connection closed by server'))
    })
  }

  addSecret(secret: string): void {
    if (secret.length > 0) this.secrets.push(secret)
  }

  /** Waits for one reply and requires one of `codes`. */
  async expect(stage: SmtpStage, codes: readonly number[]): Promise<Reply> {
    const reply = await this.read(stage)
    if (!codes.includes(reply.code)) {
      // Keep the numeric code in the error text: operators match on it.
      throw new SmtpError(stage, this.redact(`${reply.code} ${reply.text}`.trim()))
    }
    return reply
  }

  /** Writes one or more CRLF-terminated lines, then requires one of `codes`. */
  async command(
    lines: readonly string[],
    stage: SmtpStage,
    codes: readonly number[],
    secret?: string,
  ): Promise<void> {
    if (secret !== undefined) this.addSecret(secret)
    if (this.closed) throw new SmtpError(stage, 'connection already closed')
    try {
      this.socket.write(`${lines.join(CRLF)}${CRLF}`)
    } catch (error) {
      this.destroy()
      throw new SmtpError(stage, this.redact(messageOf(error)))
    }
    await this.expect(stage, codes)
  }

  destroy(): void {
    if (this.closed) {
      this.socket.destroy()
      return
    }
    this.closed = true
    this.socket.destroy()
  }

  /** All transport failures become `SmtpError` for the stage in flight. */
  private async read(stage: SmtpStage): Promise<Reply> {
    if (this.socketError !== null) {
      throw new SmtpError(stage, this.redact(this.socketError.message))
    }
    if (this.closed) throw new SmtpError(stage, 'connection already closed')
    const pending = this.reader.next()
    pending.catch(() => {
      /* the race below reports it; keep the rejection observed */
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(TIMEOUT), this.timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([pending, timeout])
    } catch (error) {
      this.destroy()
      if (error === TIMEOUT) {
        throw new SmtpError(stage, `no reply within ${this.timeoutMs}ms`)
      }
      throw new SmtpError(stage, this.redact(messageOf(error)))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private redact(value: string): string {
    let result = value
    for (const secret of this.secrets) {
      result = result.split(secret).join('<redacted>')
    }
    return result
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Header and header-ish values must not carry line breaks: flatten to spaces. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** RFC 5322 `date-time` in UTC (`Thu, 12 Nov 2026 10:00:00 +0000`). */
function rfc5322Date(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return singleLine(iso)
  const day = DAY_NAMES[date.getUTCDay()] ?? 'Thu'
  const month = MONTH_NAMES[date.getUTCMonth()] ?? 'Jan'
  return (
    `${day}, ${pad2(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())} +0000`
  )
}

/** Body lines are preserved (dot-stuffing depends on them) with CR/LF normalised. */
function bodyLines(event: AlertEvent, timestamp: string): string[] {
  const labels = event.labels ?? {}
  const keys = Object.keys(labels)
  const lines = event.message.split(/\r\n|\r|\n/).map((line) => singleLine(line))
  lines.push('')
  lines.push(`severity: ${event.severity}`)
  if (keys.length > 0) {
    lines.push('labels:')
    for (const key of keys) {
      lines.push(`${singleLine(key)}=${singleLine(labels[key] ?? '')}`)
    }
  }
  lines.push('')
  lines.push(`timestamp: ${singleLine(timestamp)}`)
  return lines.map((line) => (line.startsWith('.') ? `.${line}` : line))
}

/** Headers, blank separator, then the dot-stuffed body. */
function messageLines(event: AlertEvent, envelope: SmtpEnvelope, timestamp: string): string[] {
  const subject = `${envelope.subjectPrefix} ${event.severity} ${event.title}`
  return [
    `From: ${singleLine(envelope.from)}`,
    `To: ${envelope.to.map(singleLine).join(', ')}`,
    `Subject: ${singleLine(subject)}`,
    `Date: ${rfc5322Date(timestamp)}`,
    `X-Bkagent-Severity: ${event.severity}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    ...bodyLines(event, timestamp),
  ]
}

export class SmtpNotifier implements Notifier {
  private readonly host: string
  private readonly port: number
  private readonly from: string
  private readonly to: readonly string[]
  private readonly user: string | undefined
  private readonly pass: string | undefined
  private readonly subjectPrefix: string
  private readonly connectTimeoutMs: number
  private readonly now: () => string
  private readonly connector: (options: { host: string; port: number }) => Socket

  constructor(options: SmtpNotifierOptions) {
    const host = options.host.trim()
    const from = options.from.trim()
    const to = options.to.map((recipient) => recipient.trim()).filter((recipient) => recipient.length > 0)
    if (host.length === 0) throw new Error('smtp notifier requires a host')
    if (from.length === 0) throw new Error('smtp notifier requires a from address')
    if (to.length === 0) throw new Error('smtp notifier requires at least one recipient')
    const port = options.port ?? DEFAULT_SMTP_PORT
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`smtp notifier port out of range: ${String(options.port)}`)
    }
    this.host = host
    this.port = port
    this.from = from
    this.to = to
    this.user = options.user
    this.pass = options.pass
    this.subjectPrefix = options.subjectPrefix ?? DEFAULT_SUBJECT_PREFIX
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.now = options.now ?? (() => new Date().toISOString())
    this.connector = options.connect ?? ((target) => netConnect({ host: target.host, port: target.port }))
  }

  async send(event: AlertEvent): Promise<void> {
    const socket = this.connector({ host: this.host, port: this.port })
    const connection = new SmtpConnection(socket, this.connectTimeoutMs)
    if (this.pass !== undefined) connection.addSecret(this.pass)
    try {
      await connection.expect('greeting', [220])
      await connection.command(
        [`EHLO ${singleLine(osHostname())}`],
        'ehlo',
        [250],
      )
      if (this.user !== undefined && this.pass !== undefined) {
        const token = Buffer.from(`\u0000${this.user}\u0000${this.pass}`, 'utf8').toString('base64')
        await connection.command([`AUTH PLAIN ${token}`], 'auth', [235], token)
      }
      await connection.command([`MAIL FROM:<${singleLine(this.from)}>`], 'mail-from', [250])
      for (const recipient of this.to) {
        await connection.command(
          [`RCPT TO:<${singleLine(recipient)}>`],
          'rcpt-to',
          [250, 251],
        )
      }
      await connection.command(['DATA'], 'data', [354])
      const timestamp = event.timestamp ?? this.now()
      const envelope: SmtpEnvelope = {
        from: this.from,
        to: this.to,
        subjectPrefix: this.subjectPrefix,
      }
      await connection.command([...messageLines(event, envelope, timestamp), '.'], 'data', [250])
      await connection.command(['QUIT'], 'quit', [221])
    } finally {
      connection.destroy()
    }
  }
}
