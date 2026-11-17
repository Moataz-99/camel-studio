// Where an endpoint connects to, worked out from its URI, its options and the project's
// settings (with global variables resolved for the chosen environment).

import type { ConnectionTarget } from '@shared/types'
import { resolveText, resolveVar, type GlobalVars } from './properties'

export interface TargetInfo {
  target: ConnectionTarget | null
  /** Where the address came from, shown next to the result. */
  source: string
  /** Why there is nothing to test, when target is null. */
  note: string | null
}

const hostPort = (text: string, defPort: number): { host: string; port: number } | null => {
  const m = text.trim().match(/^\[?([^\]/:?#\s]+)\]?(?::(\d+))?/)
  return m && m[1] ? { host: m[1], port: m[2] ? Number(m[2]) : defPort } : null
}

/** host:port pairs inside broker URLs like tcp://a:61616, failover:(tcp://a:1,tcp://b:2), amqp://a. */
function brokerHosts(url: string, defPort: number): { host: string; port: number }[] {
  return [...url.matchAll(/(?:tcp|ssl|nio|amqps?|mqtt|stomp|vm):\/\/([^,)\s?/]+)/g)].map((m) => hostPort(m[1], defPort)).filter((h): h is { host: string; port: number } => !!h)
}

/** host and port out of a JDBC URL, for the databases integration teams use most. */
function jdbcHost(url: string): { host: string; port: number; db: string } | { note: string } | null {
  const u = url.trim()
  if (/^jdbc:h2:(mem|file|~)/i.test(u) || /^jdbc:hsqldb:mem/i.test(u) || /^jdbc:derby:memory/i.test(u)) return { note: 'This is an in-memory or file database inside the application: there is no server to reach.' }
  const std = u.match(/^jdbc:(postgresql|mysql|mariadb|db2|sqlserver|h2:tcp):\/\/([^/;?]+)/i)
  const ports: Record<string, number> = { postgresql: 5432, mysql: 3306, mariadb: 3306, db2: 50000, sqlserver: 1433, 'h2:tcp': 9092 }
  if (std) {
    const hp = hostPort(std[2], ports[std[1].toLowerCase()] ?? 0)
    return hp ? { ...hp, db: std[1] } : null
  }
  const oracle = u.match(/^jdbc:oracle:thin:@(?:\/\/)?([^/:?]+)(?::(\d+))?/i)
  if (oracle) return { host: oracle[1], port: oracle[2] ? Number(oracle[2]) : 1521, db: 'oracle' }
  const oracleDesc = u.match(/HOST\s*=\s*([^)\s]+)\)\s*\(PORT\s*=\s*(\d+)/i)
  if (oracleDesc) return { host: oracleDesc[1], port: Number(oracleDesc[2]), db: 'oracle' }
  return null
}

const MAIL: Record<string, { port: number; tls: boolean }> = {
  smtp: { port: 25, tls: false },
  smtps: { port: 465, tls: true },
  imap: { port: 143, tls: false },
  imaps: { port: 993, tls: true },
  pop3: { port: 110, tls: false },
  pop3s: { port: 995, tls: true }
}

/** First of several setting names that has a value in the environment. */
function setting(g: GlobalVars | null, env: string, ...names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const v = resolveVar(g, name, env)
    if (v && v.value.trim()) return { name, value: resolveText(v.value, g, env) }
  }
  return null
}

