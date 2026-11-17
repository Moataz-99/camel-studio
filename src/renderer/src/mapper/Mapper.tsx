import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  FileUp,
  GitCompareArrows,
  LoaderCircle,
  PanelBottomClose,
  PanelBottomOpen,
  Play,
  Plus,
  Redo2,
  Repeat2,
  Save,
  Search,
  SquareFunction,
  Trash2,
  Copy,
  Undo2,
  WandSparkles,
  X
} from 'lucide-react'
import { cx } from '@/components/util'
import { useStudio } from '@/store'
import { CodeArea } from './CodeArea'
import { FUNCTION_GROUPS, FUNCTIONS } from './functions'
import { clearSubtree, loopContext, missingRequired, orphanRules, paramField, PARAM_NAME, ruleLines, sourceFields, sourcePrefixes, sourceXPath, updateRule, type Param, type ParamKind, type SimpleValue, type SortKey, type TargetRule } from './model'
import { generateXslt } from './xslt'
import { mappingRel } from './paths'
import { fieldKey, indexFields, KIND_LABELS, sampleMessage, type Field, type SchemaTree } from './schema'
import { useMapper, type Side } from './store'

const DND = 'application/x-camel-studio-field'

// ------------------------------------------------------------------ glyphs --

function typeGlyph(f: Field, format: 'xml' | 'json'): { text: string; cls: string } {
  if (f.attribute) return { text: '@', cls: 't-attr' }
  if (format === 'json' && f.type === 'object') return { text: '{ }', cls: 't-obj' }
  if (format === 'json' && f.type === 'array') return { text: '[ ]', cls: 't-arr' }
  if (f.container) return { text: '< >', cls: 't-obj' }
  if (/^(number|integer|int|long|short|decimal|double|float|byte|unsignedInt|positiveInteger|nonNegativeInteger)$/.test(f.type)) return { text: '123', cls: 't-num' }
  if (f.type === 'boolean') return { text: 'y/n', cls: 't-bool' }
  if (/date|time/i.test(f.type)) return { text: 'date', cls: 't-date' }
  return { text: 'abc', cls: 't-str' }
}

/** Label for an input field: a parameter shows as header/variable name, a body field as its path. */
const sourceLabel = (tree: SchemaTree | null, segs: string[]): string => (segs[0] === '$' ? `${segs[1]}` : pathNames(tree, segs))

const pathNames = (tree: SchemaTree | null, segs: string[]): string => {
  if (!tree) return ''
  const index = indexFields(tree.root)
  const names: string[] = []
  for (let i = 1; i <= segs.length; i++) {
    const f = index.get(fieldKey(segs.slice(0, i)))
    if (f && !(f.repeating && tree.format === 'json')) names.push(f.name)
  }
  return names.join(' › ') || tree.root.name
}

// ------------------------------------------------------------------- tree --

interface Row {
  field: Field
  depth: number
}

function visibleRows(tree: SchemaTree, side: Side, collapsed: Record<string, boolean>, query: string): Row[] {
  const q = query.trim().toLowerCase()
  const rows: Row[] = []
  const matches = (f: Field): boolean => f.name.toLowerCase().includes(q) || f.children.some(matches)
  const walk = (f: Field, depth: number): void => {
    if (q && !matches(f)) return
    rows.push({ field: f, depth })
    if (!q && collapsed[`${side}:${f.key}`]) return
    f.children.forEach((c) => walk(c, depth + 1))
  }
  walk(tree.root, 0)
  return rows
}

function RuleChip({ rule, tree }: { rule: TargetRule | undefined; tree: SchemaTree | null }): React.JSX.Element | null {
  if (!rule) return null
  const parts: ReactNode[] = []
  if (rule.forEach) {
    parts.push(
      <span key="loop" className="rule-chip loop" title="Repeats once for each item of this source collection">
        <Repeat2 size={11} /> each {pathNames(tree, rule.forEach)}
        {rule.sort?.length ? ' · sorted' : ''}
      </span>
    )
  }
  const v = rule.value
  if (v?.kind === 'field') {
    parts.push(
      <span key="v" className="rule-chip field" title={sourceLabel(tree, v.source)}>
        <span className="chip-text">← {sourceLabel(tree, v.source)}</span>
      </span>
    )
  }
  if (v?.kind === 'copy') {
    parts.push(
      <span key="v" className="rule-chip field" title="The whole structure is copied as it is">
        <Copy size={11} /> copy of {pathNames(tree, v.source)}
      </span>
    )
  }
  if (v?.kind === 'choose') {
    parts.push(
      <span key="v" className="rule-chip cond" title="The value depends on conditions">
        {v.cases.length} {v.cases.length === 1 ? 'case' : 'cases'}
        {v.otherwise ? ' + otherwise' : ''}
      </span>
    )
  }
  if (v?.kind === 'formula') {
    parts.push(
      <span key="v" className="rule-chip formula" title={v.expr}>
        <SquareFunction size={11} /> <span className="chip-text">{v.expr}</span>
      </span>
    )
  }
  if (v?.kind === 'constant') {
    parts.push(
      <span key="v" className="rule-chip constant" title={v.text}>
        <span className="chip-text">“{v.text}”</span>
      </span>
    )
  }
  if (rule.condition) {
    parts.push(
      <span key="c" className="rule-chip cond" title={`Only written when ${rule.condition}`}>
        if
      </span>
    )
  }
  return <>{parts}</>
}

const KIND_HELP: Record<ParamKind, string> = {
  header: 'a message header, such as CamelFileName or JMSCorrelationID',
  variable: 'an exchange variable set earlier in the route',
  property: 'an exchange property set earlier in the route'
}

