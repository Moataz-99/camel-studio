import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowDownToLine, Bug, ChevronDown, GitBranch, Package, Settings, CircleAlert, CircleCheck, Columns2, FileCode2, FolderOpen, FolderPlus, LoaderCircle, Moon, PanelBottom, Play, Redo2, Save, Square, Sun, Terminal, Trash2, TriangleAlert, Undo2, Workflow, X } from 'lucide-react'
import type { RouteFormat, RunStatus } from '@shared/types'
import { samePath } from '@/model/camel'
import { useActiveFile, useStudio } from '@/store'
import { TracePanel, TraceTools } from './Runtime'
import { BranchChip, CloneForm, GitPanel } from './Git'
import { cx, useEntries, useProblems } from './util'

export function Logo({ size = 22 }: { size?: number }): React.JSX.Element {
  // Two humps joined by a route line.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect width="24" height="24" rx="6" fill="var(--accent)" />
      <path d="M4.5 16.5c1.2 0 1.6-7 4.2-7s2.3 4 3.3 4 .9-6 3.4-6 2.7 9 4.1 9" fill="none" stroke="var(--accent-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// --------------------------------------------------------------- titlebar --

const RUN_LABEL: Record<RunStatus, string> = { idle: 'Stopped', starting: 'Starting…', running: 'Running', stopping: 'Stopping…', failed: 'Failed', building: 'Building…' }

const DEFAULT_ENVS = ['default']

export function TitleBar(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const view = useStudio((s) => s.view)
  const theme = useStudio((s) => s.theme)
  const runStatus = useStudio((s) => s.runStatus)
  const files = useStudio((s) => s.files)
  const envs = useStudio((s) => s.globals?.envs ?? DEFAULT_ENVS)
  const runEnv = useStudio((s) => s.runEnv)
  const file = useActiveFile()
  const { setView, toggleTheme, save, undo, redo, run, stop, closeProject } = useStudio.getState()
  const dirty = Object.values(files).filter((f) => f.text !== f.saved).length
  const busy = runStatus === 'starting' || runStatus === 'running' || runStatus === 'stopping' || runStatus === 'building'
  const inVscode = window.studio.host === 'vscode'
  const isMac = window.studio.platform === 'darwin' && !inVscode
  const isJava = file?.language === 'java'

  return (
    <header className={cx('titlebar', isMac && 'is-mac')}>
      <div className="tb-left">
        <Logo size={20} />
        {inVscode ? (
          <span className="tb-project" title={project?.root}>
            <span>{project?.name}</span>
          </span>
        ) : (
          <button className="tb-project" onClick={closeProject} title="Switch project">
            <span>{project?.name}</span>
            <ChevronDown size={13} />
          </button>
        )}
        {!inVscode && <BranchChip />}
      </div>
      <div className="tb-center">
        <div className="seg">
          <button className={cx(view === 'design' && 'is-on')} disabled={isJava} onClick={() => setView('design')}>
            <Workflow size={14} /> Design
          </button>
          <button className={cx(view === 'split' && 'is-on')} disabled={isJava} onClick={() => setView('split')}>
            <Columns2 size={14} /> Split
          </button>
          <button className={cx(view === 'source' && 'is-on')} onClick={() => setView('source')}>
            <FileCode2 size={14} /> Source
          </button>
        </div>
      </div>
      <div className="tb-right">
        <button className="icon-btn" title="Undo (⌘Z)" disabled={!file || file.past.length === 0} onClick={undo}>
          <Undo2 size={15} />
        </button>
        <button className="icon-btn" title="Redo (⇧⌘Z)" disabled={!file || file.future.length === 0} onClick={redo}>
          <Redo2 size={15} />
        </button>
        <button className={cx('btn', dirty > 0 && 'has-dot')} title="Save all (⌘S)" disabled={dirty === 0} onClick={() => void save()}>
          <Save size={14} /> Save
        </button>
        <span className="tb-sep" />
        <span className={cx('run-state', `is-${runStatus}`)}>
          <span className="run-dot" />
          {RUN_LABEL[runStatus]}
        </span>
        {busy ? (
          <button className="btn stop" onClick={() => void stop()} disabled={runStatus === 'stopping'}>
            <Square size={12} fill="currentColor" /> Stop
          </button>
        ) : (
          <>
            {envs.length > 1 && (
              <select className="input mini env-select" value={runEnv} onChange={(e) => useStudio.getState().setRunEnv(e.target.value)} title="Environment to run with: its global variable values are used">
                {envs.map((e) => (
                  <option key={e} value={e}>
                    {e === 'default' ? 'Default env' : e}
                  </option>
                ))}
              </select>
            )}
            <button className="btn" onClick={() => useStudio.getState().setBuildOpen(true)} title="Build the deployable package (JAR) with Maven">
              <Package size={14} /> <span className="tb-label">Build</span>
            </button>
            <button className="btn" onClick={() => void run('debug')} title="Save and run with the debugger: messages pause at breakpoints">
              <Bug size={14} /> <span className="tb-label">Debug</span>
            </button>
            <button className="btn primary" onClick={() => void run('run')} title="Save and run with Maven (spring-boot:run)">
              <Play size={13} fill="currentColor" /> Run
            </button>
          </>
        )}
        <button className="icon-btn" title="Settings: Java, Maven, Camel version, team palette" onClick={() => useStudio.getState().setAdminOpen(true)}>
          <Settings size={15} />
        </button>
        {!inVscode && (
          <button className="icon-btn" title="Toggle theme" onClick={toggleTheme}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        )}
      </div>
    </header>
  )
}

// ----------------------------------------------------------- bottom panel --

const levelOf = (line: string): string => {
  if (/\bERROR\b|\[ERROR\]|Exception\b|^\s+at\s|BUILD FAILURE/.test(line)) return 'error'
  if (/\bWARN(ING)?\b|\[WARNING\]/.test(line)) return 'warn'
  if (/^\$ |Started \S+ in|started in \d|BUILD SUCCESS/.test(line)) return 'good'
  if (/\bDEBUG\b|\bTRACE\b|^\[INFO\]/.test(line)) return 'dim'
  return ''
}

function Console(): React.JSX.Element {
  const lines = useStudio((s) => s.runLines)
  const toolchain = useStudio((s) => s.toolchain)
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = box.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <div
      className="console"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {lines.length === 0 && (
        <div className="console-empty">
          {toolchain && (!toolchain.java || !toolchain.maven) ? (
            <>
              <TriangleAlert size={14} />
              <span>
                {!toolchain.java && 'No JDK was found on this machine. '}
                {!toolchain.maven && 'Maven was not found (and the project has no Maven wrapper). '}
                Install {[!toolchain.java && 'a JDK 21', !toolchain.maven && 'Maven'].filter(Boolean).join(' and ')} to run routes locally.
              </span>
            </>
          ) : (
            <span>Press Run to start the application with Maven. Its log appears here.</span>
          )}
        </div>
      )}
      {lines.map((line, i) => (
        <div key={i} className={cx('log-line', levelOf(line))}>
          {line || ' '}
        </div>
      ))}
    </div>
  )
}

