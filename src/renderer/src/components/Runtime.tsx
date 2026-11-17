// Everything that shows the running application: traced messages, the debugger bar and
// the dialog for sending a test message.

import { useEffect, useMemo, useState } from 'react'
import { CircleAlert, CircleCheck, LoaderCircle, Pause, Play, Send, StepForward, Trash2, X } from 'lucide-react'
import type { SendResult, TraceEvent, TraceException, TraceMessage, TraceValue } from '@shared/types'
import { getAt, normalizeValue, parseEndpoint } from '@/model/camel'
import { studioApi, useActiveFile, useStudio, type ExchangeTrace } from '@/store'
import { cx, formatClock, formatMs, useEntries, useLive } from './util'

// ----------------------------------------------------------- message view --

/**
 * Camel escapes message text once more than JSON needs (Jsoner.escape), so a body arrives with
 * literal backslash sequences. Undo that so the message reads as it was sent.
 */
function unescapeCamel(text: string): string {
  if (!/\\[nrt"\/\\]/.test(text)) return text
  return text.replace(/\\(["\/\\nrt])/g, (_m, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c)
}

function show(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return unescapeCamel(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Camel escapes the stack trace for JSON twice; turn the leftover `\\n` and `\\t` back into real line breaks. */
const stackText = (trace: string | string[]): string =>
  (Array.isArray(trace) ? trace.join('\n') : String(trace)).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\//g, '/')

const shortType = (type: string | undefined): string => (type ? (type.split('.').pop() ?? type) : '')

function ValueTable({ title, rows, open }: { title: string; rows: TraceValue[] | undefined; open?: boolean }): React.JSX.Element | null {
  if (!rows || rows.length === 0) return null
  return (
    <details className="msg-block" open={open}>
      <summary>
        {title} <span className="count">{rows.length}</span>
      </summary>
      <table className="kv">
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.key}:${i}`}>
              <th>{r.key}</th>
              <td>{show(r.value)}</td>
              <td className="kv-type">{shortType(r.type)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

function ExceptionView({ exception }: { exception: TraceException | null }): React.JSX.Element | null {
  if (!exception) return null
  return (
    <div className="msg-error">
      <CircleAlert size={14} />
      <div>
        <strong>{shortType(exception.type) || 'Exception'}</strong>
        <div>{exception.message}</div>
        {exception.stackTrace && exception.stackTrace.length > 0 && (
          <details>
            <summary>Stack trace</summary>
            <pre>{stackText(exception.stackTrace)}</pre>
          </details>
        )}
      </div>
    </div>
  )
}

export function MessageView({ message, exception }: { message: TraceMessage | null; exception: TraceException | null }): React.JSX.Element {
  const body = message?.body
  const text = show(body?.value)
  return (
    <div className="msg">
      <ExceptionView exception={exception} />
      <div className="msg-block">
        <div className="msg-title">
          Body {body?.type && <span className="chip">{shortType(body.type)}</span>}
          {message?.exchangePattern && <span className="chip">{message.exchangePattern}</span>}
        </div>
        {text === '' ? <div className="msg-empty">Empty</div> : <pre className="msg-body">{text}</pre>}
      </div>
      <ValueTable title="Headers" rows={message?.headers} open />
      <ValueTable title="Variables" rows={message?.exchangeVariables} open />
      <ValueTable title="Exchange properties" rows={message?.exchangeProperties} />
    </div>
  )
}

// ------------------------------------------------------------ trace panel --

function ExchangeRow({ x, active, onClick }: { x: ExchangeTrace; active: boolean; onClick(): void }): React.JSX.Element {
  const steps = x.events.filter((e) => !e.last).length
  return (
    <button className={cx('trace-row', active && 'is-active')} onClick={onClick}>
      <span className={cx('trace-dot', x.failed ? 'is-failed' : x.done ? 'is-done' : 'is-open')} />
      <span className="trace-time">{formatClock(x.startedAt)}</span>
      <span className="trace-route">{x.routeId}</span>
      <span className="trace-meta">
        {steps} {steps === 1 ? 'step' : 'steps'} · {x.done ? formatMs(x.elapsed) : 'in flight'}
      </span>
    </button>
  )
}

export function TracePanel(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const runStatus = useStudio((s) => s.runStatus)
  const attached = useStudio((s) => s.attached)
  const exchanges = useStudio((s) => s.exchanges)
  const selectedExchange = useStudio((s) => s.selectedExchange)
  const selectedTraceUid = useStudio((s) => s.selectedTraceUid)
  const debug = useStudio((s) => s.debug)
  const entries = useEntries()
  const live = useLive()
  const { selectExchange, select, setActiveEntry, enableRuntimeTools } = useStudio.getState()

  const exchange = exchanges.find((x) => x.id === selectedExchange) ?? null
  const steps = useMemo(() => exchange?.events.filter((e) => !e.last) ?? [], [exchange])
  const final = exchange?.events.find((e) => e.last) ?? null
  const paused = debug?.suspended.find((s) => s.exchangeId === exchange?.id) ?? null
  const current: TraceEvent | null =
    (selectedTraceUid !== null ? exchange?.events.find((e) => e.uid === selectedTraceUid) : null) ?? paused ?? final ?? steps[steps.length - 1] ?? null

  /** Shows a traced step on the canvas, switching to its route when it lives in the open file. */
  const reveal = (ev: TraceEvent): void => {
    const entry = entries.find((e) => e.id === ev.routeId && e.fromPath)
    if (entry && useStudio.getState().activeEntry !== entry.index) setActiveEntry(entry.index)
    const target = live.locate(ev)
    if (target) select({ kind: target.kind, path: target.path })
  }

  if (project && !project.runtimeTools) {
    return (
      <div className="trace-cta">
        <h3>See messages move through your routes</h3>
        <p>
          Tracing, live statistics, test messages and the debugger use Camel's own tooling connector. Camel Studio adds it as two
          development-only Maven profiles in <span className="mono">pom.xml</span>. They are only active when you run from the IDE, never in a
          normal build.
        </p>
        <button className="btn primary" onClick={() => void enableRuntimeTools()}>
          Enable tracing and debugging
        </button>
      </div>
    )
  }
  if (exchanges.length === 0) {
    const busy = runStatus === 'running' || runStatus === 'starting'
    return (
      <div className="console-empty">
        {busy && !attached && <LoaderCircle size={14} className="spin" />}
        <span>
          {!busy
            ? 'Run the application to capture messages. Every step each message takes is recorded here.'
            : attached
              ? 'Connected. Waiting for the first message. Use “Send message” above the canvas to push one through.'
              : 'Waiting for the application to come up…'}
        </span>
      </div>
    )
  }

  return (
    <div className="trace">
      <div className="trace-list">
        {exchanges
          .slice()
          .reverse()
          .map((x) => (
            <ExchangeRow
              key={x.id}
              x={x}
              active={x.id === selectedExchange}
              onClick={() => {
                selectExchange(x.id)
                const entry = entries.find((e) => e.id === x.routeId && e.fromPath)
                if (entry && useStudio.getState().activeEntry !== entry.index) setActiveEntry(entry.index)
              }}
            />
          ))}
      </div>
      {!exchange ? (
        <div className="trace-hint">Select a message to see the path it took and what it carried at each step.</div>
      ) : (
        <>
          <div className="trace-steps">
            {steps.map((ev, i) => (
              <button
                key={ev.uid}
                className={cx('trace-step', current?.uid === ev.uid && 'is-active', ev.failed && 'is-failed', paused?.uid === ev.uid && 'is-paused')}
                onClick={() => {
                  selectExchange(exchange.id, ev.uid)
                  reveal(ev)
                }}
              >
                <span className="trace-order">{i + 1}</span>
                <span className="trace-label">
                  <strong>{ev.nodeKind || ev.nodeId}</strong>
                  <span>{ev.label}</span>
                </span>
                <span className="trace-meta">{ev.routeId !== exchange.routeId ? ev.routeId : ''}</span>
              </button>
            ))}
            {paused && !steps.some((s) => s.uid === paused.uid) && (
              <button className={cx('trace-step is-paused', current?.uid === paused.uid && 'is-active')} onClick={() => reveal(paused)}>
                <span className="trace-order">
                  <Pause size={10} />
                </span>
                <span className="trace-label">
                  <strong>Paused at {paused.nodeKind || paused.nodeId}</strong>
                  <span>{paused.label}</span>
                </span>
              </button>
            )}
            {final && (
              <button className={cx('trace-step is-final', current?.uid === final.uid && 'is-active', exchange.failed && 'is-failed')} onClick={() => selectExchange(exchange.id, final.uid)}>
                <span className="trace-order">{exchange.failed ? <CircleAlert size={11} /> : <CircleCheck size={11} />}</span>
                <span className="trace-label">
                  <strong>{exchange.failed ? 'Failed' : 'Completed'}</strong>
                  <span>after {formatMs(exchange.elapsed)}</span>
                </span>
              </button>
            )}
          </div>
          <div className="trace-detail">
            {current && (
              <>
                <div className="trace-detail-head">
                  <strong>{current.last ? 'Final message' : paused?.uid === current.uid ? 'Paused before this step' : 'Message entering this step'}</strong>
                  <span className="mono">{current.nodeId}</span>
                  <span className="spacer" />
                  <span>{formatClock(current.timestamp)}</span>
                </div>
                <MessageView message={current.message} exception={current.exception} />
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function TraceTools(): React.JSX.Element | null {
  const count = useStudio((s) => s.exchanges.length)
  if (count === 0) return null
  return (
    <button className="icon-btn" title="Clear captured messages" onClick={() => useStudio.getState().clearTraces()}>
      <Trash2 size={13} />
    </button>
  )
}

// -------------------------------------------------------------- debug bar --

export function DebugBar(): React.JSX.Element | null {
  const debug = useStudio((s) => s.debug)
  const paused = debug?.suspended[0]
  if (!debug || !paused) return null
  const { debugStep, debugResume, selectExchange, setBottom } = useStudio.getState()
  const waiting = debug.suspended.length - 1
  return (
    <div className="debug-bar">
      <span className="debug-pulse" />
      <button
        className="debug-where"
        title="Show the paused message"
        onClick={() => {
          selectExchange(paused.exchangeId)
          setBottom(true, 'trace')
        }}
      >
        Paused at <strong>{paused.nodeKind || paused.nodeId}</strong> in {paused.routeId}
        {waiting > 0 && <span className="debug-more">+{waiting} waiting</span>}
      </button>
      <button className="btn small" onClick={debugStep} title="Run this step and pause at the next one (F10)">
        <StepForward size={13} /> Step
      </button>
      <button className="btn small primary" onClick={debugResume} title="Continue until the next breakpoint (F8)">
        <Play size={12} fill="currentColor" /> Resume
      </button>
    </div>
  )
}

// ------------------------------------------------------------ send dialog --

function parseHeaders(text: string): { key: string; value: string }[] {
  return text
    .split('\n')
    .map((line) => {
      const i = line.search(/[:=]/)
      return i > 0 ? { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : null
    })
    .filter((h): h is { key: string; value: string } => h !== null && h.key !== '')
}

export function SendDialog(): React.JSX.Element | null {
  const open = useStudio((s) => s.sendOpen)
  const attached = useStudio((s) => s.attached)
  const debugging = useStudio((s) => s.attached && s.runMode === 'debug')
  const rtStatus = useStudio((s) => s.rtStatus)
  const activeEntry = useStudio((s) => s.activeEntry)
  const file = useActiveFile()
  const entries = useEntries()
  const [endpoint, setEndpoint] = useState('')
  const [body, setBody] = useState('')
  const [headers, setHeaders] = useState('')
  const [wait, setWait] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SendResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Start from the open route's own endpoint, as written in the YAML.
  const entry = entries.find((e) => e.index === activeEntry)
  const suggested = useMemo(() => {
    if (!file?.js || !entry?.fromPath) return ''
    const ep = parseEndpoint(normalizeValue('from', getAt(file.js, entry.fromPath)))
    return ep.scheme ? `${ep.scheme}:${ep.path}` : ''
  }, [file?.js, entry?.fromPath?.join('/')]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) {
      setEndpoint((current) => current || suggested)
      setResult(null)
      setError(null)
    }
  }, [open, suggested])

  if (!open) return null
  const close = (): void => useStudio.getState().setSendOpen(false)
  const send = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      setResult(await studioApi().runtime.send({ endpoint: endpoint.trim(), body, headers: parseHeaders(headers), exchangePattern: wait && !debugging ? 'InOut' : 'InOnly' }))
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  const failed = result !== null && (result.status !== 'success' || result.exception !== null)

  return (
    <div className="modal-back" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <Send size={15} />
          <strong>Send a test message</strong>
          <span className="spacer" />
          <button className="icon-btn" onClick={close} title="Close">
            <X size={15} />
          </button>
        </header>
        <div className="modal-body">
          <label className="field">
            <span className="field-head">
              <span className="lbl">Endpoint</span>
            </span>
            <input className="input mono" list="send-endpoints" value={endpoint} placeholder="direct:orders" onChange={(e) => setEndpoint(e.target.value)} autoFocus />
            <datalist id="send-endpoints">
              {(rtStatus?.routes ?? []).map((r) => (
                <option key={r.routeId} value={r.from.replace('://', ':')}>
                  {r.routeId}
                </option>
              ))}
            </datalist>
          </label>
          <label className="field">
            <span className="field-head">
              <span className="lbl">Body</span>
            </span>
            <textarea className="input mono" rows={6} value={body} placeholder='{"id": 1001, "customer": {"tier": "gold"}}' spellCheck={false} onChange={(e) => setBody(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-head">
              <span className="lbl">Headers</span>
              <span className="hint">one per line, name: value</span>
            </span>
            <textarea className="input mono" rows={2} value={headers} placeholder="customerTier: gold" spellCheck={false} onChange={(e) => setHeaders(e.target.value)} />
          </label>
          {debugging ? (
            <div className="hint">While debugging, the message is queued so it can stop at your breakpoints. Follow it, and see its result, in the Trace tab.</div>
          ) : (
            <label className="check">
              <input type="checkbox" checked={wait} onChange={(e) => setWait(e.target.checked)} />
              Wait for the reply (request-reply)
            </label>
          )}

          {error && <div className="note warn">{error}</div>}
          {result && (
            <div className={cx('send-result', failed && 'is-failed')}>
              <div className="send-status">
                {failed ? <CircleAlert size={14} /> : <CircleCheck size={14} />}
                <strong>{failed ? 'Failed' : result.relayed ? 'Queued' : wait ? 'Reply received' : 'Sent'}</strong>
                <span>{formatMs(result.elapsed)}</span>
              </div>
              {(result.exception || (wait && result.message)) && <MessageView message={wait && !result.relayed ? result.message : null} exception={result.exception} />}
            </div>
          )}
        </div>
        <footer className="modal-foot">
          {!attached && <span className="hint">The application is not running.</span>}
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" disabled={!attached || busy || endpoint.trim() === ''} onClick={() => void send()}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <Send size={13} />} Send
          </button>
        </footer>
      </div>
    </div>
  )
}