/** Headers, variables and properties the mapping reads besides the message body. */
function ParamsSection(): React.JSX.Element {
  // Select stored values only: a selector that builds a new list each time makes React re-render forever.
  const def = useMapper((s) => s.def)
  const params = useMemo(() => def?.params ?? [], [def])
  const sourceSelected = useMapper((s) => s.sourceSelected)
  const usedSources = useMemo(() => new Set(def ? ruleLines(def).map((l) => l.source) : []), [def])
  const { change, selectSource } = useMapper.getState()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ParamKind>('header')
  const valid = PARAM_NAME.test(name.trim()) && !params.some((p) => p.name === name.trim())
  const setParams = (fn: (p: Param[]) => Param[]): void => change((d) => ({ ...d, params: fn(d.params ?? []) }))
  const add = (): void => {
    if (!valid) return
    setParams((p) => [...p, { name: name.trim(), kind }])
    setName('')
    setAdding(false)
  }
  return (
    <div className="params">
      <div className="params-head">
        <span>Headers and variables</span>
        <span className="spacer" />
        <button className="icon-btn tiny" title="Use a header, variable or property as an input" onClick={() => setAdding(!adding)}>
          <Plus size={13} />
        </button>
      </div>
      {adding && (
        <div className="param-add">
          <select className="input mini" value={kind} onChange={(e) => setKind(e.target.value as ParamKind)} title={KIND_HELP[kind]}>
            <option value="header">Header</option>
            <option value="variable">Variable</option>
            <option value="property">Property</option>
          </select>
          <input
            className="input mini mono"
            autoFocus
            placeholder={kind === 'header' ? 'CamelFileName' : 'customerId'}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
              if (e.key === 'Escape') setAdding(false)
            }}
          />
          <button className="btn small" disabled={!valid} onClick={add}>
            Add
          </button>
        </div>
      )}
      {params.length === 0 && !adding && <div className="params-empty">Only the message body is used. Press + to also read a header or variable.</div>}
      {params.map((p) => {
        const f = paramField(p)
        return (
          <div
            key={f.key}
            data-key={f.key}
            className={cx('tree-row param-row', sourceSelected === f.key && 'is-active', usedSources.has(f.key) && 'is-used')}
            style={{ paddingLeft: 8 }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND, f.key)
              e.dataTransfer.effectAllowed = 'link'
            }}
            onClick={() => selectSource(sourceSelected === f.key ? null : f.key)}
            title={`${p.kind} ${p.name}: ${KIND_HELP[p.kind]}`}
          >
            <span className="twisty-btn" />
            <span className={cx('type-glyph', 't-param')}>{p.kind === 'header' ? 'hdr' : p.kind === 'variable' ? 'var' : 'prop'}</span>
            <span className="field-name">{p.name}</span>
            {p.sample && <span className="field-example">{p.sample}</span>}
            <button
              className="icon-btn tiny param-del"
              title="Remove this input"
              onClick={(e) => {
                e.stopPropagation()
                setParams((list) => list.filter((x) => x.name !== p.name))
              }}
            >
              <X size={12} />
            </button>
            <span className="anchor" />
          </div>
        )
      })}
    </div>
  )
}

