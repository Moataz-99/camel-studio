import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Braces, ChevronDown, ChevronRight, CircleAlert, CircleCheck, ExternalLink, Eye, EyeOff, GitCompareArrows, LoaderCircle, Plug, Plus, Search, Trash2, Undo2, X } from 'lucide-react'
import type { ConnectionResult } from '@shared/types'
import { placeholdersIn, resolveVar } from '@/config/properties'
import { connectionTarget } from '@/config/connections'
import { messageData, namesSet, type DataKind } from '@/config/usage'
import { mappingRel, xslRel } from '@/mapper/paths'
import { useMapper } from '@/mapper/store'
import type { CatalogProperty } from '@shared/types'
import {
  ENDPOINT_KINDS,
  describeStep,
  isMapperStep,
  mapperName,
  expr,
  getAt,
  normalizeValue,
  parseEndpoint,
  readDataFormat,
  readExpression,
  stepKind,
  writeEndpointBase,
  writeEndpointParam,
  writeExpression,
  type Catalog,
  type Path,
  type RouteEntry,
  type Y,
  type YamlEditor
} from '@/model/camel'
import { openMapper, studioApi, useActiveFile, useStudio } from '@/store'
import { stepIcon } from './icons'
import { cx, useEntries } from './util'

const edit = (fn: (e: YamlEditor) => void, select?: Parameters<ReturnType<typeof useStudio.getState>['edit']>[1]): void =>
  useStudio.getState().edit(fn, select)

/** Turns what the user typed into the YAML value for an option of the given type. */
function coerce(text: string, type: string): Y {
  const t = text.trim()
  if (t === '') return undefined
  if ((type === 'integer' || type === 'number') && /^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  if (type === 'boolean' && (t === 'true' || t === 'false')) return t === 'true'
  return text
}

const firstSentence = (text: string | undefined): string => {
  if (!text) return ''
  const m = text.match(/^(.+?[.!?])(\s|$)/s)
  return (m ? m[1] : text).slice(0, 260)
}

// ----------------------------------------------------------------- fields --

interface InputApi {
  insert(text: string): void
}

function TextInput(props: {
  value: Y
  placeholder?: string
  mono?: boolean
  secret?: boolean
  multiline?: boolean
  list?: string
  id?: string
  /** Offer the global variables picker and show resolved values. */
  vars?: boolean
  apiRef?: React.MutableRefObject<InputApi | null>
  onCommit(text: string): void
}): React.JSX.Element {
  const external = props.value === undefined || props.value === null ? '' : String(props.value)
  const [draft, setDraft] = useState(external)
  const [reveal, setReveal] = useState(false)
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  useEffect(() => setDraft(external), [external])
  /** Puts text at the cursor (or the end) and saves straight away. */
  const insert = (text: string): void => {
    const node = el.current
    const cur = node?.value ?? draft
    const start = node?.selectionStart ?? cur.length
    const end = node?.selectionEnd ?? cur.length
    const next = cur.slice(0, start) + text + cur.slice(end)
    setDraft(next)
    if (next !== external) props.onCommit(next)
    requestAnimationFrame(() => {
      node?.focus()
      node?.setSelectionRange(start + text.length, start + text.length)
    })
  }
  if (props.apiRef) props.apiRef.current = { insert }
  // Read the element, not the draft: a blur can arrive before the last keystroke has re-rendered.
  const commit = (el: HTMLInputElement | HTMLTextAreaElement): void => {
    if (el.value !== external) props.onCommit(el.value)
  }
  if (props.multiline) {
    return (
      <span className="input-wrap">
      <textarea
        ref={el}
        id={props.id}
        className={cx('input', props.mono && 'mono')}
        rows={Math.min(8, Math.max(2, draft.split('\n').length))}
        value={draft}
        placeholder={props.placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
        }}
      />
      {props.vars && <VarHint text={draft} />}
      </span>
    )
  }
  return (
    <span className="input-wrap">
      <input
        ref={el}
        id={props.id}
        className={cx('input', props.mono && 'mono')}
        type={props.secret && !reveal ? 'password' : 'text'}
        value={draft}
        list={props.list}
        placeholder={props.placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            // Discard: put the saved value back before the blur commits.
            e.currentTarget.value = external
            setDraft(external)
            e.currentTarget.blur()
          }
        }}
      />
      {props.secret && (
        <button className="icon-btn tiny in-input" type="button" title={reveal ? 'Hide' : 'Show'} onClick={() => setReveal((v) => !v)}>
          {reveal ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      )}
      {props.vars && !props.secret && <VarPicker onPick={(name) => insert(`{{${name}}}`)} />}
      {props.vars && <VarHint text={draft} />}
    </span>
  )
}

