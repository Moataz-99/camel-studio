import { useEffect, useState } from 'react'
import { CircleCheck, Copy, FolderOpen, FolderOutput, Package, X } from 'lucide-react'
import { DEFAULT_ENV } from '@/config/properties'
import { useStudio } from '@/store'

const isMac = window.studio.platform === 'darwin'
// A constant, so the store selector returns the same value every time.
const ONLY_DEFAULT = [DEFAULT_ENV]

/** Builds the deployable JAR: the Designer's "build archive", for the team's usual deploy. */
export function BuildDialog(): React.JSX.Element | null {
  const open = useStudio((s) => s.buildOpen)
  const project = useStudio((s) => s.project)
  const runStatus = useStudio((s) => s.runStatus)
  const envs = useStudio((s) => s.globals?.envs ?? ONLY_DEFAULT)
  const [version, setVersion] = useState('')
  const [tests, setTests] = useState(true)
  useEffect(() => {
    if (open) setVersion(project?.version ?? '')
  }, [open, project?.version])
  if (!open || !project) return null
  const close = (): void => useStudio.getState().setBuildOpen(false)
  const busy = runStatus !== 'idle' && runStatus !== 'failed'
  const versionOk = !version || /^[A-Za-z0-9][\w.+-]*$/.test(version)
  const others = envs.filter((e) => e !== DEFAULT_ENV)
  return (
    <div className="modal-back" onMouseDown={close}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          void useStudio.getState().buildPackage(!tests, version.trim() || null)
        }}
      >
        <header className="modal-head">
          <Package size={15} />
          <strong>Build package</strong>
          <span className="spacer" />
          <button type="button" className="icon-btn" onClick={close} title="Close">
            <X size={15} />
          </button>
        </header>
        <div className="modal-body">
          <div className="hint">
            Builds a runnable Spring Boot JAR with Maven (<span className="mono">mvn clean package</span>). It holds your routes, their libraries and the global variables of
            every environment{others.length ? ` (${others.join(', ')})` : ''}; you pick the environment when you start it. Camel Studio&apos;s tracing and debugging tools are not
            included.
          </div>
          <div className="build-grid">
            <label>
              <span>Artifact</span>
              <input className="input mono" readOnly value={project.artifactId ?? project.name} />
            </label>
            <label>
              <span>Version</span>
              <input className={`input mono${versionOk ? '' : ' is-bad'}`} value={version} placeholder="1.0.0" onChange={(e) => setVersion(e.target.value)} />
            </label>
          </div>
          {version !== (project.version ?? '') && versionOk && version && <div className="hint">The new version is written to pom.xml before building.</div>}
          <label className="check-line">
            <input type="checkbox" checked={tests} onChange={(e) => setTests(e.target.checked)} />
            <span>Run the project&apos;s tests during the build</span>
          </label>
          {busy && <div className="note warn">Stop the running application first: the build cleans the target folder it runs from.</div>}
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !versionOk || !project.hasPom}>
            <Package size={14} /> Build
          </button>
        </footer>
      </form>
    </div>
  )
}

const size = (n: number): string => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** The package the build produced, and how to start it on a server. */
export function BuiltDialog(): React.JSX.Element | null {
  const built = useStudio((s) => s.built)
  const envs = useStudio((s) => s.globals?.envs ?? ONLY_DEFAULT)
  const runEnv = useStudio((s) => s.runEnv)
  const [env, setEnv] = useState(runEnv)
  useEffect(() => setEnv(runEnv), [runEnv, built])
  if (!built) return null
  const { notify, closeBuilt } = useStudio.getState()
  const file = built.artifact.split(/[\\/]/).pop() ?? built.artifact
  const command = `java -jar ${file}${env && env !== DEFAULT_ENV ? ` --spring.profiles.active=${env}` : ''}`
  return (
    <div className="modal-back" onMouseDown={closeBuilt}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <CircleCheck size={15} />
          <strong>Package ready</strong>
          <span className="spacer" />
          <button className="icon-btn" onClick={closeBuilt} title="Close">
            <X size={15} />
          </button>
        </header>
        <div className="modal-body">
          <div className="built-file">
            <Package size={22} />
            <div>
              <strong className="mono">{file}</strong>
              <span className="muted">{size(built.size)}</span>
              <span className="muted mono path" title={built.artifact}>{`‎${built.artifact}`}</span>
            </div>
          </div>
          <div className="built-run">
            <div className="built-run-head">
              <span>Start it on a server with</span>
              {envs.length > 1 && (
                <select className="input mini" value={env} onChange={(e) => setEnv(e.target.value)} title="Environment: its global variables are used">
                  {envs.map((e) => (
                    <option key={e} value={e}>
                      {e === DEFAULT_ENV ? 'Default env' : e}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="built-cmd">
              <code className="mono">{command}</code>
              <button
                className="icon-btn"
                title="Copy the command"
                onClick={() => {
                  void navigator.clipboard.writeText(command)
                  notify('Command copied', 'success')
                }}
              >
                <Copy size={13} />
              </button>
            </div>
            <div className="hint">Java 17 or later must be installed on the server. Secrets can stay on the server: set them as environment variables there instead of keeping them in the project.</div>
          </div>
        </div>
        <footer className="modal-foot">
          <button className="btn" onClick={() => void window.studio.project.reveal(built.artifact)}>
            <FolderOpen size={14} /> {isMac ? 'Show in Finder' : 'Show in folder'}
          </button>
          <button
            className="btn"
            onClick={async () => {
              const dest = await window.studio.project.copyArtifact(built.artifact).catch((e) => {
                notify(String(e), 'error')
                return null
              })
              if (dest) notify(`Copied to ${dest}`, 'success')
            }}
          >
            <FolderOutput size={14} /> Copy to…
          </button>
          <span className="spacer" />
          <button className="btn primary" onClick={closeBuilt}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
