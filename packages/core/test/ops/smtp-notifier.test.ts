import { hostname } from 'node:os'
import { createServer, type Server, type Socket } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { SmtpError, SmtpNotifier, type SmtpNotifierOptions } from '../../src/ops/smtp-notifier'
import type { AlertEvent } from '../../src/ops/notify'

interface FakeHooks {
  /** Answer `550` to the first `RCPT TO`. */
  rcptReject?: boolean
  /** Answer `535` to `AUTH`. */
  authReject?: boolean
}

interface FakeSmtp {
  port: number
  /** Every command line in order, including the DATA terminator `.`. */
  commands: string[]
  /** Every line received inside DATA, headers included, terminator excluded. */
  dataLines: string[]
  /** Raw bytes received from the client, for line-ending checks. */
  wire: string
  close(): Promise<void>
}

const open: FakeSmtp[] = []

/** Minimal in-process SMTP server: enough state to drive one client dialogue. */
async function startFakeSmtp(hooks: FakeHooks = {}): Promise<FakeSmtp> {
  const commands: string[] = []
  const dataLines: string[] = []
  const sockets = new Set<Socket>()
  let wire = ''

  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.write('220 fake.bkagent ESMTP\r\n')

    let buffer = ''
    let inData = false

    socket.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      wire += text
      buffer += text
      for (;;) {
        const eol = buffer.indexOf('\r\n')
        if (eol < 0) break
        const line = buffer.slice(0, eol)
        buffer = buffer.slice(eol + 2)

        if (inData) {
          if (line === '.') {
            commands.push('.')
            inData = false
            socket.write('250 2.0.0 queued as 4f2a\r\n')
          } else {
            dataLines.push(line)
          }
          continue
        }

        commands.push(line)
        const upper = line.toUpperCase()
        if (upper.startsWith('EHLO')) {
          socket.write('250-fake.bkagent\r\n250-SIZE 10240000\r\n250 AUTH PLAIN\r\n')
        } else if (upper.startsWith('AUTH')) {
          socket.write(
            hooks.authReject ? '535 5.7.8 authentication credentials invalid\r\n' : '235 2.7.0 accepted\r\n',
          )
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 sender ok\r\n')
        } else if (upper.startsWith('RCPT TO')) {
          socket.write(hooks.rcptReject ? '550 5.1.1 no such user\r\n' : '250 2.1.5 recipient ok\r\n')
        } else if (upper === 'DATA') {
          inData = true
          socket.write('354 go ahead\r\n')
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n')
          socket.end()
        } else {
          socket.write('502 5.5.2 command not implemented\r\n')
        }
      }
    })

    socket.on('error', () => {
      /* the client may hang up mid-dialogue after a failure */
    })
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake smtp server has no port')

  const fake: FakeSmtp = {
    port: address.port,
    commands,
    dataLines,
    get wire() {
      return wire
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  open.push(fake)
  return fake
}

function notifierFor(fake: FakeSmtp, overrides: Partial<SmtpNotifierOptions> = {}) {
  return new SmtpNotifier({
    host: '127.0.0.1',
    port: fake.port,
    from: 'bkagent@example.test',
    to: ['dba@example.test', 'oncall@example.test'],
    now: () => '2026-11-12T10:00:00.000Z',
    ...overrides,
  })
}

function p1Event(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    severity: 'P1',
    title: 'restore point missing for pg-prod',
    message: 'target "pg-prod" has no V2/V3 artifact; RPO 60m cannot be claimed.',
    labels: { targetId: 'pg-prod', rpoMinutes: '60' },
    ...overrides,
  }
}

afterEach(async () => {
  while (open.length > 0) {
    await open.pop()?.close()
  }
})