/** The `{ }` button inside a field: lists the global variables and inserts one as {{name}}. */
function VarPicker({ onPick }: { onPick(name: string): void }): React.JSX.Element {
  const globals = useStudio((s) => s.globals)
  const env = useStudio((s) => s.runEnv)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const vars = (globals?.vars ?? []).filter((v) => !v.framework && (!q || v.name.toLowerCase().includes(q.toLowerCase())))
  return (
    <span className="var-picker">
      <button className="icon-btn tiny in-input" type="button" title="Insert a global variable" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <Braces size={13} />
      </button>
      {open && (
        <div className="menu var-menu" onMouseLeave={() => setOpen(false)}>
          <div className="tree-search">
            <Search size={12} />
            <input autoFocus placeholder="Find a global variable" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {vars.length === 0 && <div className="var-none">{globals?.vars.length ? 'No match.' : 'No global variables yet.'}</div>}
          {vars.slice(0, 40).map((v) => {
            const r = resolveVar(globals, v.name, env)
            return (
              <button
                key={v.name}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(v.name)
                  setOpen(false)
                }}
                title={v.description}
              >
                <span className="mono">{v.name}</span>
                <span className="var-val">{v.secret ? '••••' : (r?.value ?? 'not set')}</span>
              </button>
            )
          })}
          <button className="var-manage" onClick={() => (setOpen(false), useStudio.getState().setGlobalsOpen(true))}>
            Manage global variables…
          </button>
        </div>
      )}
    </span>
  )
}

/** Under a field that uses {{variables}}: what each one is in the chosen environment. */
function VarHint({ text }: { text: string }): React.JSX.Element | null {
  const globals = useStudio((s) => s.globals)
  const env = useStudio((s) => s.runEnv)
  const refs = placeholdersIn(text)
  if (refs.length === 0) return null
  return (
    <span className="var-hint">
      {refs.map((p, i) => {
        const r = resolveVar(globals, p.name, env)
        const secret = globals?.vars.find((v) => v.name === p.name)?.secret
        return (
          <span key={i} className={cx(!r && !p.hasDefault && 'is-missing')}>
            <span className="mono">{p.name}</span> ={' '}
            {r ? (
              <>
                <span className="mono">{secret ? '••••' : r.value || '(empty)'}</span>
                <span className="var-from">{r.from === 'default' ? (env === 'default' ? '' : ' (default)') : ` (${r.from})`}</span>
              </>
            ) : p.hasDefault ? (
              'its default in the expression'
            ) : (
              'not defined'
            )}
          </span>
        )
      })}
    </span>
  )
}

function Field(props: { label: string; required?: boolean; help?: string; isSet?: boolean; onClear?: () => void; inline?: boolean; htmlFor?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className={cx('field', props.inline && 'is-inline', props.isSet && 'is-set')}>
      <div className="field-head">
        <label htmlFor={props.htmlFor} title={props.help}>
          {props.label}
          {props.required && <span className="req">*</span>}
        </label>
        {props.isSet && props.onClear && (
          <button className="icon-btn tiny" title="Reset to default" onClick={props.onClear}>
            <Undo2 size={11} />
          </button>
        )}
        {props.inline && props.children}
      </div>
      {!props.inline && props.children}
      {props.help && <div className="field-help">{firstSentence(props.help)}</div>}
    </div>
  )
}

