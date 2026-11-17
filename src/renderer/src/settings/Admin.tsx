// The admin area: Camel Studio's own settings for the whole team.

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Boxes, CircleCheck, Download, FileUp, FolderOpen, LoaderCircle, Package, RefreshCw, Settings, Share2, Trash2, Wrench, X } from 'lucide-react'
import type { CamelVersionInfo, ProgressEvent, ToolchainList } from '@shared/types'
import { cx } from '@/components/util'
import { useStudio } from '@/store'

type SectionId = 'toolchain' | 'camel' | 'projects' | 'palette' | 'profile'

const SECTIONS: { id: SectionId; label: string; icon: React.JSX.Element }[] = [
  { id: 'toolchain', label: 'Java and Maven', icon: <Wrench size={15} /> },
  { id: 'camel', label: 'Camel version', icon: <Package size={15} /> },
  { id: 'projects', label: 'New projects', icon: <FolderOpen size={15} /> },
  { id: 'palette', label: 'Team palette', icon: <Boxes size={15} /> },
  { id: 'profile', label: 'Team profile', icon: <Share2 size={15} /> }
]

const api = (): typeof window.studio => window.studio
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const mb = (n: number): string => `${(n / 1048576).toFixed(n > 10485760 ? 0 : 1)} MB`

function ProgressLine({ p }: { p: ProgressEvent | null }): React.JSX.Element | null {
  if (!p) return null
  if (p.error) return <div className="note warn">{p.task}: {p.error}</div>
  const pct = p.total ? Math.round((p.received / p.total) * 100) : null
  return (
    <div className="progress">
      <div className="progress-text">
        {p.done ? <CircleCheck size={13} /> : <LoaderCircle size={13} className="spin" />}
        {p.done ? `${p.task} installed` : `Downloading ${p.task}… ${mb(p.received)}${p.total ? ` of ${mb(p.total)}` : ''}`}
      </div>
      {!p.done && <div className="progress-bar">{pct !== null && <span style={{ width: `${pct}%` }} />}</div>}
    </div>
  )
}

// --------------------------------------------------------------- toolchain --