describe('SmtpNotifier', () => {
  it('runs the full authenticated dialogue and sends the alert as DATA', async () => {
    const fake = await startFakeSmtp()
    const password = 's3cret-pw'
    const notifier = notifierFor(fake, { user: 'alerts', pass: password })
    const token = Buffer.from(`\u0000alerts\u0000${password}`, 'utf8').toString('base64')

    await notifier.send(p1Event())

    expect(fake.commands).toEqual([
      `EHLO ${hostname()}`,
      `AUTH PLAIN ${token}`,
      'MAIL FROM:<bkagent@example.test>',
      'RCPT TO:<dba@example.test>',
      'RCPT TO:<oncall@example.test>',
      'DATA',
      '.',
      'QUIT',
    ])

    expect(fake.dataLines).toContain('Subject: [bkagent] P1 restore point missing for pg-prod')
    expect(fake.dataLines).toContain('X-Bkagent-Severity: P1')
    expect(fake.dataLines).toContain('targetId=pg-prod')
    expect(fake.dataLines).toContain('rpoMinutes=60')
    expect(fake.dataLines).toContain('Date: Thu, 12 Nov 2026 10:00:00 +0000')
    expect(fake.dataLines).toContain('Content-Type: text/plain; charset=utf-8')
    // header/body separator, then the message body
    expect(fake.dataLines).toContain('')
    expect(fake.dataLines).toContain('timestamp: 2026-11-12T10:00:00.000Z')

    // CRLF only: stripping CRLF pairs must leave no stray CR or LF behind.
    const stripped = fake.wire.split('\r\n').join('')
    expect(stripped).not.toContain('\r')
    expect(stripped).not.toContain('\n')
    expect(fake.wire.startsWith('EHLO ')).toBe(true)
  })

  it('dot-stuffs body lines that start with a period', async () => {
    const fake = await startFakeSmtp()
    const notifier = notifierFor(fake)

    await notifier.send(
      p1Event({ message: 'first line of the alert\n.leading dot on the second line' }),
    )

    expect(fake.dataLines).toContain('first line of the alert')
    expect(fake.dataLines).toContain('..leading dot on the second line')
    expect(fake.dataLines).not.toContain('.leading dot on the second line')
  })

  it('flattens a header-injecting title into a single Subject line', async () => {
    const fake = await startFakeSmtp()
    const notifier = notifierFor(fake)

    await notifier.send(p1Event({ title: 'disk full\r\nBcc: evil@example.com' }))

    const subjectLines = fake.dataLines.filter((line) => line.startsWith('Subject:'))
    expect(subjectLines).toHaveLength(1)
    expect(subjectLines[0]).toBe('Subject: [bkagent] P1 disk full Bcc: evil@example.com')
    expect(fake.dataLines.filter((line) => line.startsWith('Bcc:'))).toEqual([])
    expect(fake.dataLines.filter((line) => line.startsWith('X-Bkagent-Severity:'))).toEqual([
      'X-Bkagent-Severity: P1',
    ])
  })

  it('fails with stage rcpt-to when the server rejects a recipient', async () => {
    const fake = await startFakeSmtp({ rcptReject: true })
    const password = 's3cret-pw'
    const notifier = notifierFor(fake, { user: 'alerts', pass: password })

    const error = await notifier.send(p1Event()).then(
      () => null,
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(SmtpError)
    const smtpError = error as SmtpError
    expect(smtpError.stage).toBe('rcpt-to')
    expect(smtpError.reply).toContain('550')
    expect(smtpError.message).toContain('550')
    expect(smtpError.message).not.toContain(password)
    expect(smtpError.reply).not.toContain(password)
    // the dialogue stops at the rejected recipient: no DATA, no QUIT
    expect(fake.commands).not.toContain('DATA')
  })

  it('fails with stage auth when the server rejects the credentials', async () => {
    const fake = await startFakeSmtp({ authReject: true })
    const password = 's3cret-pw'
    const notifier = notifierFor(fake, { user: 'alerts', pass: password })

    const error = await notifier.send(p1Event()).then(
      () => null,
      (reason: unknown) => reason,
    )

    expect(error).toBeInstanceOf(SmtpError)
    const smtpError = error as SmtpError
    expect(smtpError.stage).toBe('auth')
    expect(smtpError.reply).toContain('535')
    expect(smtpError.message).not.toContain(password)
    expect(fake.commands.some((line) => line.startsWith('MAIL FROM'))).toBe(false)
  })

  it('skips AUTH when no credentials are configured', async () => {
    const fake = await startFakeSmtp()
    const notifier = notifierFor(fake)

    await notifier.send(p1Event())

    expect(fake.commands.some((line) => line.startsWith('AUTH'))).toBe(false)
    expect(fake.commands[1]).toBe('MAIL FROM:<bkagent@example.test>')
  })
})