/** One catalog option rendered as the right control for its type. */
function OptionField({ prop, value, onChange }: { prop: CatalogProperty; value: Y; onChange(v: Y): void }): React.JSX.Element {
  const id = useId()
  const label = prop.displayName ?? prop.name
  const isSet = value !== undefined && value !== null && value !== ''
  const def = prop.defaultValue
  const clear = (): void => onChange(undefined)

  if (prop.type === 'boolean' && (value === undefined || typeof value === 'boolean' || value === 'true' || value === 'false')) {
    const effective = isSet ? value === true || value === 'true' : def === true || def === 'true'
    return (
      <Field label={label} required={prop.required} help={prop.description} isSet={isSet} onClear={clear} inline>
        <button role="switch" aria-checked={effective} className={cx('switch', effective && 'is-on', !isSet && 'is-default')} onClick={() => onChange(!effective)} title={isSet ? undefined : 'Default'}>
          <span />
        </button>
      </Field>
    )
  }
  if (prop.enum && prop.enum.length > 0) {
    return (
      <Field label={label} required={prop.required} help={prop.description} isSet={isSet} onClear={clear} htmlFor={id}>
        <select id={id} className="input" value={isSet ? String(value) : ''} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">{def !== undefined ? `Default (${def})` : 'Not set'}</option>
          {isSet && !prop.enum.includes(String(value)) && <option value={String(value)}>{String(value)}</option>}
          {prop.enum.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </Field>
    )
  }
  return (
    <Field label={label} required={prop.required} help={prop.description} isSet={isSet} onClear={prop.required ? undefined : clear} htmlFor={id}>
      <TextInput
        id={id}
        value={typeof value === 'object' && value !== null ? JSON.stringify(value) : value}
        mono
        secret={prop.secret}
        vars
        placeholder={def !== undefined ? String(def) : prop.type === 'object' ? '#beanName' : prop.type === 'duration' ? 'e.g. 5000 or 5s' : ''}
        onCommit={(text) => onChange(coerce(text, prop.type))}
      />
    </Field>
  )
}

function ExpressionField(props: { label: string; required?: boolean; help?: string; value: Y; prop: string; catalog: Catalog; onChange(language: string, text: string): void }): React.JSX.Element {
  const expr = readExpression(props.value, props.prop, props.catalog.languages)
  const language = expr?.language ?? 'simple'
  const api = useRef<InputApi | null>(null)
  return (
    <Field label={props.label} required={props.required} help={props.help}>
      <div className="expr">
        <select className="input expr-lang" value={language} onChange={(e) => props.onChange(e.target.value, expr?.text ?? '')} title="Expression language">
          {props.catalog.languageList.map((l) => (
            <option key={l.name} value={l.name}>
              {l.title}
            </option>
          ))}
        </select>
        <TextInput value={expr?.text ?? ''} mono multiline vars apiRef={api} placeholder={language === 'simple' ? "${header.type} == 'gold'" : 'expression'} onCommit={(text) => props.onChange(language, text)} />
        <InsertMenu language={language} onPick={(t) => api.current?.insert(t)} />
      </div>
    </Field>
  )
}

function Section(props: { title: string; count?: number; defaultOpen?: boolean; forceOpen?: boolean; children: ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  const shown = props.forceOpen || open
  return (
    <div className={cx('section', shown && 'is-open')}>
      <button className="section-head" onClick={() => setOpen(!open)}>
        {shown ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{props.title}</span>
        {props.count ? <span className="count">{props.count}</span> : null}
      </button>
      {shown && <div className="section-body">{props.children}</div>}
    </div>
  )
}

// --------------------------------------------------------------- endpoint --

const groupRank = (g: string): number => {
  const base = g.replace(' (advanced)', '')
  const rank = base === 'common' ? 0 : base === 'consumer' || base === 'producer' ? 1 : base === 'security' ? 2 : base === 'advanced' ? 8 : 4
  return rank + (g.includes('(advanced)') ? 10 : 0)
}

function EndpointForm({ kind, valuePath, value, catalog }: { kind: string; valuePath: Path; value: Record<string, Y>; catalog: Catalog }): React.JSX.Element {
  const ep = parseEndpoint(value)
  const def = catalog.defs[ep.scheme]
  const entry = catalog.components.get(ep.scheme)
  const loadComponent = useStudio((s) => s.loadComponent)
  const [query, setQuery] = useState('')
  const listId = useId()
  useEffect(() => {
    if (ep.scheme) void loadComponent(ep.scheme)
  }, [ep.scheme, loadComponent])

  const isConsumer = kind === 'from' || kind === 'poll'
  const pathProps = (def?.properties ?? []).filter((p) => p.kind === 'path').sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const options = useMemo(
    () =>
      (def?.properties ?? []).filter((p) => {
        if (p.kind !== 'parameter' || (p.deprecated && ep.params[p.name] === undefined)) return false
        const role = p.label ?? ''
        return isConsumer ? !role.includes('producer') : !role.includes('consumer')
      }),
    [def, isConsumer, ep.params]
  )
  const known = new Set((def?.properties ?? []).map((p) => p.name))
  const unknown = def ? Object.keys(ep.params).filter((k) => !known.has(k)) : []
  const q = query.trim().toLowerCase()
  const visible = q ? options.filter((p) => p.name.toLowerCase().includes(q) || (p.displayName ?? '').toLowerCase().includes(q)) : options
  const groups = [...new Set(visible.map((p) => p.group ?? 'common'))].sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b))
  const syntaxPath = (def?.syntax ?? entry?.syntax ?? '').replace(/^[^:]+:(\/\/)?/, '')

  return (
    <>
      <div className="section-body flat">
        <Field label="Component" required help={entry?.description}>
          <TextInput value={ep.scheme} mono list={listId} placeholder="kafka, http, jms, sql…" onCommit={(scheme) => edit((e) => writeEndpointBase(e, valuePath, kind, scheme.trim().replace(/:$/, ''), ep.path))} />
          <datalist id={listId}>
            {catalog.index.components
              .filter((c) => (isConsumer ? !c.producerOnly : !c.consumerOnly))
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.title}
                </option>
              ))}
          </datalist>
        </Field>
        <Field
          label={pathProps.length === 1 ? (pathProps[0].displayName ?? pathProps[0].name) : 'Path'}
          required={pathProps.some((p) => p.required)}
          help={pathProps.length === 1 ? pathProps[0].description : pathProps.map((p) => `${p.name}: ${firstSentence(p.description)}`).join(' ')}
        >
          <TextInput value={ep.path} mono vars placeholder={syntaxPath} onCommit={(path) => edit((e) => writeEndpointBase(e, valuePath, kind, ep.scheme, path.trim()))} />
        </Field>
      </div>

      {ep.scheme && entry && <TestConnection scheme={ep.scheme} path={ep.path} params={ep.params} />}
      {ep.scheme && !entry && <div className="note warn">“{ep.scheme}” is not a component in the Camel {catalog.index.camelVersion} catalog.</div>}
      {entry && !def && <div className="note">Loading options…</div>}

      {def && (
        <>
          <div className="option-search">
            <Search size={13} />
            <input placeholder={`Filter ${options.length} options`} value={query} onChange={(e) => setQuery(e.target.value)} />
            {query && (
              <button className="icon-btn tiny" onClick={() => setQuery('')}>
                <X size={12} />
              </button>
            )}
          </div>
          {groups.map((g) => {
            const props = visible.filter((p) => (p.group ?? 'common') === g)
            const setCount = props.filter((p) => ep.params[p.name] !== undefined).length
            return (
              <Section key={`${ep.scheme}:${g}`} title={g} count={setCount} defaultOpen={g === 'common' || setCount > 0} forceOpen={!!q}>
                {props.map((p) => (
                  <OptionField key={p.name} prop={p} value={ep.params[p.name]} onChange={(v) => edit((e) => writeEndpointParam(e, valuePath, kind, p.name, v))} />
                ))}
              </Section>
            )
          })}
          {unknown.length > 0 && (
            <Section title="Not in catalog" count={unknown.length}>
              {unknown.map((name) => (
                <OptionField key={name} prop={{ name, kind: 'parameter', type: 'string' }} value={ep.params[name]} onChange={(v) => edit((e) => writeEndpointParam(e, valuePath, kind, name, v))} />
              ))}
            </Section>
          )}
        </>
      )}
    </>
  )
}