export function connectionTarget(scheme: string, rawPath: string, rawParams: Record<string, unknown>, g: GlobalVars | null, env: string): TargetInfo | null {
  const path = resolveText(rawPath, g, env)
  const param = (name: string): string | null => {
    const v = rawParams[name]
    return v === undefined || v === null || v === '' ? null : resolveText(String(v), g, env)
  }
  const unresolved = (s: string): boolean => /\{\{[^}]+\}\}/.test(s)
  const needVar = (s: string): TargetInfo => ({ target: null, source: '', note: `The address uses a global variable that has no value in this environment: ${s.match(/\{\{[^}]+\}\}/)?.[0]}` })

  switch (scheme) {
    case 'http':
    case 'https': {
      if (unresolved(path)) return needVar(path)
      const url = `${scheme}://${path.replace(/^\/+/, '')}`
      return { target: { kind: 'http', url }, source: 'the endpoint address', note: null }
    }
    case 'cxf':
    case 'cxfrs':
    case 'soap': {
      const url = path.match(/^(https?:\/\/[^\s?]+)/)?.[1] ?? param('address')
      if (!url) return { target: null, source: '', note: 'The service address is set in a bean, so it cannot be read here.' }
      if (unresolved(url)) return needVar(url)
      return { target: { kind: 'http', url }, source: 'the service address', note: null }
    }
    case 'kafka': {
      const brokers = param('brokers') ?? setting(g, env, 'camel.component.kafka.brokers', 'spring.kafka.bootstrap-servers', 'kafka.brokers')?.value
      if (!brokers) return { target: null, source: '', note: 'No brokers are set: add the Brokers option, or camel.component.kafka.brokers as a global variable.' }
      if (unresolved(brokers)) return needVar(brokers)
      const hosts = brokers.split(',').map((b) => hostPort(b.replace(/^\w+:\/\//, ''), 9092)).filter((h): h is { host: string; port: number } => !!h)
      return { target: { kind: 'tcp', hosts }, source: param('brokers') ? 'the Brokers option' : 'the Kafka brokers setting', note: null }
    }
    case 'jms':
    case 'activemq':
    case 'activemq6':
    case 'amqp':
    case 'sjms':
    case 'sjms2':
    case 'paho':
    case 'paho-mqtt5': {
      const s =
        setting(g, env, `camel.component.${scheme}.broker-url`, `camel.component.${scheme}.remote-uri`, 'spring.artemis.broker-url', 'spring.activemq.broker-url', 'camel.component.activemq.broker-url', 'camel.component.amqp.remote-uri') ??
        (param('brokerUrl') ? { name: 'brokerUrl', value: param('brokerUrl') as string } : null)
      if (!s) return { target: null, source: '', note: 'No broker address found. Set spring.artemis.broker-url (or spring.activemq.broker-url) as a global variable.' }
      if (unresolved(s.value)) return needVar(s.value)
      const def = scheme.startsWith('amqp') ? 5672 : scheme.startsWith('paho') ? 1883 : 61616
      const hosts = brokerHosts(s.value, def)
      if (hosts.length === 0) return { target: null, source: '', note: `“${s.value}” is not a network address (it may be an in-process broker).` }
      return { target: { kind: 'tcp', hosts }, source: s.name, note: null }
    }
    case 'sql':
    case 'sql-stored':
    case 'jdbc':
    case 'spring-jdbc':
    case 'jpa': {
      const s = setting(g, env, 'spring.datasource.url', 'spring.datasource.jdbc-url', 'spring.datasource.hikari.jdbc-url')
      if (!s) return { target: null, source: '', note: 'No database address found. Set spring.datasource.url as a global variable (or the data source is a bean defined in code).' }
      if (unresolved(s.value)) return needVar(s.value)
      const db = jdbcHost(s.value)
      if (!db) return { target: null, source: '', note: `This JDBC URL is not one Camel Studio can read: ${s.value}` }
      if ('note' in db) return { target: null, source: '', note: db.note }
      return { target: { kind: 'tcp', hosts: [{ host: db.host, port: db.port }] }, source: s.name, note: null }
    }
    case 'mongodb': {
      const s = setting(g, env, 'spring.data.mongodb.uri', 'spring.mongodb.uri')
      const host = setting(g, env, 'spring.data.mongodb.host')
      const text = s?.value.replace(/^mongodb(\+srv)?:\/\/([^@]*@)?/, '') ?? host?.value
      if (!text) return { target: null, source: '', note: 'No MongoDB address found. Set spring.data.mongodb.uri as a global variable.' }
      const hosts = text.split('/')[0].split(',').map((h) => hostPort(h, 27017)).filter((h): h is { host: string; port: number } => !!h)
      return { target: { kind: 'tcp', hosts }, source: s?.name ?? 'spring.data.mongodb.host', note: null }
    }
    case 'ftp':
    case 'ftps':
    case 'sftp':
    case 'scp': {
      if (unresolved(path)) return needVar(path)
      const def = scheme === 'sftp' || scheme === 'scp' ? 22 : 21
      const hp = hostPort(path.replace(/^\/\/|^[^@]*@/g, ''), def)
      if (!hp) return { target: null, source: '', note: 'Set the host in the path first.' }
      // Implicit FTPS (port 990) speaks TLS from the start.
      const tls = scheme === 'ftps' && (param('isImplicit') === 'true' || hp.port === 990)
      return { target: { kind: 'tcp', hosts: [hp], greeting: true, tls }, source: 'the endpoint address', note: null }
    }
    case 'smpp':
    case 'smpps': {
      if (unresolved(path)) return needVar(path)
      const hp = hostPort(path.replace(/^\/\/|^[^@]*@/g, ''), 2775)
      if (!hp) return { target: null, source: '', note: 'Set the SMSC host in the path first.' }
      return { target: { kind: 'tcp', hosts: [hp], tls: scheme === 'smpps' }, source: 'the endpoint address', note: null }
    }
    case 'netty':
    case 'netty-http':
    case 'mina': {
      if (unresolved(path)) return needVar(path)
      const m = path.match(/^(tcp|udp|http|https):\/\/(.+)$/)
      if (!m) return null
      if (m[1] === 'udp') return { target: null, source: '', note: 'UDP has no connection to test.' }
      if (m[1].startsWith('http')) return { target: { kind: 'http', url: `${m[1]}://${m[2]}` }, source: 'the endpoint address', note: null }
      const hp = hostPort(m[2], 0)
      return hp ? { target: { kind: 'tcp', hosts: [hp] }, source: 'the endpoint address', note: null } : null
    }
    case 'ldap':
    case 'ldif': {
      const s = setting(g, env, 'spring.ldap.urls')
      if (!s) return { target: null, source: '', note: 'The LDAP server is set in a bean; set spring.ldap.urls as a global variable to test it here.' }
      const m = s.value.match(/ldaps?:\/\/([^/,\s]+)/)
      const hp = m ? hostPort(m[1], s.value.startsWith('ldaps') ? 636 : 389) : null
      return hp ? { target: { kind: 'tcp', hosts: [hp], tls: s.value.startsWith('ldaps') }, source: s.name, note: null } : null
    }
    default: {
      const mail = MAIL[scheme]
      if (mail) {
        if (unresolved(path)) return needVar(path)
        const hp = hostPort(path.replace(/^\/\/|^[^@]*@/g, ''), mail.port)
        if (!hp) return { target: null, source: '', note: 'Set the mail server in the path first.' }
        return { target: { kind: 'tcp', hosts: [hp], greeting: true, tls: mail.tls || hp.port === 465 || hp.port === 993 || hp.port === 995 }, source: 'the endpoint address', note: null }
      }
      return null
    }
  }
}
