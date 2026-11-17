import { useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Check, FolderGit2, GitBranch, History, KeyRound, LoaderCircle, Pencil, RefreshCw, TriangleAlert, X } from 'lucide-react'
import type { GitCommit, GitFile, GitFileState } from '@shared/types'
import { useStudio } from '@/store'
import { cx } from './util'

const LETTER: Record<GitFileState, string> = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflict: '!' }
const LABEL: Record<GitFileState, string> = { modified: 'Changed', added: 'Added', deleted: 'Deleted', renamed: 'Renamed', untracked: 'New file', conflict: 'Conflict: fix and commit' }

const spin = <LoaderCircle size={13} className="spin" />

/** Branch, changes and sync state in the title bar; opens the Git tab. */
export function BranchChip(): React.JSX.Element | null {
  const git = useStudio((s) => s.git)
  if (!git?.repo) return null
  const changes = git.files.length
  return (
    <button className="tb-branch" onClick={() => useStudio.getState().setBottom(true, 'git')} title={`Git: ${changes} uncommitted ${changes === 1 ? 'change' : 'changes'}${git.upstream ? `, ${git.ahead} to push, ${git.behind} to pull` : ''}`}>
      <GitBranch size={13} />
      <span>{git.branch ?? 'detached'}</span>
      {changes > 0 && <span className="count">{changes}</span>}
      {git.ahead > 0 && <span className="sync">↑{git.ahead}</span>}
      {git.behind > 0 && <span className="sync">↓{git.behind}</span>}
      {git.merging && <TriangleAlert size={12} className="warn-ico" />}
    </button>
  )
}