// ------------------------------------------------------------- model form --

const STRUCTURAL = new Set(['outputs', 'when', 'otherwise', 'doCatch', 'doFinally', 'onFallback', 'input', 'note'])
const GENERAL = ['id', 'description', 'disabled']

function ModelForm(props: { model: string; kind: string; valuePath: Path; value: Record<string, Y>; catalog: Catalog; skip?: string[] }): React.JSX.Element | null {
  const { catalog, valuePath, value, kind } = props
  const model = catalog.models[props.model]
  if (!model) return <div className="note warn">“{props.model}” is not in the Camel catalog. Edit it in the source view.</div>

  const setAttr = (name: string, v: Y): void =>
    edit((e) => {
      e.ensureObject(valuePath, kind)
      if (v === undefined || v === '') e.del([...valuePath, name])
      else e.set([...valuePath, name], v)
    })

  const skip = new Set(props.skip ?? [])
  const all = model.properties.filter((p) => !STRUCTURAL.has(p.name) && !skip.has(p.name) && !GENERAL.includes(p.name))
  const sourceOnly = all.filter((p) => p.kind === 'element' && p.name !== 'dataFormatType' && p.name !== 'exception')
  const editable = all.filter((p) => !sourceOnly.includes(p) && !(p.deprecated && value[p.name] === undefined))
  const isMain = (p: CatalogProperty): boolean => !!p.required || (p.kind === 'expression' && p.name === 'expression') || p.name === 'dataFormatType' || p.name === 'exception'
  const main = editable.filter(isMain)
  const more = editable.filter((p) => !isMain(p))
  const general = model.properties.filter((p) => GENERAL.includes(p.name))
  const moreSet = more.filter((p) => value[p.name] !== undefined).length

  const render = (p: CatalogProperty): React.JSX.Element => {
    const label = p.displayName ?? p.name
    if (p.kind === 'expression') {
      return (
        <ExpressionField
          key={p.name}
          label={p.name === 'expression' ? 'Expression' : label}
          required={p.required}
          help={p.description}
          value={value}
          prop={p.name}
          catalog={catalog}
          onChange={(language, text) =>
            edit((e) => {
              e.ensureObject(valuePath, kind)
              writeExpression(e, valuePath, p.name, catalog.languages, language, text)
            })
          }
        />
      )
    }
    if (p.name === 'dataFormatType') {
      const current = readDataFormat(value, catalog.dataformats)
      return (
        <Field key={p.name} label="Data format" required help={p.description}>
          <select
            className="input"
            value={current ?? ''}
            onChange={(ev) =>
              edit((e) => {
                e.ensureObject(valuePath, kind)
                const next = ev.target.value
                if (current && current !== next && !e.renameKey(valuePath, current, next)) e.del([...valuePath, current])
                e.set([...valuePath, next], {})
              })
            }
          >
            {!current && <option value="">Choose…</option>}
            {catalog.dataformatList.map((d) => (
              <option key={d.name} value={d.name}>
                {d.title}
              </option>
            ))}
          </select>
        </Field>
      )
    }
    if (p.name === 'exception') {
      const list: string[] = Array.isArray(value.exception) ? value.exception : []
      return (
        <Field key={p.name} label="Exceptions" required={p.required} help="One fully qualified exception class per line.">
          <TextInput
            value={list.join('\n')}
            mono
            multiline
            placeholder="java.io.IOException"
            onCommit={(text) =>
              setAttr(
                'exception',
                text
                  .split(/[\n,]/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            }
          />
        </Field>
      )
    }
    return <OptionField key={p.name} prop={p} value={value[p.name]} onChange={(v) => setAttr(p.name, v)} />
  }

  return (
    <>
      {main.length > 0 && <div className="section-body flat">{main.map(render)}</div>}
      {more.length > 0 && (
        <Section key={`${props.model}:more`} title="Options" count={moreSet} defaultOpen={main.length === 0 || moreSet > 0 || more.length <= 5}>
          {more.map(render)}
        </Section>
      )}
      {general.length > 0 && (
        <Section key={`${props.model}:general`} title="General" count={general.filter((p) => value[p.name] !== undefined).length} defaultOpen={general.some((p) => value[p.name] !== undefined)}>
          {general.map(render)}
        </Section>
      )}
      {sourceOnly.length > 0 && (
        <div className="note">
          Edit in the source view: <span className="mono">{sourceOnly.map((p) => p.name).join(', ')}</span>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------- headers --

function Header(props: { icon: ReactNode; category: string; title: string; kind: string; description?: string; docs?: string; onDelete?: () => void }): React.JSX.Element {
  return (
    <header className={cx('insp-head', `cat-${props.category}`)}>
      <span className="step-icon">{props.icon}</span>
      <div className="insp-title">
        <strong>{props.title}</strong>
        <span className="mono">{props.kind}</span>
      </div>
      {props.docs && (
        <button className="icon-btn" title="Open Camel documentation" onClick={() => void studioApi().openDocs(props.docs as string)}>
          <ExternalLink size={14} />
        </button>
      )}
      {props.onDelete && (
        <button className="icon-btn danger" title="Delete" onClick={props.onDelete}>
          <Trash2 size={14} />
        </button>
      )}
      {props.description && <p className="insp-desc">{props.description}</p>}
    </header>
  )
}

interface MapperSummary {
  source: string | null
  target: string | null
  mapped: number
}

function MapperInspector({ stepPath, value }: { stepPath: Path; value: Record<string, Y> }): React.JSX.Element {
  const name = mapperName(value)
  const root = useStudio((s) => s.project?.root ?? '')
  // Reloads after the mapper saves, so the summary is never behind.
  const savedVersion = useMapper((s) => s.savedJson)
  const [summary, setSummary] = useState<MapperSummary | null>(null)
  useEffect(() => {
    let live = true
    studioApi()
      .project.readFile(`${root}/${mappingRel(name)}`)
      .then((text) => {
        const d = JSON.parse(text)
        if (live) setSummary({ source: d.source?.file ?? null, target: d.target?.file ?? null, mapped: Object.keys(d.rules ?? {}).length })
      })
      .catch(() => live && setSummary({ source: null, target: null, mapped: 0 }))
    return () => {
      live = false
    }
  }, [root, name, savedVersion])
  const file = (p: string | null): string => (p ? (p.split('/').pop() ?? p) : 'not set')
  return (
    <>
      <Header
        icon={<GitCompareArrows size={17} strokeWidth={1.9} />}
        category="transform"
        title="Data Mapper"
        kind={name}
        description="Turns the message into another format by mapping fields visually. Runs as an XSLT 3.0 stylesheet with Camel's xslt-saxon component."
        onDelete={() => useStudio.getState().removeStep(stepPath)}
      />
      <div className="insp-body">
        <div className="section-body flat">
          <div className="map-summary">
            <span>Input</span>
            <strong className={cx(!summary?.source && 'muted')}>{file(summary?.source ?? null)}</strong>
            <span>Output</span>
            <strong className={cx(!summary?.target && 'muted')}>{file(summary?.target ?? null)}</strong>
            <span>Mapped fields</span>
            <strong>{summary?.mapped ?? '…'}</strong>
          </div>
          <button className="btn primary block" onClick={() => void openMapper(name)}>
            <GitCompareArrows size={14} /> Open Data Mapper
          </button>
          <p className="hint">Double-click the step on the canvas to open it too. Files: {mappingRel(name)} and {xslRel(name)}.</p>
        </div>
      </div>
    </>
  )
}

function StepInspector({ kind, stepPath, valuePath, value, catalog }: { kind: string; stepPath: Path; valuePath: Path; value: Record<string, Y>; catalog: Catalog }): React.JSX.Element {
  if (isMapperStep(kind, value)) return <MapperInspector stepPath={stepPath} value={value} />
  const display = describeStep(kind, value, catalog)
  const model = catalog.models[kind]
  const isEndpoint = ENDPOINT_KINDS.has(kind)
  const Icon = stepIcon(kind, display.category, display.scheme, display.componentLabel, display.title)
  const component = isEndpoint && display.scheme ? catalog.components.get(display.scheme) : undefined
  const docs = component
    ? `https://camel.apache.org/components/next/${component.name}-component.html`
    : model
      ? `https://camel.apache.org/components/next/eips/${kind}-eip.html`
      : undefined
  const whenCount = Array.isArray(value.when) ? value.when.length : 0
  const catchCount = Array.isArray(value.doCatch) ? value.doCatch.length : 0

  return (
    <>
      <Header
        icon={<Icon size={17} strokeWidth={1.9} />}
        category={display.category}
        title={kind === 'from' ? `Start: ${display.title}` : display.title}
        kind={kind}
        description={firstSentence(component?.description ?? model?.description)}
        docs={docs}
        onDelete={kind === 'from' ? undefined : () => useStudio.getState().removeStep(stepPath)}
      />
      <div className="insp-body">
        {isEndpoint && <EndpointForm kind={kind} valuePath={valuePath} value={value} catalog={catalog} />}

        {kind === 'choice' && (
          <div className="actions">
            <button className="btn small" onClick={() => edit((e) => e.insert([...valuePath, 'when'], whenCount, { simple: expr(''), steps: [] }), { kind: 'branch', path: [...valuePath, 'when', whenCount] })}>
              <Plus size={13} /> When branch
            </button>
            {value.otherwise === undefined && (
              <button className="btn small" onClick={() => edit((e) => e.set([...valuePath, 'otherwise'], { steps: [] }))}>
                <Plus size={13} /> Otherwise
              </button>
            )}
          </div>
        )}
        {kind === 'doTry' && (
          <div className="actions">
            <button
              className="btn small"
              onClick={() => edit((e) => e.insert([...valuePath, 'doCatch'], catchCount, { exception: ['java.lang.Exception'], steps: [] }), { kind: 'branch', path: [...valuePath, 'doCatch', catchCount] })}
            >
              <Plus size={13} /> Catch
            </button>
            {value.doFinally === undefined && (
              <button className="btn small" onClick={() => edit((e) => e.set([...valuePath, 'doFinally'], { steps: [] }))}>
                <Plus size={13} /> Finally
              </button>
            )}
          </div>
        )}
        {kind === 'circuitBreaker' && value.onFallback === undefined && (
          <div className="actions">
            <button className="btn small" onClick={() => edit((e) => e.set([...valuePath, 'onFallback'], { steps: [] }))}>
              <Plus size={13} /> Fallback
            </button>
          </div>
        )}

        <ModelForm model={kind} kind={kind} valuePath={valuePath} value={value} catalog={catalog} skip={isEndpoint ? ['uri'] : undefined} />
      </div>
    </>
  )
}

const BRANCH_MODELS = ['when', 'otherwise', 'doCatch', 'doFinally', 'onFallback']
const BRANCH_TITLES: Record<string, string> = { when: 'When', otherwise: 'Otherwise', doCatch: 'Catch', doFinally: 'Finally', onFallback: 'Fallback' }

function BranchInspector({ path, value, catalog }: { path: Path; value: Record<string, Y>; catalog: Catalog }): React.JSX.Element {
  const modelName = [...path].reverse().find((p): p is string => typeof p === 'string' && BRANCH_MODELS.includes(p)) ?? 'when'
  const model = catalog.models[modelName]
  const category = /catch|finally|fallback/i.test(modelName) ? 'error' : 'routing'
  const Icon = stepIcon(modelName === 'when' || modelName === 'otherwise' ? 'choice' : 'doTry', category, null, null)
  const remove = (): void => {
    const last = path[path.length - 1]
    edit((e) => (typeof last === 'number' ? e.remove(path.slice(0, -1), last) : e.del(path)), null)
  }
  return (
    <>
      <Header icon={<Icon size={17} strokeWidth={1.9} />} category={category} title={`${BRANCH_TITLES[modelName]} branch`} kind={modelName} description={firstSentence(model?.description)} onDelete={remove} />
      <div className="insp-body">
        <ModelForm model={modelName} kind={modelName} valuePath={path} value={value} catalog={catalog} />
      </div>
    </>
  )
}

const ROUTE_MAIN = ['id', 'description', 'autoStartup']

function RouteInspector({ entry, js, catalog }: { entry: RouteEntry; js: Y[]; catalog: Catalog }): React.JSX.Element {
  const fromPath = entry.fromPath as Path
  const holder: Record<string, Y> = (entry.routePath ? getAt(js, entry.routePath) : getAt(js, fromPath)) ?? {}
  const model = catalog.models.route
  const attrs = (model?.properties ?? []).filter((p) => p.kind === 'attribute' && p.name !== 'note')
  const from = normalizeValue('from', getAt(js, fromPath))
  const trigger = describeStep('from', from, catalog)
  const stepCount = Array.isArray(from.steps) ? from.steps.length : 0
  const Icon = stepIcon('from', 'source', trigger.scheme, trigger.componentLabel)

  const write = (name: string, v: Y): void =>
    edit((e) => {
      const unset = v === undefined || v === ''
      if (entry.routePath) return unset ? e.del([...entry.routePath, name]) : e.set([...entry.routePath, name], v)
      if (name === 'id' || name === 'description') return unset ? e.del([...fromPath, name]) : e.set([...fromPath, name], v)
      if (unset) return
      // A bare `- from:` entry has nowhere to keep route options: promote it to the `- route:` form.
      const { id, description, ...rest } = e.js(fromPath) ?? {}
      e.set([entry.index], { route: { ...(id !== undefined ? { id } : {}), ...(description !== undefined ? { description } : {}), [name]: v, from: rest } })
    })

  const main = attrs.filter((p) => ROUTE_MAIN.includes(p.name)).sort((a, b) => ROUTE_MAIN.indexOf(a.name) - ROUTE_MAIN.indexOf(b.name))
  const more = attrs.filter((p) => !ROUTE_MAIN.includes(p.name))
  const moreSet = more.filter((p) => holder[p.name] !== undefined).length
  return (
    <>
      <Header
        icon={<Icon size={17} strokeWidth={1.9} />}
        category="source"
        title={entry.id}
        kind="route"
        description={`Starts from ${trigger.title}${trigger.subtitle ? ` (${trigger.subtitle})` : ''} · ${stepCount} top-level ${stepCount === 1 ? 'step' : 'steps'}`}
        docs="https://camel.apache.org/manual/routes.html"
        onDelete={() => {
          useStudio.getState().deleteEntry(entry.index)
          useStudio.getState().notify(`Route “${entry.id}” deleted. Undo with ⌘Z.`, 'info')
        }}
      />
      <div className="insp-body">
        <div className="section-body flat">
          {main.map((p) => (
            <OptionField key={p.name} prop={{ ...p, description: p.name === 'id' ? 'Unique name of the route. Shown in logs, metrics and the operations console.' : p.description }} value={holder[p.name]} onChange={(v) => write(p.name, v)} />
          ))}
        </div>
        <Section key={`route:${entry.index}`} title="Route options" count={moreSet} defaultOpen={moreSet > 0}>
          {more.map((p) => (
            <OptionField key={p.name} prop={p} value={holder[p.name]} onChange={(v) => write(p.name, v)} />
          ))}
        </Section>
        <MessageDataSection js={js} fromPath={fromPath} />
        <div className="note">Select a step on the canvas to configure it.</div>
      </div>
    </>
  )
}

// -------------------------------------------------------------- inspector --

export function Inspector(): React.JSX.Element {
  const file = useActiveFile()
  const catalog = useStudio((s) => s.catalog)
  const selection = useStudio((s) => s.selection)
  const activeEntry = useStudio((s) => s.activeEntry)
  const entries = useEntries()

  let body: React.JSX.Element | null = null
  if (file?.js && catalog && file.language === 'yaml') {
    const js = file.js
    if (selection?.kind === 'step') {
      const last = selection.path[selection.path.length - 1]
      if (last === 'from') {
        const raw = getAt(js, selection.path)
        if (raw !== undefined) body = <StepInspector key={selection.path.join('/')} kind="from" stepPath={selection.path} valuePath={selection.path} value={normalizeValue('from', raw)} catalog={catalog} />
      } else {
        const step = getAt(js, selection.path)
        const kind = stepKind(step)
        if (kind) {
          body = <StepInspector key={`${selection.path.join('/')}:${kind}`} kind={kind} stepPath={selection.path} valuePath={[...selection.path, kind]} value={normalizeValue(kind, step[kind])} catalog={catalog} />
        }
      }
    } else if (selection?.kind === 'branch') {
      const value = getAt(js, selection.path)
      if (value && typeof value === 'object') body = <BranchInspector key={selection.path.join('/')} path={selection.path} value={value} catalog={catalog} />
    }
    if (!body) {
      const entry = entries.find((e) => e.index === activeEntry)
      if (entry?.fromPath) body = <RouteInspector key={`route:${entry.index}`} entry={entry} js={js} catalog={catalog} />
    }
  }

  return (
    <aside className="panel inspector">
      {body ?? (
        <div className="insp-empty">
          <strong>Properties</strong>
          <p>Open a route and select a step to configure it here.</p>
        </div>
      )}
    </aside>
  )
}


// ------------------------------------------------------------ expression helper --

const COMMON_HEADERS = ['CamelFileName', 'CamelHttpMethod', 'CamelHttpPath', 'CamelHttpQuery', 'CamelHttpResponseCode', 'Content-Type', 'JMSCorrelationID', 'JMSMessageID', 'kafka.KEY', 'kafka.TOPIC']

/** “Insert” next to an expression: message data, global variables and common functions, no typing needed. */
function InsertMenu({ language, onPick }: { language: string; onPick(text: string): void }): React.JSX.Element {
  const file = useActiveFile()
  const globals = useStudio((s) => s.globals)
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState<string>('message')
  const names = useMemo(() => (file?.js ? namesSet(file.js) : { header: [], variable: [], property: [] }), [file?.js])
  const simple = language === 'simple'
  const groups: { id: string; label: string; items: { label: string; text: string; hint?: string }[] }[] = simple
    ? [
        {
          id: 'message',
          label: 'Message',
          items: [
            { label: 'Body', text: '${body}' },
            { label: 'Body as text', text: '${bodyAs(String)}' },
            { label: 'Body as a number', text: '${bodyAs(Integer)}' },
            { label: 'Route id', text: '${routeId}' },
            { label: 'Exchange id', text: '${exchangeId}' },
            { label: 'Error message', text: '${exception.message}', hint: 'in error handling' }
          ]
        },
        { id: 'header', label: 'Headers', items: [...new Set([...names.header, ...COMMON_HEADERS])].map((h) => ({ label: h, text: `\${header.${h}}`, hint: names.header.includes(h) ? 'set in this file' : undefined })) },
        { id: 'variable', label: 'Variables', items: names.variable.map((v) => ({ label: v, text: `\${variable.${v}}` })) },
        { id: 'property', label: 'Properties', items: names.property.map((v) => ({ label: v, text: `\${exchangeProperty.${v}}` })) },
        { id: 'global', label: 'Global variables', items: (globals?.vars ?? []).filter((v) => !v.framework).map((v) => ({ label: v.name, text: `{{${v.name}}}` })) },
        {
          id: 'function',
          label: 'Functions',
          items: [
            { label: 'Today', text: "${date:now:yyyy-MM-dd}" },
            { label: 'Now, with time', text: "${date:now:yyyy-MM-dd'T'HH:mm:ss}" },
            { label: 'Unique id', text: '${uuid}' },
            { label: 'Random number 1–100', text: '${random(1,100)}' },
            { label: 'Equals', text: " == ''", hint: 'compare' },
            { label: 'Contains', text: " contains ''", hint: 'compare' },
            { label: 'And', text: ' && ' },
            { label: 'Or', text: ' || ' }
          ]
        }
      ]
    : [{ id: 'global', label: 'Global variables', items: (globals?.vars ?? []).filter((v) => !v.framework).map((v) => ({ label: v.name, text: `{{${v.name}}}` })) }]
  const current = groups.find((g) => g.id === group) ?? groups[0]
  return (
    <div className="menu-wrap insert-wrap">
      <button className="btn small" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>
        <Plus size={12} /> Insert
      </button>
      {open && (
        <div className="menu insert-menu" onMouseLeave={() => setOpen(false)}>
          <div className="insert-groups">
            {groups.map((g) => (
              <button key={g.id} className={cx(current.id === g.id && 'is-on')} onMouseDown={(e) => e.preventDefault()} onClick={() => setGroup(g.id)}>
                {g.label}
              </button>
            ))}
          </div>
          <div className="insert-items">
            {current.items.length === 0 && <div className="var-none">{current.id === 'global' ? 'No global variables yet.' : 'None are set in this file.'}</div>}
            {current.items.map((it) => (
              <button
                key={it.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onPick(it.text)
                  setOpen(false)
                }}
              >
                <span>{it.label}</span>
                <span className="mono">{it.text.trim()}</span>
              </button>
            ))}
          </div>
          {!simple && <div className="var-none">Other helpers are for the Simple language.</div>}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------ message data --

const KIND_LABEL: Record<DataKind, string> = { header: 'hdr', variable: 'var', property: 'prop' }

/** BW5 process variables, in Camel terms: what this route sets and reads, and where. */
function MessageDataSection({ js, fromPath }: { js: Y[]; fromPath: Path }): React.JSX.Element | null {
  const items = useMemo(() => messageData(js, fromPath), [js, fromPath])
  const select = useStudio((s) => s.select)
  if (items.length === 0) return null
  return (
    <Section key={`data:${fromPath.join('/')}`} title="Message data" count={items.length} defaultOpen>
      <div className="msgdata">
        {items.map((it) => {
          const readOnly = it.set.length === 0
          return (
            <button key={`${it.kind}:${it.name}`} className="msgdata-row" onClick={() => (it.set[0] ?? it.read[0]) && select({ kind: 'step', path: it.set[0] ?? it.read[0] })} title={readOnly && it.kind !== 'header' ? 'Read here but never set in this route' : undefined}>
              <span className={cx('type-glyph', 't-param')}>{KIND_LABEL[it.kind]}</span>
              <span className="mono msgdata-name">{it.name}</span>
              <span className={cx('msgdata-use', readOnly && it.kind !== 'header' && 'warn')}>
                {it.set.length ? `set ${it.set.length}×` : 'not set here'} · {it.read.length ? `read ${it.read.length}×` : 'not read'}
              </span>
            </button>
          )
        })}
      </div>
      <p className="hint">Headers travel with the message to other systems; variables and properties stay inside the application.</p>
    </Section>
  )
}

// --------------------------------------------------------- test connection --

function TestConnection({ scheme, path, params }: { scheme: string; path: string; params: Record<string, unknown> }): React.JSX.Element | null {
  const globals = useStudio((s) => s.globals)
  const env = useStudio((s) => s.runEnv)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectionResult | null>(null)
  const info = useMemo(() => connectionTarget(scheme, path, params, globals, env), [scheme, path, params, globals, env])
  useEffect(() => setResult(null), [scheme, path, env])
  if (!info) return null
  const run = async (): Promise<void> => {
    if (!info.target) return
    setBusy(true)
    setResult(null)
    try {
      setResult(await studioApi().testConnection(info.target))
    } catch (e) {
      setResult({ ok: false, checks: [{ target: '', ok: false, ms: 0, message: String(e) }] })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="conn">
      <div className="conn-head">
        <button className="btn small" disabled={!info.target || busy} onClick={() => void run()}>
          {busy ? <LoaderCircle size={13} className="spin" /> : <Plug size={13} />} Test connection
        </button>
        {info.target && <span className="hint">{env === 'default' ? 'Default' : env} environment · address from {info.source}</span>}
      </div>
      {!info.target && info.note && <div className="note">{info.note}</div>}
      {result && (
        <div className={cx('conn-result', result.ok ? 'is-ok' : 'is-bad')}>
          {result.checks.map((c, i) => (
            <div key={i} className="conn-check">
              {c.ok ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
              <div>
                <div>
                  {c.message}
                  {c.ok && <span className="conn-ms"> · {c.ms} ms</span>}
                </div>
                {c.greeting && <div className="mono conn-greet">{c.greeting}</div>}
              </div>
            </div>
          ))}
          {result.ok && <div className="conn-note">The server answers. User names and passwords are checked when the route runs.</div>}
        </div>
      )}
    </div>
  )
}