function Problems(): React.JSX.Element {
  const problems = useProblems()
  const entries = useEntries()
  const file = useActiveFile()
  const selection = useStudio((s) => s.selection)
  const { setActiveEntry, select } = useStudio.getState()
  if (file?.error) {
    return (
      <div className="problems">
        <div className="problem is-error">
          <CircleAlert size={14} />
          <span>{file.error}</span>
          <span className="problem-where">{file.name}</span>
        </div>
      </div>
    )
  }
  if (problems.length === 0) {
    return (
      <div className="console-empty">
        <CircleCheck size={14} />
        <span>No problems found in {file?.name ?? 'this file'}.</span>
      </div>
    )
  }
  return (
    <div className="problems">
      {problems.map((p, i) => {
        const isBranch = typeof p.path[p.path.length - 1] === 'string' && p.path[p.path.length - 1] !== 'from'
        const branchLike = isBranch || /\/(when|doCatch)\/\d+$/.test(p.path.join('/'))
        return (
          <button
            key={i}
            className={cx('problem', samePath(selection?.path, p.path) && 'is-active')}
            onClick={() => {
              setActiveEntry(p.entryIndex)
              select({ kind: branchLike ? 'branch' : 'step', path: p.path })
            }}
          >
            <TriangleAlert size={14} />
            <span>{p.message}</span>
            <span className="problem-where">{entries.find((e) => e.index === p.entryIndex)?.id}</span>
          </button>
        )
      })}
    </div>
  )
}