function ToolchainSection({ progress }: { progress: ProgressEvent | null }): React.JSX.Element {
  const settings = useStudio((s) => s.settings)
  const toolchain = useStudio((s) => s.toolchain)
  const project = useStudio((s) => s.project)
  const [list, setList] = useState<ToolchainList | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const { updateSettings, notify } = useStudio.getState()

  const refresh = useCallback(async () => {
    setList(null)
    setList(await api().settings.toolchains())
    useStudio.setState({ toolchain: await api().run.toolchain(project?.root ?? null) })
  }, [project?.root])
  useEffect(() => void refresh(), [refresh])

  const install = async (what: 'jdk21' | 'jdk17' | 'maven'): Promise<void> => {
    setBusy(what)
    try {
      if (what === 'maven') await api().settings.installMaven()
      else await api().settings.installJdk(what === 'jdk21' ? 21 : 17)
      await useStudio.getState().loadSettings()
      await refresh()
      notify(what === 'maven' ? 'Maven installed and selected.' : 'JDK installed and selected.', 'success')
    } catch (e) {
      notify(message(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  const choose = async (key: 'javaHome' | 'mavenHome', value: string | null): Promise<void> => {
    await updateSettings({ [key]: value })
    await refresh()
  }
  const browse = async (key: 'javaHome' | 'mavenHome'): Promise<void> => {
    const dir = await api().settings.pickFolder(key === 'javaHome' ? 'Choose a JDK folder (the one that contains bin/java)' : 'Choose a Maven folder (the one that contains bin/mvn)')
    if (dir) await choose(key, dir)
  }

  const row = (key: 'javaHome' | 'mavenHome', path: string | null, label: string, sub: string): React.JSX.Element => {
    const on = (settings?.[key] ?? null) === path
    return (
      <label key={path ?? 'auto'} className={cx('choice-row', on && 'is-on')}>
        <input type="radio" checked={on} onChange={() => void choose(key, path)} />
        <span className="choice-main">
          <strong>{label}</strong>
          <span className="mono">{sub}</span>
        </span>
      </label>
    )
  }

  return (
    <>
      <section className="adm-card">
        <h3>Java (JDK)</h3>
        <p className="hint">Used to run and debug applications and for the Data Mapper preview. Spring Boot 4 needs Java 17 or newer; 21 is recommended.</p>
        <div className="choice-list">
          {row('javaHome', null, 'Automatic', settings?.javaHome ? 'use the Java this machine provides (PATH, JAVA_HOME or Camel Studio’s own)' : toolchain?.java ? `uses Java ${toolchain.java} found on this machine` : 'none found yet')}
          {list === null && <div className="hint">Looking for installed JDKs…</div>}
          {list?.jdks.map((j) => row('javaHome', j.path, `Java ${j.version}`, `${j.source} · ${j.path}`))}
          {settings?.javaHome && !list?.jdks.some((j) => j.path === settings.javaHome) && row('javaHome', settings.javaHome, 'Chosen folder', settings.javaHome)}
        </div>
        <div className="adm-actions">
          <button className="btn small" disabled={!!busy} onClick={() => void install('jdk21')}>
            {busy === 'jdk21' ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />} Install JDK 21
          </button>
          <button className="btn small" disabled={!!busy} onClick={() => void install('jdk17')}>
            <Download size={13} /> Install JDK 17
          </button>
          <button className="btn small" onClick={() => void browse('javaHome')}>
            <FolderOpen size={13} /> Choose a folder…
          </button>
          <button className="icon-btn" title="Look again" onClick={() => void refresh()}>
            <RefreshCw size={14} />
          </button>
        </div>
        {busy?.startsWith('jdk') && <ProgressLine p={progress} />}
        <p className="hint">Installs Eclipse Temurin from adoptium.net, checks its checksum and keeps it in ~/.camel-studio/toolchain. Nothing on the system changes.</p>
      </section>

      <section className="adm-card">
        <h3>Maven</h3>
        <p className="hint">Builds and runs the applications. A project's own Maven wrapper (mvnw), when it has one, is always used for that project.</p>
        <div className="choice-list">
          {row('mavenHome', null, 'Automatic', settings?.mavenHome ? 'use the Maven this machine provides' : toolchain?.maven ? `uses Maven ${toolchain.maven}${toolchain.wrapper ? ' (project wrapper)' : ''}` : 'none found yet')}
          {list?.mavens.map((m) => row('mavenHome', m.path, `Maven ${m.version}`, `${m.source} · ${m.path}`))}
          {settings?.mavenHome && !list?.mavens.some((m) => m.path === settings.mavenHome) && row('mavenHome', settings.mavenHome, 'Chosen folder', settings.mavenHome)}
        </div>
        <div className="adm-actions">
          <button className="btn small" disabled={!!busy} onClick={() => void install('maven')}>
            {busy === 'maven' ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />} Install Maven 3.9
          </button>
          <button className="btn small" onClick={() => void browse('mavenHome')}>
            <FolderOpen size={13} /> Choose a folder…
          </button>
        </div>
        {busy === 'maven' && <ProgressLine p={progress} />}
      </section>

      <section className="adm-card">
        <h3>Maven settings file</h3>
        <p className="hint">For a company repository (Nexus, Artifactory) or a proxy: a settings.xml with your mirror and credentials. It is passed to every build with -s.</p>
        <div className="adm-actions">
          <span className={cx('mono adm-path', !settings?.mavenSettings && 'muted')}>{settings?.mavenSettings ?? 'Maven default (~/.m2/settings.xml if it exists)'}</span>
          <button
            className="btn small"
            onClick={async () => {
              const f = await api().settings.pickFile('Choose a Maven settings.xml', ['xml'])
              if (f) await updateSettings({ mavenSettings: f })
            }}
          >
            <FileUp size={13} /> Choose…
          </button>
          {settings?.mavenSettings && (
            <button className="icon-btn" title="Use Maven's default" onClick={() => void updateSettings({ mavenSettings: null })}>
              <X size={14} />
            </button>
          )}
        </div>
      </section>
    </>
  )
}

// -------------------------------------------------------------------- camel --

function CamelSection({ progress }: { progress: ProgressEvent | null }): React.JSX.Element {
  const catalog = useStudio((s) => s.catalog)
  const project = useStudio((s) => s.project)
  const [versions, setVersions] = useState<CamelVersionInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const { notify } = useStudio.getState()
  const current = catalog?.index.camelVersion

  const load = useCallback(async () => {
    setError(null)
    try {
      setVersions(await api().settings.camelVersions())
    } catch (e) {
      setError(`The list of Camel releases could not be read from Maven Central: ${message(e)}`)
    }
  }, [])
  useEffect(() => void load(), [load])

  const install = async (v: string): Promise<void> => {
    setBusy(v)
    try {
      await api().settings.installCamel(v)
      await load()
    } catch (e) {
      notify(message(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  const projectCamel = project?.camelVersion && !project.camelVersion.includes('$') ? project.camelVersion : null

  return (
    <>
      <section className="adm-card">
        <h3>Camel version of the designer</h3>
        <p className="hint">
          The palette, step forms and checks follow this version's component catalog. New projects are created with it and the Spring Boot version it is built for
          ({catalog?.index.springBootVersion}). Switching reloads the window.
        </p>
        {error && <div className="note warn">{error}</div>}
        {!versions && !error && <div className="hint">Reading Camel releases…</div>}
        <div className="version-list">
          {versions?.map((v) => (
            <div key={v.version} className={cx('version-row', v.version === current && 'is-on')}>
              <strong className="mono">{v.version}</strong>
              {v.lts && <span className="chip ok">LTS</span>}
              {v.bundled && <span className="chip">built in</span>}
              {v.version === current && <span className="chip accent">in use</span>}
              <span className="spacer" />
              {!v.installed && (
                <button className="btn small" disabled={!!busy} onClick={() => void install(v.version)}>
                  {busy === v.version ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />} Download
                </button>
              )}
              {v.installed && v.version !== current && (
                <button className="btn small primary" onClick={() => void api().settings.useCamel(v.bundled ? null : v.version)}>
                  Use this version
                </button>
              )}
            </div>
          ))}
        </div>
        {busy && <ProgressLine p={progress} />}
        <p className="hint">LTS lines get fixes for about a year; the others until the next release. Catalogs are kept in ~/.camel-studio/catalogs.</p>
      </section>
      {project && (
        <section className="adm-card">
          <h3>This project</h3>
          <p className="hint">
            {project.name} uses Camel <strong>{projectCamel ?? 'a version set elsewhere'}</strong>
            {project.springBootVersion ? ` with Spring Boot ${project.springBootVersion}` : ''}.
            {projectCamel === current ? ' It matches the designer.' : ' The designer shows a different catalog, so some options may differ.'}
          </p>
          {projectCamel !== current && (
            <div className="adm-actions">
              <button
                className="btn small"
                onClick={async () => {
                  try {
                    const r = await api().project2.alignVersions(project.root)
                    notify(r.changed.length ? `pom.xml updated: ${r.changed.join(', ')}` : 'pom.xml already matches.', 'success')
                    useStudio.setState({ project: await api().project.rescan(project.root) })
                  } catch (e) {
                    notify(message(e), 'error')
                  }
                }}
              >
                Move this project to Camel {current}
              </button>
              <span className="hint">Changes only the camel.version property and the Spring Boot parent version in pom.xml.</span>
            </div>
          )}
        </section>
      )}
    </>
  )
}

// ------------------------------------------------------------- new projects --

function ProjectsSection(): React.JSX.Element {
  const settings = useStudio((s) => s.settings)
  const [groupId, setGroupId] = useState(settings?.defaults.groupId ?? '')
  const d = settings?.defaults
  const set = (patch: Partial<NonNullable<typeof d>>): void => void useStudio.getState().updateSettings({ defaults: { ...(d as NonNullable<typeof d>), ...patch } })
  return (
    <section className="adm-card">
      <h3>Defaults for new projects</h3>
      <div className="adm-form">
        <label>
          <span>Group ID</span>
          <input
            className="input mono"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            onBlur={() => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(groupId) && set({ groupId })}
            placeholder="eg.vodafone.integration"
          />
        </label>
        <label>
          <span>Routes are saved as</span>
          <select className="input" value={d?.routeFormat ?? 'java'} onChange={(e) => set({ routeFormat: e.target.value as 'java' | 'yaml' })}>
            <option value="java">Java classes (Camel RouteBuilder)</option>
            <option value="yaml">YAML DSL files</option>
          </select>
        </label>
        <label>
          <span>Java version</span>
          <select className="input" value={d?.javaVersion ?? '21'} onChange={(e) => set({ javaVersion: e.target.value })}>
            <option value="17">17</option>
            <option value="21">21 (recommended)</option>
            <option value="25">25</option>
          </select>
        </label>
      </div>
      <p className="hint">The New project form starts with these values; each one can still be changed there.</p>
    </section>
  )
}

// ------------------------------------------------------------ team palette --

function PaletteSection(): React.JSX.Element {
  const settings = useStudio((s) => s.settings)
  const { updateSettings, notify } = useStudio.getState()
  const snippets = settings?.snippets ?? []
  const components = settings?.components ?? []
  return (
    <>
      <section className="adm-card">
        <h3>Reusable processes</h3>
        <p className="hint">Groups of steps the team uses again and again, like a shared process in BW5. To add one, right-click a step on the canvas (or a route's first step for all its steps) and choose “Save to the team palette”.</p>
        {snippets.length === 0 && <div className="adm-empty">None yet.</div>}
        {snippets.map((sn) => (
          <div key={sn.id} className="adm-item">
            <Boxes size={15} />
            <div className="adm-item-main">
              <input className="input adm-inline" value={sn.name} onChange={(e) => void updateSettings({ snippets: snippets.map((x) => (x.id === sn.id ? { ...x, name: e.target.value } : x)) })} />
              <input
                className="input adm-inline sub"
                value={sn.description}
                placeholder="What it does"
                onChange={(e) => void updateSettings({ snippets: snippets.map((x) => (x.id === sn.id ? { ...x, description: e.target.value } : x)) })}
              />
            </div>
            <span className="hint">
              {sn.steps.length} {sn.steps.length === 1 ? 'step' : 'steps'}
            </span>
            <button className="icon-btn danger" title="Remove from the palette" onClick={() => void updateSettings({ snippets: snippets.filter((x) => x.id !== sn.id) })}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </section>
      <section className="adm-card">
        <h3>Team components</h3>
        <p className="hint">
          Camel components your team built (for example a connector to an in-house system). Import the component's JAR: Camel Studio reads its description and Maven coordinates, adds it to the palette with
          its options, and adds the dependency to pom.xml when a route uses it. Your Maven repository must have the JAR for builds to find it.
        </p>
        {components.length === 0 && <div className="adm-empty">None yet.</div>}
        {components.map((c) => (
          <div key={c.scheme} className="adm-item">
            <Package size={15} />
            <div className="adm-item-main">
              <strong>
                {c.title} <span className="mono muted">{c.scheme}:</span>
              </strong>
              <span className="mono sub">
                {c.groupId}:{c.artifactId}:{c.version}
              </span>
            </div>
            <button
              className="icon-btn danger"
              title="Remove"
              onClick={async () => {
                useStudio.setState({ settings: await api().settings.removeComponent(c.scheme) })
                notify('Removed. Reloading the catalog…', 'info')
                setTimeout(() => window.location.reload(), 600)
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <div className="adm-actions">
          <button
            className="btn small"
            onClick={async () => {
              try {
                const c = await api().settings.importComponent()
                if (!c) return
                notify(`${c.title} added. Reloading the catalog…`, 'success')
                setTimeout(() => window.location.reload(), 800)
              } catch (e) {
                notify(message(e), 'error')
              }
            }}
          >
            <FileUp size={13} /> Import a component JAR…
          </button>
        </div>
      </section>
    </>
  )
}

// ------------------------------------------------------------- team profile --

function ProfileSection(): React.JSX.Element {
  const settings = useStudio((s) => s.settings)
  const { notify } = useStudio.getState()
  return (
    <section className="adm-card">
      <h3>Team profile</h3>
      <p className="hint">One file that gives every developer the same setup: the Camel version, the new-project defaults, the reusable processes and the team components. Keep it in Git or on a shared drive, and import it on each machine. Machine-specific choices (which JDK, which Maven, settings.xml) are not included.</p>
      <div className="profile-summary">
        <span>Camel version</span>
        <strong>{settings?.camelVersion ?? 'built-in'}</strong>
        <span>Reusable processes</span>
        <strong>{settings?.snippets.length ?? 0}</strong>
        <span>Team components</span>
        <strong>{settings?.components.length ?? 0}</strong>
      </div>
      <div className="adm-actions">
        <button
          className="btn small primary"
          onClick={async () => {
            const p = await api().settings.exportProfile()
            if (p) notify(`Team profile saved to ${p}`, 'success')
          }}
        >
          <Share2 size={13} /> Export…
        </button>
        <button
          className="btn small"
          onClick={async () => {
            try {
              const s = await api().settings.importProfile()
              if (!s) return
              notify('Team profile imported. Reloading…', 'success')
              setTimeout(() => window.location.reload(), 800)
            } catch (e) {
              notify(message(e), 'error')
            }
          }}
        >
          <FileUp size={13} /> Import…
        </button>
      </div>
    </section>
  )
}

// --------------------------------------------------------------------- view --

export function AdminView(): React.JSX.Element | null {
  const open = useStudio((s) => s.adminOpen)
  const [section, setSection] = useState<SectionId>('toolchain')
  const [progress, setProgress] = useState<ProgressEvent | null>(null)
  useEffect(() => api().settings.onProgress(setProgress), [])
  if (!open) return null
  return (
    <div className="admin">
      <header className="mapper-head">
        <button className="btn small" onClick={() => useStudio.getState().setAdminOpen(false)}>
          <ArrowLeft size={13} /> Back
        </button>
        <Settings size={16} className="gv-icon" />
        <strong>Settings</strong>
        <span className="mapper-name">for Camel Studio on this machine, shareable with the team</span>
      </header>
      <div className="admin-main">
        <nav className="admin-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={cx(section === s.id && 'is-on')} onClick={() => setSection(s.id)}>
              {s.icon} {s.label}
            </button>
          ))}
        </nav>
        <div className="admin-body">
          {section === 'toolchain' && <ToolchainSection progress={progress} />}
          {section === 'camel' && <CamelSection progress={progress} />}
          {section === 'projects' && <ProjectsSection />}
          {section === 'palette' && <PaletteSection />}
          {section === 'profile' && <ProfileSection />}
        </div>
      </div>
    </div>
  )
}
