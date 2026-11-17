import { useMemo, useState } from 'react'
import { Boxes, ChevronDown, ChevronRight, Coffee, SlidersHorizontal, FileCode2, FilePlus2, Plus, Route, Search, Settings2, X } from 'lucide-react'
import { MAPPER_ITEM, categoryOf, listEntries, paletteEips, type Category, type PaletteItem } from '@/model/camel'
import { useStudio } from '@/store'
import { CATEGORY_NAMES, componentIcon, stepIcon } from './icons'
import { cx, startDrag } from './util'

// --------------------------------------------------------------- explorer --

export function Explorer(): React.JSX.Element | null {
  const project = useStudio((s) => s.project)
  const files = useStudio((s) => s.files)
  const activePath = useStudio((s) => s.activePath)
  const activeEntry = useStudio((s) => s.activeEntry)
  const openFile = useStudio((s) => s.openFile)
  const setActiveEntry = useStudio((s) => s.setActiveEntry)
  const addRoute = useStudio((s) => s.addRoute)
  const newRouteFile = useStudio((s) => s.newRouteFile)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const globalCount = useStudio((s) => s.globals?.vars.filter((v) => !v.framework).length ?? 0)

  if (!project) return null
  const submit = (): void => {
    if (name.trim()) void newRouteFile(name)
    setCreating(false)
    setName('')
  }

  return (
    <section className="panel explorer">
      <header className="panel-head">
        <span className="panel-title">Project</span>
        <span className="spacer" />
        <button className="icon-btn" title="New route file" onClick={() => setCreating(true)}>
          <FilePlus2 size={15} />
        </button>
      </header>
      <div className="panel-body tree">
        <div className="tree-group">{project.routeFormat === 'java' ? 'Routes · saved as Java classes' : 'Routes · YAML DSL'}</div>
        {creating && (
          <div className="tree-row is-input">
            <FileCode2 size={14} />
            <input
              autoFocus
              placeholder="order-intake"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={submit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setName('')
                }
              }}
            />
            <span className="tree-ext">.camel.yaml</span>
          </div>
        )}
        {project.routeFiles.length === 0 && !creating && (
          <div className="tree-empty">
            No YAML routes yet.
            <button className="link" onClick={() => setCreating(true)}>
              Create the first one
            </button>
          </div>
        )}
        {project.routeFiles.map((info) => {
          const state = files[info.path]
          const isActive = activePath === info.path
          const dirty = state && state.text !== state.saved
          const entries = isActive && state?.js ? listEntries(state.js) : []
          return (
            <div key={info.path}>
              <button className={cx('tree-row', isActive && 'is-open')} onClick={() => void openFile(info, 'yaml')} title={info.rel}>
                {isActive ? <ChevronDown size={13} className="twisty" /> : <ChevronRight size={13} className="twisty" />}
                <FileCode2 size={14} className="tree-icon" />
                <span className="tree-name">{info.name.replace(/\.camel\.ya?ml$|\.ya?ml$/i, '')}</span>
                {state?.error && <span className="dot error" title={state.error} />}
                {dirty && <span className="dot" title="Unsaved changes" />}
              </button>
              {isActive && (
                <div className="tree-children">
                  {entries.map((entry) => (
                    <button
                      key={entry.index}
                      className={cx('tree-row child', activeEntry === entry.index && 'is-active', !entry.isRoute && 'is-other')}
                      onClick={() => setActiveEntry(entry.index)}
                    >
                      {entry.isRoute ? <Route size={13} className="tree-icon" /> : <Settings2 size={13} className="tree-icon" />}
                      <span className="tree-name">{entry.id}</span>
                      {!entry.isRoute && <span className="tree-ext">{entry.rootKey}</span>}
                    </button>
                  ))}
                  {state?.js && (
                    <button className="tree-row child is-action" onClick={addRoute}>
                      <Plus size={13} className="tree-icon" />
                      <span className="tree-name">Add route</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}

        <div className="tree-group">Configuration</div>
        <button className="tree-row" onClick={() => useStudio.getState().setGlobalsOpen(true)} title="Values per environment, used in steps as {{name}}">
          <span className="twisty" />
          <SlidersHorizontal size={14} className="tree-icon" />
          <span className="tree-name">Global variables</span>
          {globalCount > 0 && <span className="tree-ext">{globalCount}</span>}
        </button>
        {project.javaRoutes.length > 0 && (
          <>
            <div className="tree-group">Routes · Java DSL (read-only)</div>
            {project.javaRoutes.map((info) => (
              <button key={info.path} className={cx('tree-row', activePath === info.path && 'is-active')} onClick={() => void openFile(info, 'java')} title={info.rel}>
                <span className="twisty" />
                <Coffee size={14} className="tree-icon" />
                <span className="tree-name">{info.name.replace(/\.java$/, '')}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- palette --

/** Components an integration team reaches for first, in the order shown. */
const COMMON = ['direct', 'seda', 'timer', 'quartz', 'platform-http', 'rest', 'http', 'cxf', 'jms', 'activemq', 'kafka', 'file', 'ftp', 'sftp', 'sql', 'jdbc', 'mongodb', 'ldap', 'smpp', 'mail', 'xslt', 'validator', 'bean', 'log']
const EIP_ORDER: Category[] = ['routing', 'transform', 'endpoint', 'error', 'flow', 'util']

interface PaletteEntry {
  item: PaletteItem
  title: string
  name: string
  description: string
  category: Category
  label: string | null
  badge: string | null
}

export function Palette(): React.JSX.Element | null {
  const catalog = useStudio((s) => s.catalog)
  const insertAfterSelection = useStudio((s) => s.insertAfterSelection)
  const setDragging = useStudio((s) => s.setDragging)
  const [tab, setTab] = useState<'eip' | 'component'>('eip')
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const snippets = useStudio((s) => s.settings?.snippets)

  const team = useMemo<PaletteEntry[]>(
    () =>
      (snippets ?? []).map((sn) => ({
        item: { type: 'snippet', id: sn.id },
        title: sn.name,
        name: sn.id,
        description: `${sn.description || 'A reusable process'} (${sn.steps.length} ${sn.steps.length === 1 ? 'step' : 'steps'})`,
        category: 'util',
        label: null,
        badge: 'team'
      })),
    [snippets]
  )

  const eips = useMemo<PaletteEntry[]>(() => {
    if (!catalog) return []
    const mapper: PaletteEntry = {
      item: { type: 'eip', name: MAPPER_ITEM },
      title: 'Data Mapper',
      name: MAPPER_ITEM,
      description: 'Map one message format onto another by drawing lines between fields (XML and JSON).',
      category: 'transform',
      label: null,
      badge: 'visual'
    }
    return [
      mapper,
      ...paletteEips(catalog).map((name): PaletteEntry => {
        const m = catalog.models[name]
        return { item: { type: 'eip', name }, title: m.title, name, description: m.description, category: categoryOf(name, catalog), label: null, badge: null }
      })
    ]
  }, [catalog])

  const components = useMemo<PaletteEntry[]>(() => {
    if (!catalog) return []
    return catalog.index.components
      .filter((c) => !c.deprecated)
      .map((c) => ({
        item: { type: 'component', name: c.name },
        title: c.title,
        name: c.name,
        description: c.description,
        category: 'endpoint',
        label: c.label,
        badge: c.consumerOnly ? 'trigger only' : c.producerOnly ? 'call only' : null
      }))
  }, [catalog])

  if (!catalog) return null
  const q = query.trim().toLowerCase()
  const match = (e: PaletteEntry): boolean => !q || e.title.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)

  const groups: { title: string; items: PaletteEntry[] }[] = []
  if (tab === 'eip') {
    const teamItems = team.filter(match)
    if (teamItems.length > 0) groups.push({ title: 'Team', items: teamItems })
    for (const cat of EIP_ORDER) {
      const items = eips.filter((e) => e.category === cat && match(e)).sort((a, b) => Number(b.name === MAPPER_ITEM) - Number(a.name === MAPPER_ITEM) || a.title.localeCompare(b.title))
      if (items.length > 0) groups.push({ title: CATEGORY_NAMES[cat], items })
    }
  } else if (q || showAll) {
    const items = components.filter(match)
    groups.push({ title: q ? `${items.length} matching` : `All ${items.length} components`, items })
  } else {
    const byName = new Map(components.map((c) => [c.name, c]))
    const own = components.filter((c) => (c.label ?? '').split(',').includes('custom'))
    if (own.length > 0) groups.push({ title: 'Team components', items: own.map((c) => ({ ...c, badge: 'team' })) })
    groups.push({ title: 'Common', items: COMMON.map((n) => byName.get(n)).filter((c): c is PaletteEntry => !!c) })
  }

  return (
    <section className="panel palette">
      <header className="panel-head">
        <span className="panel-title">Palette</span>
        <span className="spacer" />
        <div className="seg small">
          <button className={cx(tab === 'eip' && 'is-on')} onClick={() => setTab('eip')}>
            Processors
          </button>
          <button className={cx(tab === 'component' && 'is-on')} onClick={() => setTab('component')}>
            Components
          </button>
        </div>
      </header>
      <div className="palette-search">
        <Search size={13} />
        <input placeholder={tab === 'eip' ? 'Search processors' : `Search ${components.length} components`} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && (
          <button className="icon-btn tiny" onClick={() => setQuery('')} title="Clear">
            <X size={12} />
          </button>
        )}
      </div>
      <div className="panel-body palette-list">
        {groups.every((g) => g.items.length === 0) && <div className="tree-empty">Nothing matches “{query}”.</div>}
        {groups.map((g) => (
          <div key={g.title}>
            <div className="tree-group">{g.title}</div>
            {g.items.map((e) => {
              const Icon = e.item.type === 'component' ? componentIcon(e.name, e.label) : e.item.type === 'snippet' ? Boxes : stepIcon(e.name, e.category, null, null)
              return (
                <button
                  key={e.name}
                  className={cx('palette-item', `cat-${e.category}`)}
                  draggable
                  title={e.description}
                  onDragStart={(ev) => {
                    startDrag(ev, e.item)
                    setDragging(true)
                  }}
                  onDragEnd={() => setDragging(false)}
                  onDoubleClick={() => insertAfterSelection(e.item)}
                >
                  <span className="mini-icon">
                    <Icon size={14} />
                  </span>
                  <span className="palette-title">{e.title}</span>
                  {e.badge && <span className="palette-badge">{e.badge}</span>}
                </button>
              )
            })}
          </div>
        ))}
        {tab === 'component' && !q && (
          <button className="link block" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Show common only' : `Show all ${components.length} components`}
          </button>
        )}
      </div>
      <footer className="palette-foot">Drag onto a + on the canvas, or double-click to add after the selected step.</footer>
    </section>
  )
}