export function BottomPanel(): React.JSX.Element | null {
  const open = useStudio((s) => s.bottomOpen)
  const tab = useStudio((s) => s.bottomTab)
  const traced = useStudio((s) => s.exchanges.length)
  const changes = useStudio((s) => (s.git?.repo ? s.git.files.length : 0))
  const problems = useProblems()
  const file = useActiveFile()
  const { setBottom, clearConsole } = useStudio.getState()
  if (!open) return null
  const count = problems.length + (file?.error ? 1 : 0)
  return (
    <section className="bottom-panel">
      <header className="bottom-head">
        <button className={cx('tab', tab === 'console' && 'is-on')} onClick={() => setBottom(true, 'console')}>
          <Terminal size={13} /> Console
        </button>
        <button className={cx('tab', tab === 'problems' && 'is-on')} onClick={() => setBottom(true, 'problems')}>
          <TriangleAlert size={13} /> Problems {count > 0 && <span className="count warn">{count}</span>}
        </button>
        <button className={cx('tab', tab === 'trace' && 'is-on')} onClick={() => setBottom(true, 'trace')}>
          <Activity size={13} /> Trace {traced > 0 && <span className="count">{traced}</span>}
        </button>
        {window.studio.host !== 'vscode' && (
          <button className={cx('tab', tab === 'git' && 'is-on')} onClick={() => setBottom(true, 'git')}>
            <GitBranch size={13} /> Git {changes > 0 && <span className="count">{changes}</span>}
          </button>
        )}
        <span className="spacer" />
        {tab === 'trace' && <TraceTools />}
        {tab === 'console' && (
          <button className="icon-btn" title="Clear console" onClick={clearConsole}>
            <Trash2 size={13} />
          </button>
        )}
        <button className="icon-btn" title="Close panel" onClick={() => setBottom(false)}>
          <X size={14} />
        </button>
      </header>
      {tab === 'console' ? <Console /> : tab === 'problems' ? <Problems /> : tab === 'git' ? <GitPanel /> : <TracePanel />}
    </section>
  )
}

// -------------------------------------------------------------- statusbar --