function TreePane({ side }: { side: Side }): React.JSX.Element {
  const tree = useMapper((s) => s[side])
  const error = useMapper((s) => (side === 'source' ? s.sourceError : s.targetError))
  const ref = useMapper((s) => s.def?.[side] ?? null)
  const def = useMapper((s) => s.def)
  const collapsed = useMapper((s) => s.collapsed)
  const selected = useMapper((s) => s.selected)
  const sourceSelected = useMapper((s) => s.sourceSelected)
  const sourceTree = useMapper((s) => s.source)
  const { toggle, select, selectSource, connect, importSchema, setPaste, setRoot, removeSchema } = useMapper.getState()
  const [query, setQuery] = useState('')
  const [dropKey, setDropKey] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)

  const rows = useMemo(() => (tree ? visibleRows(tree, side, collapsed, query) : []), [tree, side, collapsed, query])
  const mappedBelow = useCallback(
    (f: Field): boolean => {
      if (!def) return false
      if (side === 'target') return f.children.some((c) => !!def.rules[c.key] || mappedBelow(c))
      return false
    },
    [def, side]
  )
  const usedSources = useMemo(() => new Set(def ? ruleLines(def).map((l) => l.source) : []), [def])

  const title = side === 'source' ? 'Input' : 'Output'
  const header = (
    <header className="tree-head">
      <span className="tree-side">{title}</span>
      {tree && ref && (
        <>
          <span className="chip">{tree.format.toUpperCase()}</span>
          <span className="tree-file" title={ref.file}>
            {KIND_LABELS[ref.kind]} · {ref.file.split('/').pop()}
          </span>
        </>
      )}
      <span className="spacer" />
      {tree && tree.roots.length > 1 && (
        <select className="input mini" value={tree.root.name} onChange={(e) => void setRoot(side, e.target.value)} title="Root element">
          {tree.roots.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      )}
      {tree && (
        <div className="menu-wrap">
          <button className="btn small" onClick={() => setMenu(!menu)}>
            Change <ChevronDown size={12} />
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => (setMenu(false), void importSchema(side))}>
                <FileUp size={14} /> Import a file…
              </button>
              <button onClick={() => (setMenu(false), setPaste(side))}>
                <ClipboardPaste size={14} /> Paste an example…
              </button>
              <button className="danger" onClick={() => (setMenu(false), removeSchema(side))}>
                <Trash2 size={14} /> Remove (clears all mappings)
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  )

  if (!tree) {
    return (
      <section className={cx('tree-pane', side)}>
        {header}
        <div className="tree-empty-card">
          <strong>{side === 'source' ? 'What does the incoming message look like?' : 'What should the outgoing message look like?'}</strong>
          <p>Use an XML Schema (XSD), a JSON Schema, or simply an example message in XML or JSON.</p>
          {error && <div className="note warn">{error}</div>}
          <div className="empty-actions">
            <button className="btn primary" onClick={() => void importSchema(side)}>
              <FileUp size={14} /> Import a file…
            </button>
            <button className="btn" onClick={() => setPaste(side)}>
              <ClipboardPaste size={14} /> Paste an example
            </button>
          </div>
        </div>
      </section>
    )
  }

  const onDrop = (e: DragEvent, f: Field): void => {
    const key = e.dataTransfer.getData(DND)
    setDropKey(null)
    if (!key) return
    e.preventDefault()
    connect(key, f.key)
  }

  return (
    <section className={cx('tree-pane', side)}>
      {header}
      <div className="tree-search">
        <Search size={13} />
        <input placeholder={`Find a field in the ${title.toLowerCase()}`} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && (
          <button className="icon-btn tiny" onClick={() => setQuery('')}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="tree-rows" data-pane={side}>
        {side === 'source' && <ParamsSection />}
        {rows.map(({ field: f, depth }) => {
          const glyph = typeGlyph(f, tree.format)
          const isCollapsed = !query && collapsed[`${side}:${f.key}`]
          const rule = side === 'target' ? def?.rules[f.key] : undefined
          const active = side === 'target' ? selected === f.key : sourceSelected === f.key
          const repeat = f.repeating || (tree.format === 'json' && f.type === 'array')
          return (
            <div
              key={f.key}
              data-key={f.key}
              className={cx('tree-row', active && 'is-active', dropKey === f.key && 'is-drop', side === 'source' && usedSources.has(f.key) && 'is-used', rule && 'has-rule')}
              style={{ paddingLeft: 8 + depth * 16 }}
              draggable={side === 'source'}
              onDragStart={(e) => {
                e.dataTransfer.setData(DND, f.key)
                e.dataTransfer.effectAllowed = 'link'
              }}
              onDragOver={(e) => {
                if (side !== 'target' || !e.dataTransfer.types.includes(DND)) return
                e.preventDefault()
                setDropKey(f.key)
              }}
              onDragLeave={() => setDropKey((k) => (k === f.key ? null : k))}
              onDrop={(e) => side === 'target' && onDrop(e, f)}
              onClick={() => (side === 'target' ? select(f.key) : selectSource(sourceSelected === f.key ? null : f.key))}
              onDoubleClick={() => side === 'target' && sourceSelected && connect(sourceSelected, f.key)}
              title={f.doc}
            >
              {f.container ? (
                <button
                  className="twisty-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(side, f.key)
                  }}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                </button>
              ) : (
                <span className="twisty-btn" />
              )}
              <span className={cx('type-glyph', glyph.cls)}>{glyph.text}</span>
              <span className="field-name">
                {f.name}
                {side === 'target' && f.required && <span className="req">*</span>}
              </span>
              {repeat && <span className="repeat-badge">{f.repeating ? 'each' : 'list'}</span>}
              {side === 'source' && f.example && !f.container && <span className="field-example">{f.example}</span>}
              {side === 'target' && <RuleChip rule={rule} tree={sourceTree} />}
              {side === 'target' && isCollapsed && mappedBelow(f) && <span className="below-dot" title="Fields inside are mapped" />}
              <span className="anchor" />
            </div>
          )
        })}
        {rows.length === 0 && <div className="tree-none">No field matches “{query}”.</div>}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ lines --

interface DrawnLine {
  id: string
  d: string
  kind: 'value' | 'loop'
  active: boolean
  clipped: boolean
}

function Lines({ host }: { host: React.RefObject<HTMLDivElement | null> }): React.JSX.Element {
  const def = useMapper((s) => s.def)
  const collapsed = useMapper((s) => s.collapsed)
  const selected = useMapper((s) => s.selected)
  const sourceSelected = useMapper((s) => s.sourceSelected)
  const source = useMapper((s) => s.source)
  const target = useMapper((s) => s.target)
  const [lines, setLines] = useState<DrawnLine[]>([])
  const [tick, setTick] = useState(0)

  // Redraw when either tree scrolls or the window resizes.
  useEffect(() => {
    const el = host.current
    if (!el) return
    let frame = 0
    const bump = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setTick((t) => t + 1))
    }
    const panes = el.querySelectorAll('.tree-rows')
    panes.forEach((p) => p.addEventListener('scroll', bump, { passive: true }))
    const ro = new ResizeObserver(bump)
    ro.observe(el)
    return () => {
      panes.forEach((p) => p.removeEventListener('scroll', bump))
      ro.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [host, source, target])

  useLayoutEffect(() => {
    const el = host.current
    if (!el || !def || !source || !target) return setLines([])
    const box = el.getBoundingClientRect()
    const srcPane = el.querySelector('.tree-rows[data-pane="source"]') as HTMLElement | null
    const tgtPane = el.querySelector('.tree-rows[data-pane="target"]') as HTMLElement | null
    if (!srcPane || !tgtPane) return setLines([])
    const sBox = srcPane.getBoundingClientRect()
    const tBox = tgtPane.getBoundingClientRect()

    /** The row of a field, or of its nearest ancestor that is on screen (when a parent is collapsed). */
    const rowOf = (pane: HTMLElement, key: string): HTMLElement | null => {
      let segs: string[] = JSON.parse(key)
      for (;;) {
        const row = pane.querySelector(`[data-key="${CSS.escape(fieldKey(segs))}"]`) as HTMLElement | null
        if (row) return row
        if (segs.length === 0) return null
        segs = segs.slice(0, -1)
      }
    }
    const out: DrawnLine[] = []
    for (const l of ruleLines(def)) {
      const a = rowOf(srcPane, l.source)
      const b = rowOf(tgtPane, l.target)
      if (!a || !b) continue
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const clamp = (y: number, pane: DOMRect): number => Math.min(Math.max(y, pane.top + 4), pane.bottom - 4)
      const ya = clamp(ra.top + ra.height / 2, sBox)
      const yb = clamp(rb.top + rb.height / 2, tBox)
      const clipped = ya !== ra.top + ra.height / 2 || yb !== rb.top + rb.height / 2
      const x1 = sBox.right - box.left
      const x2 = tBox.left - box.left
      const y1 = ya - box.top
      const y2 = yb - box.top
      const mid = (x2 - x1) / 2
      out.push({
        id: `${l.kind}:${l.source}>${l.target}`,
        d: `M${x1},${y1} C${x1 + mid},${y1} ${x2 - mid},${y2} ${x2},${y2}`,
        kind: l.kind,
        active: selected === l.target || sourceSelected === l.source,
        clipped
      })
    }
    setLines(out)
  }, [host, def, collapsed, selected, sourceSelected, source, target, tick])

  return (
    <svg className="map-lines" aria-hidden>
      {lines.map((l) => (
        <path key={l.id} d={l.d} className={cx('map-line', l.kind, l.active && 'is-active', l.clipped && 'is-clipped')} />
      ))}
    </svg>
  )
}

// ---------------------------------------------------------------- details --

function quoteXPath(v: string): string {
  return /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : `'${v.replace(/'/g, "''")}'`
}

function ConditionBuilder({ fieldXPath, onAdd }: { fieldXPath: string | null; onAdd(expr: string): void }): React.JSX.Element {
  const [op, setOp] = useState('=')
  const [value, setValue] = useState('')
  const build = (): string | null => {
    if (!fieldXPath) return null
    switch (op) {
      case 'exists':
        return `exists(${fieldXPath})`
      case 'empty':
        return `empty(${fieldXPath})`
      case 'contains':
        return `contains(${fieldXPath}, ${quoteXPath(value)})`
      default:
        return `${fieldXPath} ${op} ${quoteXPath(value)}`
    }
  }
  const expr = build()
  return (
    <div className="cond-builder">
      <span className={cx('cond-field', !fieldXPath && 'is-empty')}>{fieldXPath ?? 'select a source field'}</span>
      <select className="input mini" value={op} onChange={(e) => setOp(e.target.value)}>
        <option value="=">equals</option>
        <option value="!=">is not</option>
        <option value=">">greater than</option>
        <option value="<">less than</option>
        <option value="contains">contains</option>
        <option value="exists">is present</option>
        <option value="empty">is missing</option>
      </select>
      {op !== 'exists' && op !== 'empty' && <input className="input mini mono" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />}
      <button className="btn small" disabled={!expr} onClick={() => expr && onAdd(expr)}>
        Use
      </button>
    </div>
  )
}

/** One value inside a conditional: an input field, a formula or a fixed text. */
function SimpleValueEditor(props: { value: SimpleValue; selected: Field | null; label(segs: string[]): string; xpathOf(segs: string[]): string; onChange(v: SimpleValue): void }): React.JSX.Element {
  const v = props.value
  return (
    <div className="sv">
      <select
        className="input mini"
        value={v.kind}
        onChange={(e) => {
          const k = e.target.value
          if (k === 'constant') props.onChange({ kind: 'constant', text: v.kind === 'constant' ? v.text : '' })
          else if (k === 'formula') props.onChange({ kind: 'formula', expr: v.kind === 'field' ? props.xpathOf(v.source) : v.kind === 'constant' ? quoteXPath(v.text) : v.expr })
          else if (props.selected?.text) props.onChange({ kind: 'field', source: props.selected.segs })
        }}
      >
        <option value="constant">Text</option>
        <option value="formula">Formula</option>
        <option value="field" disabled={!props.selected?.text && v.kind !== 'field'}>
          Field
        </option>
      </select>
      {v.kind === 'constant' && <input className="input mini" value={v.text} placeholder="value" onChange={(e) => props.onChange({ kind: 'constant', text: e.target.value })} />}
      {v.kind === 'formula' && <input className="input mini mono" value={v.expr} placeholder="formula" onChange={(e) => props.onChange({ kind: 'formula', expr: e.target.value })} />}
      {v.kind === 'field' && (
        <button className="rule-chip field" title="Select another input field and click to use it" onClick={() => props.selected?.text && props.onChange({ kind: 'field', source: props.selected.segs })}>
          ← {props.label(v.source)}
        </button>
      )}
    </div>
  )
}

/** choose / when / otherwise, shown as a list of “when … then …” rows. */
function ChooseEditor(props: {
  value: { kind: 'choose'; cases: { test: string; value: SimpleValue }[]; otherwise?: SimpleValue }
  fieldXPath: string | null
  selected: Field | null
  label(segs: string[]): string
  xpathOf(segs: string[]): string
  onChange(v: { kind: 'choose'; cases: { test: string; value: SimpleValue }[]; otherwise?: SimpleValue }): void
}): React.JSX.Element {
  const { value, onChange } = props
  const setCase = (i: number, patch: Partial<{ test: string; value: SimpleValue }>): void =>
    onChange({ ...value, cases: value.cases.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const [building, setBuilding] = useState<number | null>(null)
  return (
    <div className="choose">
      {value.cases.map((c, i) => (
        <div key={i} className="case">
          <div className="case-head">
            <span className="case-kw">{i === 0 ? 'When' : 'Else when'}</span>
            <span className="spacer" />
            <button className="icon-btn tiny" title="Build the test from the selected input field" onClick={() => setBuilding(building === i ? null : i)}>
              <WandSparkles size={12} />
            </button>
            <button className="icon-btn tiny" title="Remove this case" onClick={() => onChange({ ...value, cases: value.cases.filter((_, j) => j !== i) })}>
              <X size={12} />
            </button>
          </div>
          <input className="input mono" value={c.test} placeholder=".?tier = 'gold'" onChange={(e) => setCase(i, { test: e.target.value })} />
          {building === i && (
            <ConditionBuilder
              fieldXPath={props.fieldXPath}
              onAdd={(expr) => {
                setCase(i, { test: c.test ? `${c.test} and ${expr}` : expr })
                setBuilding(null)
              }}
            />
          )}
          <div className="case-then">
            <span className="case-kw">then</span>
            <SimpleValueEditor value={c.value} selected={props.selected} label={props.label} xpathOf={props.xpathOf} onChange={(v) => setCase(i, { value: v })} />
          </div>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange({ ...value, cases: [...value.cases, { test: '', value: { kind: 'constant', text: '' } }] })}>
        <Plus size={12} /> Add a case
      </button>
      <div className="case">
        <div className="case-then">
          <span className="case-kw">Otherwise</span>
          {value.otherwise ? (
            <>
              <SimpleValueEditor value={value.otherwise} selected={props.selected} label={props.label} xpathOf={props.xpathOf} onChange={(v) => onChange({ ...value, otherwise: v })} />
              <button className="icon-btn tiny" title="Leave the field empty when no case applies" onClick={() => onChange({ ...value, otherwise: undefined })}>
                <X size={12} />
              </button>
            </>
          ) : (
            <button className="btn small" onClick={() => onChange({ ...value, otherwise: { kind: 'constant', text: '' } })}>
              Set a value
            </button>
          )}
        </div>
        {!value.otherwise && <span className="hint">When no case applies, the field is left empty (JSON: left out).</span>}
      </div>
    </div>
  )
}

/** Sort keys of a loop: the items are written in this order. */
function SortEditor(props: { keys: SortKey[]; options: Field[]; itemIsValue: boolean; loop: string[]; onChange(keys: SortKey[]): void }): React.JSX.Element {
  const { keys, onChange } = props
  const set = (i: number, patch: Partial<SortKey>): void => onChange(keys.map((k, j) => (j === i ? { ...k, ...patch } : k)))
  const numeric = (f: Field | undefined): boolean => !!f && /^(number|integer|int|long|short|decimal|double|float)$/.test(f.type)
  return (
    <div className="sort">
      {keys.map((k, i) => (
        <div key={i} className="sort-row">
          <span className="case-kw">{i === 0 ? 'Sort by' : 'then by'}</span>
          <select
            className="input mini"
            value={k.source ? fieldKey(k.source) : '__self'}
            onChange={(e) => {
              if (e.target.value === '__self') return set(i, { source: props.loop, expr: undefined })
              const f = props.options.find((o) => o.key === e.target.value)
              set(i, { source: f?.segs, expr: undefined, type: numeric(f) ? 'number' : k.type })
            }}
          >
            {props.itemIsValue && <option value="__self">the item itself</option>}
            {props.options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>
          <select className="input mini" value={k.order} onChange={(e) => set(i, { order: e.target.value as SortKey['order'] })}>
            <option value="ascending">A → Z, 1 → 9</option>
            <option value="descending">Z → A, 9 → 1</option>
          </select>
          <select className="input mini" value={k.type} onChange={(e) => set(i, { type: e.target.value as SortKey['type'] })} title="Compare as text or as numbers">
            <option value="text">as text</option>
            <option value="number">as numbers</option>
          </select>
          <button className="icon-btn tiny" title="Remove" onClick={() => onChange(keys.filter((_, j) => j !== i))}>
            <X size={12} />
          </button>
        </div>
      ))}
      <button
        className="btn small"
        disabled={props.options.length === 0 && !props.itemIsValue}
        onClick={() => {
          const first = props.options[0]
          onChange([...keys, { source: first ? first.segs : props.loop, order: 'ascending', type: numeric(first) ? 'number' : 'text' }])
        }}
      >
        <Plus size={12} /> {keys.length ? 'Add another sort' : 'Sort the items'}
      </button>
    </div>
  )
}

function FunctionList({ onPick }: { onPick(insert: string): void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const list = FUNCTIONS.filter((f) => !q || f.name.includes(q.toLowerCase()) || f.description.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="fn-list">
      <div className="tree-search">
        <Search size={13} />
        <input placeholder="Find a function" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="fn-scroll">
        {FUNCTION_GROUPS.map((g) => {
          const items = list.filter((f) => f.group === g)
          if (items.length === 0) return null
          return (
            <div key={g}>
              <div className="fn-group">{g}</div>
              {items.map((f) => (
                <button key={f.name} className="fn-item" onClick={() => onPick(f.insert)} title={f.signature}>
                  <span className="mono">{f.name}</span>
                  <span>{f.description}</span>
                </button>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Details(): React.JSX.Element {
  const def = useMapper((s) => s.def)
  const source = useMapper((s) => s.source)
  const target = useMapper((s) => s.target)
  const selected = useMapper((s) => s.selected)
  const sourceSelected = useMapper((s) => s.sourceSelected)
  const { change, connect, autoMap } = useMapper.getState()
  const formulaRef = useRef<HTMLTextAreaElement>(null)
  const [showFns, setShowFns] = useState(false)

  const tIndex = useMemo(() => (target ? indexFields(target.root) : new Map<string, Field>()), [target])
  const sIndex = useMemo(() => (source && def ? sourceFields(source, def) : new Map<string, Field>()), [source, def])
  const prefixes = useMemo(() => sourcePrefixes(source), [source])
  const field = selected ? tIndex.get(selected) : undefined

  if (!def || !source || !target) {
    return (
      <aside className="map-details">
        <div className="map-intro">
          <GitCompareArrows size={22} />
          <strong>Map one message onto another</strong>
          <ol>
            <li>Describe the input on the left and the output on the right: a schema file or an example message.</li>
            <li>Drag fields from the input onto the output. Drop a structure on a structure to match its fields by name.</li>
            <li>Select an output field to give it a formula, a fixed text or a condition.</li>
          </ol>
          <p>The preview below runs your mapping on an example message with the same engine Camel uses.</p>
        </div>
      </aside>
    )
  }

  const orphans = orphanRules(def, source, target)
  if (!field) {
    const mapped = Object.keys(def.rules).length
    return (
      <aside className="map-details">
        <div className="map-intro">
          <strong>{mapped === 0 ? 'Nothing mapped yet' : `${mapped} output ${mapped === 1 ? 'field has' : 'fields have'} a mapping`}</strong>
          <p>Drag an input field onto an output field. Dropping a structure on a structure matches the fields inside by name, and a list onto a list repeats the output once per item.</p>
          <button className="btn" onClick={autoMap}>
            <WandSparkles size={14} /> Match all fields by name
          </button>
          {orphans.length > 0 && <div className="note warn">{orphans.length} mapping(s) refer to fields that are no longer in the structures. They are ignored.</div>}
          {(() => {
            const missing = missingRequired(def, target)
            if (missing.length === 0) return mapped > 0 ? <div className="note ok-note">Every required output field has a value.</div> : null
            return (
              <div className="missing">
                <strong>
                  {missing.length} required output {missing.length === 1 ? 'field has' : 'fields have'} no value
                </strong>
                {missing.slice(0, 12).map((f) => (
                  <button key={f.key} className="missing-row" onClick={() => useMapper.getState().select(f.key)}>
                    {pathNames(target, f.segs)}
                  </button>
                ))}
                {missing.length > 12 && <span className="hint">and {missing.length - 12} more</span>}
              </div>
            )
          })()}
          <p className="hint">Select an output field to see and edit its mapping.</p>
        </div>
      </aside>
    )
  }

  const rule = def.rules[field.key] ?? {}
  const ctx = loopContext(def, field, tIndex)
  const xp = (segs: string[]): string => sourceXPath(source.format, segs, ctx, prefixes)
  const set = (patch: Partial<TargetRule> | null): void => change((d) => updateRule(d, field.key, patch))
  const valueKind = rule.value?.kind ?? 'none'
  const sel = sourceSelected ? sIndex.get(sourceSelected) : undefined
  const loopable = field.repeating
  const repeatingSources = [...sIndex.values()].filter((f) => f.repeating)
  const outerCtx = field.segs.length ? loopContext(def, { ...field, segs: field.segs.slice(0, -1) }, tIndex) : null

  const insertAtCursor = (text: string): void => {
    const ta = formulaRef.current
    const current = rule.value?.kind === 'formula' ? rule.value.expr : ''
    const start = ta?.selectionStart ?? current.length
    const end = ta?.selectionEnd ?? current.length
    const next = current.slice(0, start) + text + current.slice(end)
    set({ value: { kind: 'formula', expr: next } })
    requestAnimationFrame(() => {
      ta?.focus()
      const pos = start + (text.includes('()') ? text.indexOf('()') + 1 : text.indexOf('(') >= 0 ? text.indexOf('(') + 1 : text.length)
      ta?.setSelectionRange(pos, pos)
    })
  }

  return (
    <aside className="map-details">
      <header className="detail-head">
        <span className={cx('type-glyph', typeGlyph(field, target.format).cls)}>{typeGlyph(field, target.format).text}</span>
        <div>
          <strong>{field.name}</strong>
          <span className="detail-path">{pathNames(target, field.segs)}</span>
        </div>
        <span className="spacer" />
        {Object.keys(rule).length > 0 || field.children.length > 0 ? (
          <button className="icon-btn danger" title="Remove the mapping of this field and everything inside it" onClick={() => change((d) => clearSubtree(d, field))}>
            <Trash2 size={14} />
          </button>
        ) : null}
      </header>
      <div className="detail-body">
        {field.doc && <p className="hint">{field.doc}</p>}
        {ctx && (
          <div className="ctx-note">
            <Repeat2 size={12} /> Inside the loop over <strong>{pathNames(source, ctx)}</strong>: values come from the current item
            {(() => {
              const ex = sIndex.get(fieldKey(ctx))?.children.find((c) => c.text)
              return ex ? (
                <>
                  , for example <code>{xp(ex.segs)}</code>
                </>
              ) : null
            })()}
            .
          </div>
        )}

        {loopable && (
          <section className="d-section">
            <h4>Repeat</h4>
            <select
              className="input"
              value={rule.forEach ? fieldKey(rule.forEach) : ''}
              onChange={(e) => set({ forEach: e.target.value ? (JSON.parse(e.target.value) as string[]) : undefined })}
            >
              <option value="">Write it once</option>
              {repeatingSources.map((s) => (
                <option key={s.key} value={s.key}>
                  Once for each {pathNames(source, s.segs)}
                </option>
              ))}
            </select>
            {rule.forEach && <p className="hint">Inside this field, mapped values come from the current item, and position() is its number.</p>}
            {rule.forEach && (
              <SortEditor
                keys={rule.sort ?? []}
                options={(sIndex.get(fieldKey(rule.forEach))?.children ?? []).filter((c) => c.text && !c.container)}
                itemIsValue={!!sIndex.get(fieldKey(rule.forEach))?.text && !sIndex.get(fieldKey(rule.forEach))?.container}
                loop={rule.forEach}
                onChange={(sort) => set({ sort: sort.length ? sort : undefined })}
              />
            )}
          </section>
        )}

        {field.text && (
          <section className="d-section">
            <h4>Value</h4>
            <div className="seg small wide">
              {(['field', 'formula', 'constant', 'choose', 'none'] as const).map((k) => (
                <button
                  key={k}
                  className={cx(valueKind === k && 'is-on')}
                  onClick={() => {
                    if (k === 'none') set({ value: undefined })
                    else if (k === 'field') set({ value: sel?.text ? { kind: 'field', source: sel.segs } : rule.value?.kind === 'field' ? rule.value : undefined })
                    else if (k === 'formula') set({ value: { kind: 'formula', expr: rule.value?.kind === 'field' ? xp(rule.value.source) : rule.value?.kind === 'constant' ? quoteXPath(rule.value.text) : '' } })
                    else if (k === 'choose') {
                      const keep = rule.value && (rule.value.kind === 'field' || rule.value.kind === 'formula' || rule.value.kind === 'constant') ? rule.value : undefined
                      set({ value: { kind: 'choose', cases: [{ test: '', value: { kind: 'constant', text: '' } }], otherwise: keep } })
                    } else set({ value: { kind: 'constant', text: '' } })
                  }}
                >
                  {k === 'field' ? 'Field' : k === 'formula' ? 'Formula' : k === 'constant' ? 'Text' : k === 'choose' ? 'If…' : 'None'}
                </button>
              ))}
            </div>

            {(valueKind === 'field' || valueKind === 'none') && (
              <div
                className="value-drop"
                onDragOver={(e) => e.dataTransfer.types.includes(DND) && e.preventDefault()}
                onDrop={(e) => {
                  const key = e.dataTransfer.getData(DND)
                  if (key) connect(key, field.key)
                }}
              >
                {rule.value?.kind === 'field' ? (
                  <>
                    <span className="rule-chip field big">← {pathNames(source, rule.value.source)}</span>
                    <code className="xpath">{xp(rule.value.source)}</code>
                  </>
                ) : (
                  <span className="hint">Drag an input field here, or select one on the left and press “Use selected”.</span>
                )}
                {sel && (sel.text || sel.container) && (
                  <button className="btn small" onClick={() => connect(sel.key, field.key)}>
                    Use selected: {sel.name}
                  </button>
                )}
              </div>
            )}

            {valueKind === 'formula' && rule.value?.kind === 'formula' && (
              <div className="formula">
                <textarea
                  ref={formulaRef}
                  className="input mono"
                  rows={3}
                  spellCheck={false}
                  value={rule.value.expr}
                  placeholder="concat(.?firstName, ' ', .?lastName)"
                  onChange={(e) => set({ value: { kind: 'formula', expr: e.target.value } })}
                />
                <div className="formula-tools">
                  <button className="btn small" disabled={!sel} onClick={() => sel && insertAtCursor(xp(sel.segs))} title="Insert the input field selected on the left">
                    Insert {sel ? sel.name : 'selected field'}
                  </button>
                  <button className={cx('btn small', showFns && 'is-on')} onClick={() => setShowFns(!showFns)}>
                    <SquareFunction size={13} /> Functions
                  </button>
                </div>
                {showFns && <FunctionList onPick={insertAtCursor} />}
              </div>
            )}

            {valueKind === 'constant' && rule.value?.kind === 'constant' && (
              <input className="input" value={rule.value.text} placeholder="Fixed text" onChange={(e) => set({ value: { kind: 'constant', text: e.target.value } })} />
            )}

            {valueKind === 'choose' && rule.value?.kind === 'choose' && (
              <ChooseEditor
                value={rule.value}
                fieldXPath={sel ? xp(sel.segs) : null}
                selected={sel ?? null}
                label={(segs) => sourceLabel(source, segs)}
                xpathOf={xp}
                onChange={(v) => set({ value: v })}
              />
            )}
          </section>
        )}

        <section className="d-section">
          <h4>
            <label className="check">
              <input type="checkbox" checked={rule.condition !== undefined} onChange={(e) => set({ condition: e.target.checked ? '' : undefined })} />
              Only write this field when…
            </label>
          </h4>
          {rule.condition !== undefined && (
            <>
              <textarea className="input mono" rows={2} spellCheck={false} value={rule.condition} placeholder="a test, for example .?status = 'active'" onChange={(e) => set({ condition: e.target.value })} />
              <ConditionBuilder
                fieldXPath={sel ? sourceXPath(source.format, sel.segs, rule.forEach ? rule.forEach : outerCtx, prefixes) : null}
                onAdd={(expr) => set({ condition: rule.condition ? `${rule.condition} and ${expr}` : expr })}
              />
            </>
          )}
        </section>

        {field.container && source.format === 'xml' && target.format === 'xml' && (
          <section className="d-section">
            <h4>Copy</h4>
            {rule.value?.kind === 'copy' ? (
              <div className="value-drop">
                <span className="rule-chip field big">
                  <Copy size={12} /> copy of {pathNames(source, rule.value.source)}
                </span>
                <span className="hint">Everything inside the input structure is copied as it is, including its namespaces. Fields mapped below are added after the copy.</span>
                <button className="btn small" onClick={() => set({ value: undefined })}>
                  Stop copying
                </button>
              </div>
            ) : (
              <div className="value-drop">
                <span className="hint">Copy the whole content of an input structure into {field.name}, as it is.</span>
                <button className="btn small" disabled={!sel?.container} onClick={() => sel && set({ value: { kind: 'copy', source: sel.segs } })}>
                  <Copy size={13} /> Copy {sel?.container ? sel.name : 'selected structure'}
                </button>
              </div>
            )}
          </section>
        )}
        {field.container && !field.text && !loopable && (
          <p className="hint">This is a structure. Drag an input structure onto it to match the fields inside by name, or map them one by one.</p>
        )}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------- preview --

function PreviewPanel(): React.JSX.Element {
  const def = useMapper((s) => s.def)
  const source = useMapper((s) => s.source)
  const target = useMapper((s) => s.target)
  const preview = useMapper((s) => s.preview)
  const { runPreview, setSample, change } = useMapper.getState()
  const ready = !!(def && source && target)
  const [tab, setTab] = useState<'output' | 'xslt'>('output')

  // Re-run shortly after every change while the panel is open.
  const first = preview.output === '' && !preview.error
  useEffect(() => {
    if (!ready || (!preview.stale && !first)) return
    const t = setTimeout(() => void runPreview(), first ? 50 : 700)
    return () => clearTimeout(t)
  }, [ready, def, preview.stale, first]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) return <section className="map-preview is-empty">The preview appears once both the input and the output are described.</section>

  const input = def.sample ?? sampleMessage(source)
  return (
    <section className="map-preview">
      <div className="pv-col">
        <header className="pv-head">
          <strong>Example input</strong>
          <span className="spacer" />
          <button className="btn small" onClick={() => setSample(sampleMessage(source))} title="Replace with a message generated from the input structure">
            Generate from structure
          </button>
        </header>
        <CodeArea value={input} language={source.format} onChange={setSample} />
        {(def.params ?? []).length > 0 && (
          <div className="pv-params">
            {(def.params ?? []).map((p) => (
              <label key={p.name}>
                <span className="mono">{p.name}</span>
                <input
                  className="input mini mono"
                  value={p.sample ?? ''}
                  placeholder={`example ${p.kind} value`}
                  onChange={(e) => change((d) => ({ ...d, params: (d.params ?? []).map((x) => (x.name === p.name ? { ...x, sample: e.target.value } : x)) }))}
                />
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="pv-col">
        <header className="pv-head">
          <div className="seg small">
            <button className={cx(tab === 'output' && 'is-on')} onClick={() => setTab('output')}>
              Output
            </button>
            <button className={cx(tab === 'xslt' && 'is-on')} onClick={() => setTab('xslt')} title="The stylesheet Camel will run">
              XSLT
            </button>
          </div>
          {preview.running ? (
            <span className="pv-status">
              <LoaderCircle size={12} className="spin" /> running…
            </span>
          ) : preview.error ? (
            <span className="pv-status err">
              <CircleAlert size={12} /> failed
            </span>
          ) : preview.output ? (
            <span className={cx('pv-status ok', preview.stale && 'stale')}>
              <CircleCheck size={12} /> {preview.ms} ms
            </span>
          ) : null}
          <span className="spacer" />
          <button className="btn small" onClick={() => void runPreview()}>
            <Play size={11} fill="currentColor" /> Run
          </button>
        </header>
        {tab === 'xslt' ? (
          <CodeArea value={generateXslt(def, source, target, mappingRel(def.name)).xslt} language="xml" readOnly />
        ) : preview.error ? (
          <pre className="pv-error">{preview.error}</pre>
        ) : (
          <CodeArea value={preview.output} language={target.format} readOnly />
        )}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------- paste --

function PasteDialog(): React.JSX.Element | null {
  const side = useMapper((s) => s.pasteFor)
  const [text, setText] = useState('')
  if (!side) return null
  const { setPaste, useSample } = useMapper.getState()
  return (
    <div className="modal-back" onMouseDown={() => setPaste(null)}>
      <div className="modal wide" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <ClipboardPaste size={15} />
          <strong>{side === 'source' ? 'Paste an example input message' : 'Paste an example output message'}</strong>
          <span className="spacer" />
          <button className="icon-btn" onClick={() => setPaste(null)}>
            <X size={15} />
          </button>
        </header>
        <div className="modal-body">
          <textarea className="input mono paste-area" autoFocus spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{\n  "orderId": "A-1001",\n  "customer": { "name": "Nour" }\n}\n\nor <Order><Id>A-1001</Id></Order>'} />
          <div className="hint">XML or JSON. A JSON Schema or an XSD pasted here also works. Lists are recognised when an element repeats or an array has items.</div>
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn" onClick={() => setPaste(null)}>
            Cancel
          </button>
          <button className="btn primary" disabled={!text.trim()} onClick={() => void useSample(side, text)}>
            Use this
          </button>
        </footer>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- view --

export function MapperView(): React.JSX.Element | null {
  const name = useMapper((s) => s.name)
  const canUndo = useMapper((s) => s.past.length > 0)
  const canRedo = useMapper((s) => s.future.length > 0)
  const previewOpen = useMapper((s) => s.preview.open)
  const ready = useMapper((s) => !!(s.source && s.target))
  const dirty = useMapper((s) => !!s.def && JSON.stringify(s.def) !== s.savedJson)
  const routeId = useStudio((s) => {
    const f = s.activePath ? s.files[s.activePath] : null
    const e = f?.js?.[s.activeEntry]
    return e?.route?.id ?? e?.from?.id ?? 'route'
  })
  const host = useRef<HTMLDivElement>(null)
  if (!name) return null
  const m = useMapper.getState()
  const close = async (): Promise<void> => {
    if (m.isDirty()) await m.save()
    m.close()
  }

  return (
    <div className="mapper">
      <header className="mapper-head">
        <button className="btn small" onClick={() => void close()} title="Back to the route (saves the mapping)">
          <ArrowLeft size={13} /> {routeId}
        </button>
        <GitCompareArrows size={16} className="mapper-icon" />
        <strong>Data Mapper</strong>
        <span className="mapper-name">{name}</span>
        <span className="spacer" />
        <button className="icon-btn" title="Undo (⌘Z)" disabled={!canUndo} onClick={m.undo}>
          <Undo2 size={15} />
        </button>
        <button className="icon-btn" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={m.redo}>
          <Redo2 size={15} />
        </button>
        <button className="btn small" disabled={!ready} onClick={m.autoMap} title="Match every output field to the input field with the same name">
          <WandSparkles size={13} /> Match by name
        </button>
        <button className="btn small" onClick={() => m.setPreviewOpen(!previewOpen)}>
          {previewOpen ? <PanelBottomClose size={13} /> : <PanelBottomOpen size={13} />} Preview
        </button>
        <button className={cx('btn small', dirty && 'has-dot')} disabled={!dirty} onClick={() => void m.save().then((ok) => ok && useStudio.getState().notify(`Saved mapping ${name}`, 'success'))}>
          <Save size={13} /> Save
        </button>
      </header>
      <div className="mapper-main">
        <div className="mapper-trees" ref={host}>
          <TreePane side="source" />
          <div className="mapper-gutter" />
          <TreePane side="target" />
          <Lines host={host} />
        </div>
        <Details />
      </div>
      {previewOpen && <PreviewPanel />}
      <PasteDialog />
    </div>
  )
}
