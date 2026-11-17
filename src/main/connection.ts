// Test connection: checks that the server an endpoint points at answers.
//
// It opens a network connection (and for HTTP sends a request, for FTP, SFTP and mail reads the
// server's greeting). It does not log in: credentials are checked by the route when it runs.

import { connect as tcpConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ConnectionCheck, ConnectionResult, ConnectionTarget } from '@shared/types'

const TCP_TIMEOUT = 5000
const HTTP_TIMEOUT = 8000

function explain(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return `Nothing is listening on ${host}:${port}: the connection was refused. Is the server running, and is the port right?`
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `The host name “${host}” cannot be found. Check the spelling, or the DNS/VPN of this machine.`
    case 'ETIMEDOUT':
    case 'TIMEOUT':
      return `No answer from ${host}:${port} within ${TCP_TIMEOUT / 1000} seconds. A firewall may be blocking it, or the address is wrong.`
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${host} cannot be reached from this machine (no network route). A VPN may be needed.`
    case 'ECONNRESET':
      return `${host}:${port} accepted the connection and then closed it.`
    default:
      return err.message
  }
}

/** Connects, optionally over TLS, and reads the first line the server sends (if it sends one). */
function probe(host: string, port: number, tls: boolean, readGreeting: boolean): Promise<{ ok: boolean; ms: number; message: string; greeting?: string }> {
  const started = Date.now()
  return new Promise((resolve) => {
    let done = false
    let socket: Socket
    const finish = (r: { ok: boolean; message: string; greeting?: string }): void => {
      if (done) return
      done = true
      socket?.destroy()
      resolve({ ...r, ms: Date.now() - started })
    }
    const onConnect = (): void => {
      if (!readGreeting) return finish({ ok: true, message: `${host}:${port} accepts connections` })
      // Some servers only talk after the client does; an open port is still a good sign.
      const quiet = setTimeout(() => finish({ ok: true, message: `${host}:${port} accepts connections (no greeting received)` }), 3000)
      socket.once('data', (d: Buffer) => {
        clearTimeout(quiet)
        const greeting = d.toString('utf8').split(/\r?\n/)[0].trim().slice(0, 160)
        finish({ ok: true, message: `${host}:${port} answered`, greeting })
      })
    }
    socket = tls ? tlsConnect({ host, port, servername: host, rejectUnauthorized: false }, onConnect) : tcpConnect({ host, port }, onConnect)
    socket.setTimeout(TCP_TIMEOUT, () => finish({ ok: false, message: explain({ code: 'TIMEOUT' } as NodeJS.ErrnoException, host, port) }))
    socket.on('error', (err: NodeJS.ErrnoException) => finish({ ok: false, message: explain(err, host, port) }))
  })
}

async function httpCheck(url: string): Promise<ConnectionCheck> {
  const started = Date.now()
  const attempt = async (method: string): Promise<Response> => fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT) })
  try {
    let res = await attempt('HEAD')
    if (res.status === 405 || res.status === 501) res = await attempt('GET')
    const ms = Date.now() - started
    const note = res.status >= 500 ? ' (the server reports an error of its own)' : res.status === 401 || res.status === 403 ? ' (it asks for credentials, which the route sends)' : res.status === 404 ? ' (this exact path was not found)' : ''
    return { target: url, ok: true, ms, message: `Answered with HTTP ${res.status} ${res.statusText}${note}` }
  } catch (e) {
    const err = e as Error & { cause?: NodeJS.ErrnoException }
    const ms = Date.now() - started
    let host = url
    let port = 0
    try {
      const u = new URL(url)
      host = u.hostname
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    } catch {
      /* keep url */
    }
    if (err.name === 'TimeoutError') return { target: url, ok: false, ms, message: `No answer within ${HTTP_TIMEOUT / 1000} seconds.` }
    const cause = err.cause
    if (cause?.code && /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(cause.code)) {
      return { target: url, ok: false, ms, message: `The server answers, but its certificate is not trusted by this machine (${cause.code}). The route will need a truststore.` }
    }
    return { target: url, ok: false, ms, message: cause ? explain(cause, host, port) : err.message }
  }
}

export async function testConnection(target: ConnectionTarget): Promise<ConnectionResult> {
  if (target.kind === 'http') {
    const check = await httpCheck(target.url)
    return { ok: check.ok, checks: [check] }
  }
  const checks = await Promise.all(
    target.hosts.map(async (h) => {
      const r = await probe(h.host, h.port, !!target.tls, !!target.greeting)
      return { target: `${h.host}:${h.port}`, ok: r.ok, ms: r.ms, message: r.message, greeting: r.greeting }
    })
  )
  return { ok: checks.every((c) => c.ok), checks }
}