export function StatusBar(): React.JSX.Element {
  const [formatOpen, setFormatOpen] = useState(false)
  const catalog = useStudio((s) => s.catalog)
  const project = useStudio((s) => s.project)
  const toolchain = useStudio((s) => s.toolchain)
  const bottomOpen = useStudio((s) => s.bottomOpen)
  const problems = useProblems()
  const file = useActiveFile()
  const { setBottom } = useStudio.getState()
  const count = problems.length + (file?.error ? 1 : 0)
  const projectCamel = project?.camelVersion && !project.camelVersion.includes('$') ? project.camelVersion : null
  return (
    <footer className="statusbar">
      <span title="Camel version of the component catalog used by the designer">Catalog: Camel {catalog?.index.camelVersion}</span>
      {projectCamel && projectCamel !== catalog?.index.camelVersion && (
        <span className="warn" title="The project uses a different Camel version than the designer catalog. Options may differ slightly.">
          Project: Camel {projectCamel}
        </span>
      )}
      {project?.springBootVersion && <span>Spring Boot {project.springBootVersion}</span>}
      {project && (
        <button onClick={() => setFormatOpen(true)} title="Change how routes are saved">
          Routes: {project.routeFormat === 'java' ? 'Java classes' : 'YAML'}
        </button>
      )}
      <span className={cx(toolchain && !toolchain.java && 'warn')}>{toolchain ? (toolchain.java ? `Java ${toolchain.java}` : 'JDK not found') : 'Checking tools…'}</span>
      {toolchain && <span className={cx(!toolchain.maven && 'warn')}>{toolchain.maven ? `Maven ${toolchain.maven}${toolchain.wrapper ? ' (wrapper)' : ''}` : 'Maven not found'}</span>}
      {toolchain?.privateTools && <span title="Using the JDK and/or Maven in ~/.camel-studio/toolchain because none was found on this machine">Camel Studio toolchain</span>}
      <span className="spacer" />
      <button className={cx(count > 0 && 'warn')} onClick={() => setBottom(true, 'problems')}>
        <TriangleAlert size={12} /> {count} {count === 1 ? 'problem' : 'problems'}
      </button>
      <button onClick={() => setBottom(!bottomOpen)} title="Toggle bottom panel (⌘J)">
        <PanelBottom size={12} /> Console
      </button>
      {formatOpen && <FormatDialog onClose={() => setFormatOpen(false)} />}
    </footer>
  )
}

function FormatDialog({ onClose }: { onClose(): void }): React.JSX.Element | null {
  const project = useStudio((s) => s.project)
  const [choice, setChoice] = useState<RouteFormat>(project?.routeFormat ?? 'yaml')
  if (!project) return null
  const option = (value: RouteFormat, title: string, text: string): React.JSX.Element => (
    <button className={cx('choice-card', choice === value && 'is-on')} onClick={() => setChoice(value)}>
      <strong>{title}</strong>
      <span>{text}</span>
    </button>
  )
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <FileCode2 size={15} />
          <strong>How routes are saved</strong>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </header>
        <div className="modal-body">
          {option('java', 'Java classes', `Each route file becomes a standard Camel RouteBuilder class in ${project.javaPackage}. The visual design stays in src/main/camel-studio and the class is regenerated on every save.`)}
          {option('yaml', 'YAML DSL', 'Route files live in src/main/resources/camel and Camel runs them directly. Nothing is generated.')}
          <div className="hint">Switching moves the route files between the two folders. In Java mode, edit routes on the canvas rather than in the generated class.</div>
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={choice === project.routeFormat}
            onClick={() => {
              void useStudio.getState().setRouteFormat(choice)
              onClose()
            }}
          >
            Switch
          </button>
        </footer>
      </div>
    </div>
  )
}

export function ToastHost(): React.JSX.Element | null {
  const toast = useStudio((s) => s.toast)
  if (!toast) return null
  return (
    <div key={toast.id} className={cx('toast', `is-${toast.tone}`)}>
      {toast.tone === 'error' ? <CircleAlert size={15} /> : toast.tone === 'success' ? <CircleCheck size={15} /> : null}
      <span>{toast.message}</span>
    </div>
  )
}

// ---------------------------------------------------------------- welcome --

