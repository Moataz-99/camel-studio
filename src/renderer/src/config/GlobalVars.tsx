// The Global Variables screen: BW5-style global variables, one column per environment.
// What is saved is plain Spring Boot property files, so nothing here is needed at run time.

import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Eye, EyeOff, Plus, Save, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { cx } from '@/components/util'
import { studioApi, useStudio } from '@/store'
import { DEFAULT_ENV, emptyFile, envFileRel, isSecretName, placeholdersIn, renameEntry, serializeProperties, setEntry, type GlobalVars, type PropFile } from './properties'

interface Row {
  id: number
  /** Name in the files when the screen opened; null for a new variable. */
  orig: string | null
  name: string
  description: string
  values: Record<string, string>
  secret: boolean
  framework: boolean
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
let nextId = 1

function rowsOf(g: GlobalVars): Row[] {
  return g.vars.map((v) => ({ id: nextId++, orig: v.name, name: v.name, description: v.description, values: { ...v.values }, secret: v.secret, framework: v.framework }))
}

/** Works out the new content of every property file from the edited table. */
function buildFiles(g: GlobalVars, rows: Row[], envs: string[], deleted: string[]): { rel: string; text: string }[] {
  const files: Record<string, PropFile> = {}
  for (const env of envs) files[env] = g.files[env] ?? emptyFile(env)
  const apply = (fn: (f: PropFile, env: string) => PropFile): void => {
    for (const env of envs) files[env] = fn(files[env], env)
  }
  for (const name of deleted) apply((f) => setEntry(f, name, undefined))
  for (const r of rows) if (r.orig && r.orig !== r.name) apply((f) => renameEntry(f, r.orig as string, r.name))
  for (const r of rows) {
    if (!r.name) continue
    // The description is kept as a comment where the default value lives.
    const home = r.values[DEFAULT_ENV] !== undefined ? DEFAULT_ENV : envs.find((e) => r.values[e] !== undefined)
    apply((f, env) => setEntry(f, r.name, r.values[env], env === home ? r.description : undefined))
  }
  const out: { rel: string; text: string }[] = []
  for (const env of envs) {
    const text = serializeProperties(files[env])
    const before = g.files[env] ? serializeProperties(g.files[env]) : null
    // A new environment is written even when empty, so it exists and can be chosen.
    if (text !== before) out.push({ rel: files[env].rel || envFileRel(env), text })
  }
  return out
}

export function GlobalVarsView(): React.JSX.Element | null {
  const open = useStudio((s) => s.globalsOpen)
  const globals = useStudio((s) => s.globals)
  const project = useStudio((s) => s.project)
  const [rows, setRows] = useState<Row[]>([])
  const [envs, setEnvs] = useState<string[]>([DEFAULT_ENV])
  const [deleted, setDeleted] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [showFramework, setShowFramework] = useState(false)
  const [revealed, setRevealed] = useState<Record<number, boolean>>({})
  const [newEnv, setNewEnv] = useState<string | null>(null)
  const [uses, setUses] = useState<Record<string, number>>({})
  const [baseline, setBaseline] = useState('')

  // Start from the files every time the screen opens or after a save reloads them.
  useEffect(() => {
    if (!open || !globals) return
    const r = rowsOf(globals)
    setRows(r)
    setEnvs(globals.envs)
    setDeleted([])
    setBaseline(JSON.stringify({ r: r.map(({ id: _id, ...x }) => x), e: globals.envs }))
  }, [open, globals])

  // How many route files use each variable.
  useEffect(() => {
    if (!open || !project) return
    let live = true
    void (async () => {
      const count: Record<string, number> = {}
      for (const f of project.routeFiles) {
        const state = useStudio.getState().files[f.path]
        const text = state?.text ?? (await studioApi().project.readFile(f.path).catch(() => ''))
        for (const name of new Set(placeholdersIn(text).map((p) => p.name))) count[name] = (count[name] ?? 0) + 1
      }
      if (live) setUses(count)
    })()
    return () => {
      live = false
    }
  }, [open, project])

  const dirty = useMemo(() => JSON.stringify({ r: rows.map(({ id: _id, ...x }) => x), e: envs }) !== baseline || deleted.length > 0, [rows, envs, deleted, baseline])
  const names = rows.map((r) => r.name)
  const invalid = rows.filter((r) => !NAME.test(r.name) || names.filter((n) => n === r.name).length > 1)

  if (!open || !globals || !project) return null
  const { setGlobalsOpen, saveGlobalFiles, notify } = useStudio.getState()

  const update = (id: number, patch: Partial<Row>): void => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const setValue = (id: number, env: string, value: string | undefined): void =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, values: Object.fromEntries(Object.entries({ ...r.values, [env]: value }).filter(([, v]) => v !== undefined)) as Record<string, string> } : r)))
  const save = async (): Promise<boolean> => {
    if (invalid.length) {
      notify(`Fix the variable names first: ${invalid.map((r) => r.name || '(empty)').join(', ')}`, 'error')
      return false
    }
    const files = buildFiles(globals, rows, envs, deleted)
    if (files.length === 0) return true
    const ok = await saveGlobalFiles(files)
    if (ok) notify(`Saved ${files.map((f) => f.rel.split('/').pop()).join(', ')}`, 'success')
    return ok
  }
  const close = async (): Promise<void> => {
    if (dirty && !(await save())) return
    setGlobalsOpen(false)
  }
  const addEnv = (): void => {
    const env = (newEnv ?? '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(env) || envs.includes(env) || env === DEFAULT_ENV) {
      notify('An environment name is lowercase letters, digits, - or _, and must be new.', 'info')
      return
    }
    setEnvs([...envs, env])
    setNewEnv(null)
  }

  const q = query.trim().toLowerCase()
  const visible = rows.filter((r) => (showFramework || !r.framework || r.orig === null) && (!q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)))
  const hidden = rows.filter((r) => r.framework && r.orig !== null).length

  return (
    <div className="gvars" onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && (e.preventDefault(), e.stopPropagation(), void save())}>
      <header className="mapper-head">
        <button className="btn small" onClick={() => void close()} title="Back to the routes (saves)">
          <ArrowLeft size={13} /> Routes
        </button>
        <SlidersHorizontal size={16} className="gv-icon" />
        <strong>Global variables</strong>
        <span className="mapper-name">use as {'{{name}}'} in any step</span>
        <span className="spacer" />
        <div className="tree-search gv-search">
          <Search size={13} />
          <input placeholder="Find a variable" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={showFramework} onChange={(e) => setShowFramework(e.target.checked)} />
          Spring and Camel settings{hidden ? ` (${hidden})` : ''}
        </label>
        {newEnv === null ? (
          <button className="btn small" onClick={() => setNewEnv('')}>
            <Plus size={13} /> Environment
          </button>
        ) : (
          <span className="gv-newenv">
            <input
              className="input mini mono"
              autoFocus
              placeholder="dev, test, prod…"
              value={newEnv}
              onChange={(e) => setNewEnv(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addEnv()
                if (e.key === 'Escape') setNewEnv(null)
              }}
            />
            <button className="btn small" onClick={addEnv}>
              Add
            </button>
          </span>
        )}
        <button className={cx('btn small', dirty && 'has-dot')} disabled={!dirty} onClick={() => void save()}>
          <Save size={13} /> Save
        </button>
      </header>

      <div className="gv-body">
        <div className="gv-table" style={{ gridTemplateColumns: `minmax(200px, 1.2fr) minmax(160px, 1fr) ${envs.map(() => 'minmax(150px, 1fr)').join(' ')} 64px 64px` }}>
          <div className="gv-th">Name</div>
          <div className="gv-th">Description</div>
          {envs.map((e) => (
            <div key={e} className="gv-th" title={envFileRel(e)}>
              {e === DEFAULT_ENV ? 'Default' : e}
              <span className="gv-file">{envFileRel(e).split('/').pop()}</span>
            </div>
          ))}
          <div className="gv-th" title="Route files that use it">
            Used
          </div>
          <div className="gv-th" />

          {visible.map((r) => {
            const bad = !NAME.test(r.name) || names.filter((n) => n === r.name).length > 1
            const secret = r.secret || isSecretName(r.name)
            const masked = secret && !revealed[r.id]
            return (
              <div key={r.id} className={cx('gv-row', r.framework && 'is-framework')}>
                <div className="gv-cell">
                  <input className={cx('input mono', bad && 'is-bad')} value={r.name} placeholder="kafka.brokers" onChange={(e) => update(r.id, { name: e.target.value.trim() })} />
                </div>
                <div className="gv-cell">
                  <input className="input" value={r.description} placeholder="What it is for" onChange={(e) => update(r.id, { description: e.target.value })} />
                </div>
                {envs.map((env) => {
                  const v = r.values[env]
                  return (
                    <div key={env} className="gv-cell">
                      <input
                        className={cx('input mono', env !== DEFAULT_ENV && v === undefined && 'inherits')}
                        type={masked && v !== undefined ? 'password' : 'text'}
                        value={v ?? ''}
                        placeholder={env === DEFAULT_ENV ? 'value' : r.values[DEFAULT_ENV] !== undefined ? 'same as default' : 'not set'}
                        onChange={(e) => setValue(r.id, env, e.target.value === '' && env !== DEFAULT_ENV ? undefined : e.target.value)}
                      />
                    </div>
                  )
                })}
                <div className="gv-cell gv-uses">{uses[r.name] ? uses[r.name] : <span className="muted">—</span>}</div>
                <div className="gv-cell gv-actions">
                  {secret && (
                    <button className="icon-btn tiny" title={masked ? 'Show values' : 'Hide values'} onClick={() => setRevealed((x) => ({ ...x, [r.id]: !x[r.id] }))}>
                      {masked ? <Eye size={13} /> : <EyeOff size={13} />}
                    </button>
                  )}
                  <button
                    className="icon-btn tiny danger"
                    title="Delete this variable from every environment"
                    onClick={() => {
                      if (r.orig) setDeleted((d) => [...d, r.orig as string])
                      setRows((rs) => rs.filter((x) => x.id !== r.id))
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <button className="btn gv-add" onClick={() => setRows((rs) => [...rs, { id: nextId++, orig: null, name: '', description: '', values: { [DEFAULT_ENV]: '' }, secret: false, framework: false }])}>
          <Plus size={14} /> Add a variable
        </button>
        {visible.length === 0 && <div className="gv-empty">{q ? `No variable matches “${query}”.` : 'No global variables yet. Add one, then use it in any step as {{name}}.'}</div>}
        <p className="gv-help">
          Each environment column is a Spring profile file. An empty cell uses the default value. Pick the environment to run with next to the Run button. Names with
          “password”, “secret”, “token” or “key” are hidden on screen but saved as written: keep real production secrets out of Git, for example as <code>{'${DB_PASSWORD}'}</code> taken from the server's environment.
        </p>
      </div>
    </div>
  )
}