export function GitPanel(): React.JSX.Element {
  const git = useStudio((s) => s.git)
  const busy = useStudio((s) => s.gitBusy)
  const root = useStudio((s) => s.project?.root)
  const { gitRun, refreshGit } = useStudio.getState()
  const [tab, setTab] = useState<'changes' | 'history'>('changes')
  const [message, setMessage] = useState('')
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [diffFor, setDiffFor] = useState<GitFile | null>(null)
  const [history, setHistory] = useState<GitCommit[] | null>(null)

  useEffect(() => {
    void refreshGit()
  }, [refreshGit])
  useEffect(() => {
    if (tab === 'history' && root && git?.repo) void window.studio.git.log(root).then(setHistory)
  }, [tab, root, git])

  const files = git?.files ?? []
  const selected = useMemo(() => files.filter((f) => !unchecked.has(f.path)), [files, unchecked])

  if (!git) return <div className="console-empty">{spin} Reading the Git status…</div>
  if (!git.available)
    return (
      <div className="console-empty">
        <TriangleAlert size={14} /> Git is not installed on this machine. Install it from git-scm.com (on a Mac, the Xcode command line tools include it), then reopen this tab.
      </div>
    )
  if (!git.repo)
    return (
      <div className="git-empty">
        <FolderGit2 size={26} />
        <div>
          <strong>This project is not in a Git repository yet.</strong>
          <span>Create one to commit your work, then add your team&apos;s remote to push and pull.</span>
        </div>
        <button className="btn primary" disabled={!!busy} onClick={() => void gitRun('init')}>
          {busy === 'init' ? spin : <GitBranch size={14} />} Create repository
        </button>
      </div>
    )

  const all = selected.length === files.length
  // During a merge Git only allows committing everything.
  const commitPaths = all || git.merging ? [] : selected.flatMap((f) => (f.from ? [f.path, f.from] : [f.path]))
  const conflicts = files.filter((f) => f.state === 'conflict').length
  const canCommit = !!message.trim() && (selected.length > 0 || git.merging) && !busy && !!git.identity && conflicts === 0

  return (
    <div className="git-panel">
      <div className="git-side">
        <div className="git-branch">
          <GitBranch size={14} />
          <strong>{git.branch ?? 'detached HEAD'}</strong>
          {git.upstream ? <span className="muted">→ {git.upstream}</span> : git.remote ? <span className="muted">not pushed yet</span> : null}
          <span className="spacer" />
          <button className="icon-btn" title="Check the server for new commits (git fetch)" disabled={!!busy || !git.remote} onClick={() => void gitRun('fetch')}>
            {busy === 'fetch' ? spin : <RefreshCw size={13} />}
          </button>
        </div>
        <RemoteRow remote={git.remote} />
        {!git.identity && <IdentityForm />}
        {git.merging && (
          <div className="git-merge">
            <TriangleAlert size={14} />
            <span>
              {conflicts > 0
                ? `Pull stopped: ${conflicts === 1 ? '1 file was' : `${conflicts} files were`} changed both here and on the server. Keep one side, or edit the conflict markers in Source and save. Then commit.`
                : 'Conflicts settled: commit to finish the pull.'}
            </span>
            <button className="btn mini" disabled={!!busy} onClick={() => void gitRun('abort')}>
              Abort merge
            </button>
          </div>
        )}
        <textarea
          className="input git-msg"
          placeholder={git.merging ? 'Merge message, for example: Merge the team’s changes' : 'What changed? For example: Validate the order before routing'}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCommit) void gitRun('commit', { message, paths: commitPaths }).then((ok) => ok && setMessage(''))
          }}
        />
        <div className="git-actions">
          <button
            className="btn primary"
            disabled={!canCommit}
            title={!git.identity ? 'Add your name and email first' : conflicts > 0 ? 'Fix the conflicts first' : 'Commit the checked changes (⌘↵)'}
            onClick={() => void gitRun('commit', { message, paths: commitPaths }).then((ok) => ok && setMessage(''))}
          >
            {busy === 'commit' ? spin : <Check size={14} />} Commit{!git.merging && selected.length > 0 ? ` ${selected.length}` : ''}
          </button>
          <span className="spacer" />
          <button className="btn" disabled={!!busy || !git.remote || git.merging} title={git.remote ? 'Get your team’s commits (git pull)' : 'Add the remote first'} onClick={() => void gitRun('pull')}>
            {busy === 'pull' ? spin : <ArrowDownToLine size={14} />} Pull{git.behind > 0 ? ` ${git.behind}` : ''}
          </button>
          <button className="btn" disabled={!!busy || !git.remote || git.noCommits || git.merging} title={git.remote ? 'Send your commits to the server (git push)' : 'Add the remote first'} onClick={() => void gitRun('push')}>
            {busy === 'push' ? spin : <ArrowUpFromLine size={14} />} Push{git.ahead > 0 ? ` ${git.ahead}` : ''}
          </button>
        </div>
      </div>

      <div className="git-main">
        <div className="git-tabs">
          <button className={cx(tab === 'changes' && 'is-on')} onClick={() => setTab('changes')}>
            Changes {files.length > 0 && <span className="count">{files.length}</span>}
          </button>
          <button className={cx(tab === 'history' && 'is-on')} onClick={() => setTab('history')}>
            <History size={12} /> History
          </button>
        </div>
        {tab === 'changes' ? (
          files.length === 0 ? (
            <div className="console-empty">
              <Check size={14} /> Nothing to commit: the project matches the last commit.
            </div>
          ) : (
            <div className="git-files">
              <label className="git-file head">
                <input type="checkbox" checked={all} disabled={git.merging} onChange={() => setUnchecked(all ? new Set(files.map((f) => f.path)) : new Set())} />
                <span>{git.merging ? 'All changes are committed together to finish the merge' : `${selected.length} of ${files.length} checked for the commit`}</span>
              </label>
              {files.map((f) => {
                const slash = f.path.lastIndexOf('/')
                return (
                  <div key={f.path} className={cx('git-file', `is-${f.state}`)}>
                    <input
                      type="checkbox"
                      checked={!unchecked.has(f.path)}
                      disabled={git.merging}
                      onChange={() =>
                        setUnchecked((u) => {
                          const next = new Set(u)
                          if (next.has(f.path)) next.delete(f.path)
                          else next.add(f.path)
                          return next
                        })
                      }
                    />
                    <button className="git-file-name" onClick={() => setDiffFor(f)} title={`${LABEL[f.state]}. Click to see the change.`}>
                      <span className={cx('git-letter', `is-${f.state}`)}>{LETTER[f.state]}</span>
                      <span className="name">{f.path.slice(slash + 1)}</span>
                      <span className="dir">{slash > 0 ? f.path.slice(0, slash) : ''}</span>
                      {f.from && <span className="dir">from {f.from}</span>}
                    </button>
                    {f.state === 'conflict' && (
                      <span className="git-resolve">
                        <button className="btn mini" disabled={!!busy} title="Use your version of the whole file" onClick={() => void gitRun('resolve', { paths: [f.path], side: 'mine' })}>
                          Keep mine
                        </button>
                        <button className="btn mini" disabled={!!busy} title="Use the version from the server for the whole file" onClick={() => void gitRun('resolve', { paths: [f.path], side: 'theirs' })}>
                          Keep theirs
                        </button>
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          )
        ) : (
          <div className="git-history">
            {history === null ? (
              <div className="console-empty">{spin} Reading history…</div>
            ) : history.length === 0 ? (
              <div className="console-empty">No commits yet.</div>
            ) : (
              history.map((c) => (
                <div key={c.hash} className="git-commit">
                  <span className="mono hash">{c.hash}</span>
                  <span className="subject">{c.subject}</span>
                  <span className="muted">{c.author}</span>
                  <span className="muted when">{c.when}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      {diffFor && root && <DiffDialog root={root} file={diffFor} onClose={() => setDiffFor(null)} />}
    </div>
  )
}

function RemoteRow({ remote }: { remote: string | null }): React.JSX.Element {
  const root = useStudio((s) => s.project?.root)
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState(remote ?? '')
  useEffect(() => setUrl(remote ?? ''), [remote])
  const save = async (): Promise<void> => {
    if (!root) return
    try {
      await window.studio.git.setRemote(root, url)
      setEditing(false)
      useStudio.getState().notify('Remote saved. Push to send your commits there.', 'success')
      await useStudio.getState().refreshGit()
    } catch (e) {
      useStudio.getState().notify(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    }
  }
  if (remote && !editing)
    return (
      <div className="git-remote">
        <span className="muted">Remote</span>
        <span className="mono" title={remote}>
          {remote}
        </span>
        <button className="icon-btn" title="Change the remote address" onClick={() => setEditing(true)}>
          <Pencil size={12} />
        </button>
      </div>
    )
  return (
    <form
      className="git-remote edit"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <input className="input mini mono" autoFocus={editing} placeholder="Remote address: https://… or git@…" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button className="btn mini" type="submit" disabled={!url.trim() || url.trim() === remote}>
        {remote ? 'Save' : 'Add remote'}
      </button>
      {editing && (
        <button className="icon-btn" type="button" title="Cancel" onClick={() => setEditing(false)}>
          <X size={13} />
        </button>
      )}
    </form>
  )
}

function IdentityForm(): React.JSX.Element {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  return (
    <form
      className="git-identity"
      onSubmit={async (e) => {
        e.preventDefault()
        try {
          await window.studio.git.setIdentity(name, email)
          await useStudio.getState().refreshGit()
        } catch (err) {
          useStudio.getState().notify(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
        }
      }}
    >
      <span className="hint">Commits carry your name and email. They are saved in your Git settings for every repository.</span>
      <div className="row">
        <input className="input mini" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input mini" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn mini" type="submit" disabled={!name.trim() || !email.trim()}>
          Save
        </button>
      </div>
    </form>
  )
}

function DiffDialog({ root, file, onClose }: { root: string; file: GitFile; onClose(): void }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    void window.studio.git.diff(root, file.path).then(setText, (e) => setText(`Could not read the change: ${String(e)}`))
  }, [root, file.path])
  const lines = text === null ? [] : text.split('\n')
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal diff-modal" onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <span className={cx('git-letter', `is-${file.state}`)}>{LETTER[file.state]}</span>
          <strong className="mono">{file.path}</strong>
          <span className="muted">{LABEL[file.state]}</span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={15} />
          </button>
        </header>
        <div className="diff">
          {text === null ? (
            <div className="console-empty">{spin} Reading…</div>
          ) : file.state === 'deleted' && !text.trim() ? (
            <div className="console-empty">The file was deleted.</div>
          ) : (
            lines.map((l, i) => (
              <div key={i} className={cx('diff-line', /^(diff --git|index |--- |\+\+\+ |new file|deleted file)/.test(l) ? 'meta' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '')}>
                {l || ' '}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** Git asks for a user name, password, access token, SSH passphrase or to trust a new server. */
export function AskpassDialog(): React.JSX.Element | null {
  const request = useStudio((s) => s.askpass)
  const [value, setValue] = useState('')
  useEffect(() => setValue(''), [request?.id])
  if (!request) return null
  const secret = /password|passphrase|token|pin\b/i.test(request.prompt)
  const hostKey = /continue connecting|fingerprint/i.test(request.prompt)
  const answer = useStudio.getState().answerAskpass
  return (
    <div className="modal-back">
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault()
          answer(value)
        }}
      >
        <header className="modal-head">
          <KeyRound size={15} />
          <strong>{hostKey ? 'Trust this Git server?' : 'Git needs to sign in'}</strong>
        </header>
        <div className="modal-body">
          <div className="askpass-prompt mono">{request.prompt}</div>
          <input className="input" autoFocus type={secret ? 'password' : 'text'} placeholder={hostKey ? 'Type yes to trust it' : ''} value={value} onChange={(e) => setValue(e.target.value)} />
          <div className="hint">
            {hostKey
              ? 'This is the first connection to this server. Check the fingerprint with your Git administrator before answering yes.'
              : 'Your answer goes straight to Git. Camel Studio does not store it; Git’s credential manager (macOS Keychain, Windows Credential Manager) may remember it.'}
          </div>
        </div>
        <footer className="modal-foot">
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => answer(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            OK
          </button>
        </footer>
      </form>
    </div>
  )
}

export function CloneForm({ onBack }: { onBack(): void }): React.JSX.Element {
  const busy = useStudio((s) => s.gitBusy) === 'clone'
  const [url, setUrl] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [error, setError] = useState<string | null>(null)
  const name = url
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop()
  return (
    <form
      className="welcome-form"
      onSubmit={async (e) => {
        e.preventDefault()
        setError(null)
        try {
          await useStudio.getState().cloneProject(url.trim(), parentDir)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }}
    >
      <label>
        <span>Repository address</span>
        <input className="input mono" autoFocus placeholder="https://git.example.com/integration/order-service.git" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        <span>Location</span>
        <span className="input-row">
          <input className="input mono" readOnly value={parentDir && name ? `${parentDir}/${name}` : ''} placeholder="Choose a parent folder" />
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const dir = await window.studio.project.pickFolder('Choose where to clone the repository')
              if (dir) setParentDir(dir)
            }}
          >
            Browse…
          </button>
        </span>
      </label>
      <div className="hint">Uses your Git, SSH keys and saved credentials. If the server asks you to sign in, Camel Studio shows the prompt.</div>
      {error && <div className="note warn">{error}</div>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="submit" className="btn primary" disabled={!url.trim() || !parentDir || busy}>
          {busy ? spin : <ArrowDownToLine size={14} />} Clone and open
        </button>
      </div>
    </form>
  )
}