export function Welcome(): React.JSX.Element {
  const catalog = useStudio((s) => s.catalog)
  const recent = useStudio((s) => s.recent)
  const toolchain = useStudio((s) => s.toolchain)
  const { openProject, pickAndOpenProject, createProject } = useStudio.getState()
  const [creating, setCreating] = useState(false)
  const [cloning, setCloning] = useState(false)
  const [name, setName] = useState('order-service')
  const defaults = useStudio((s) => s.settings?.defaults)
  const [groupId, setGroupId] = useState('com.example.integration')
  const [routeFormat, setRouteFormat] = useState<RouteFormat>('java')
  // Start from the team's defaults (Settings › New projects) once they are loaded.
  useEffect(() => {
    if (!defaults) return
    setGroupId(defaults.groupId)
    setRouteFormat(defaults.routeFormat)
  }, [defaults])
  const [parentDir, setParentDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const artifactId = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  const create = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      await createProject({ routeFormat, javaVersion: defaults?.javaVersion, parentDir, name: name.trim(), groupId: groupId.trim(), artifactId })
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cx('welcome', window.studio.platform === 'darwin' && 'is-mac')}>
      <div className="welcome-drag" />
      <div className="welcome-card">
        <div className="welcome-brand">
          <Logo size={44} />
          <div>
            <h1>Camel Studio</h1>
            <p>Design, run and operate Spring Boot + Apache Camel integrations.</p>
          </div>
        </div>

        {cloning ? (
          <CloneForm onBack={() => setCloning(false)} />
        ) : !creating ? (
          <div className="welcome-actions">
            <button className="big-action" onClick={() => setCreating(true)}>
              <FolderPlus size={20} />
              <span>
                <strong>New project</strong>
                <small>Camel {catalog?.index.camelVersion} · Spring Boot {catalog?.index.springBootVersion}</small>
              </span>
            </button>
            <button className="big-action" onClick={() => void pickAndOpenProject()}>
              <FolderOpen size={20} />
              <span>
                <strong>Open project</strong>
                <small>A Maven project with Camel routes</small>
              </span>
            </button>
            <button className="big-action" onClick={() => setCloning(true)}>
              <ArrowDownToLine size={20} />
              <span>
                <strong>Clone repository</strong>
                <small>From your team&apos;s Git server</small>
              </span>
            </button>
          </div>
        ) : (
          <form
            className="welcome-form"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <label>
              <span>Project name</span>
              <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              <span>Group ID</span>
              <input className="input mono" value={groupId} onChange={(e) => setGroupId(e.target.value)} />
            </label>
            <label>
              <span>Routes are saved as</span>
              <select className="input" value={routeFormat} onChange={(e) => setRouteFormat(e.target.value as RouteFormat)}>
                <option value="java">Java classes (Camel RouteBuilder), generated from the visual design</option>
                <option value="yaml">YAML DSL files, run directly by Camel</option>
              </select>
            </label>
            <label>
              <span>Location</span>
              <span className="input-row">
                <input className="input mono" readOnly value={parentDir ? `${parentDir}/${artifactId}` : ''} placeholder="Choose a parent folder" />
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    const dir = await window.studio.project.pickFolder('Choose where to create the project')
                    if (dir) setParentDir(dir)
                  }}
                >
                  Browse…
                </button>
              </span>
            </label>
            {error && <div className="note warn">{error}</div>}
            <div className="form-actions">
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                Back
              </button>
              <button type="submit" className="btn primary" disabled={!parentDir || !artifactId || busy}>
                {busy ? <LoaderCircle size={14} className="spin" /> : <FolderPlus size={14} />} Create project
              </button>
            </div>
          </form>
        )}

        {!creating && !cloning && recent.length > 0 && (
          <div className="welcome-recent">
            <h2>Recent</h2>
            {recent.slice(0, 6).map((r) => (
              <button key={r.root} className="recent-row" onClick={() => void openProject(r.root)}>
                <strong>{r.name}</strong>
                <span className="mono">{`\u200e${r.root}`}</span>
              </button>
            ))}
          </div>
        )}

        <div className="welcome-foot">
          <button className="link" onClick={() => useStudio.getState().setAdminOpen(true)}>
            Settings
          </button>
          <span>{catalog ? `${catalog.index.components.length} components · ${catalog.index.eips.length} models in catalog` : ''}</span>
          <span className="spacer" />
          {toolchain && (
            <span className={cx(!(toolchain.java && toolchain.maven) && 'warn')}>
              {toolchain.java ? `Java ${toolchain.java}` : 'JDK not found'} · {toolchain.maven ? `Maven ${toolchain.maven}` : 'Maven not found'}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
