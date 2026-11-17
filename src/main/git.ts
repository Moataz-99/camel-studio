import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { GitCommit, GitFile, GitFileState, GitStatus } from '@shared/types'
import { askpassEnv } from './askpass'
import { shellEnv } from './runner'

/**
 * Plain Git, run with the user's own installation and configuration: their SSH keys, credential
 * helper and remotes are used as they are. Everything is limited to the project folder, so a
 * project inside a larger repository only sees and commits its own files.
 */

const isWin = process.platform === 'win32'
let dataDir = ''

export function initGit(userDataDir: string): void {
  dataDir = userDataDir
}

export class GitError extends Error {}

interface Opts {
  timeout?: number
  /** Network commands may ask for credentials: route the questions to the window. */
  interactive?: boolean
}

async function env(interactive: boolean): Promise<NodeJS.ProcessEnv> {
  const base: NodeJS.ProcessEnv = {
    ...(await shellEnv()),
    // Never wait on a terminal nobody can see; stable English messages to interpret.
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    LANG: 'C',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no'
  }
  if (!interactive) return { ...base, GIT_OPTIONAL_LOCKS: '0' }
  try {
    return { ...base, ...(await askpassEnv(dataDir)) }
  } catch {
    return base
  }
}

function git(cwd: string, args: string[], opts: Opts = {}): Promise<string> {
  return env(!!opts.interactive).then(
    (e) =>
      new Promise((resolvePromise, reject) => {
        execFile('git', args, { cwd, env: e, timeout: opts.timeout ?? 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          if (!err) return resolvePromise(stdout)
          const killed = (err as { killed?: boolean }).killed
          reject(new GitError(killed ? 'Git took too long and was stopped.' : explain(`${stderr}\n${stdout}`, (err as NodeJS.ErrnoException).code === 'ENOENT')))
        })
      })
  )
}

/** Turns Git's output into a sentence a user can act on. */
function explain(output: string, missing: boolean): string {
  if (missing) return 'Git is not installed on this machine. Install it from git-scm.com, then try again.'
  const text = output.trim()
  const host = text.match(/(?:host|for|to|from) '?(?:https?:\/\/)?(?:[^@/\s]+@)?([\w.-]+\.[a-z]{2,})/i)?.[1]
  if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|HTTP Basic: Access denied|error: 401|401 Unauthorized/.test(text))
    return `Git could not sign in${host ? ` to ${host}` : ''}. Check the user name and the password or access token, then try again.`
  if (/Permission denied \(publickey|Host key verification failed/.test(text))
    return `The Git server${host ? ` ${host}` : ''} refused the connection over SSH. Add your SSH public key to your Git account, or use the HTTPS address.`
  if (/Could not resolve host|Connection timed out|Connection refused|Network is unreachable|Failed to connect/.test(text))
    return `Could not reach the Git server${host ? ` ${host}` : ''}. Check the network or VPN.`
  if (/Please tell me who you are|empty ident/.test(text)) return 'Git needs your name and email for commits. Fill them in above the commit message.'
  const overwritten = text.match(/would be overwritten by merge:\s*\n([\s\S]*?)\n(?:Please|Aborting)/)
  if (overwritten) return `Pull would overwrite uncommitted changes in ${files(overwritten[1])}. Commit them first, then pull.`
  if (/\[rejected\]|non-fast-forward|fetch first/.test(text)) return 'The server has commits you do not have yet. Pull first, then push again.'
  if (/does not appear to be a git repository|repository '.*' not found|Repository not found/i.test(text))
    return 'The remote repository was not found. Check its address and that you have access to it.'
  if (/nothing to commit/.test(text)) return 'There is nothing to commit.'
  if (/already exists and is not an empty directory/.test(text)) return 'That folder already exists. Choose another location.'
  // Otherwise the last meaningful lines, without Git's hints.
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^hint:/.test(l))
  return lines.slice(-3).join(' ').replace(/^(fatal|error): /i, '') || 'Git failed.'
}

const files = (block: string): string => {
  const list = block
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  return list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', ')
}

let available: boolean | null = null
async function hasGit(): Promise<boolean> {
  if (available !== null) return available
  if (process.platform === 'darwin') {
    // /usr/bin/git on a Mac without developer tools is a stub that pops up an installer: do not
    // run it. A real Git is one elsewhere on the PATH (Homebrew and the like) or the developer tools'.
    const dirs = ((await shellEnv()).PATH ?? '').split(':').filter((d) => d && d !== '/usr/bin')
    const devTools = ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git']
    if (!dirs.some((d) => existsSync(join(d, 'git'))) && !devTools.some((g) => existsSync(g))) return (available = false)
  }
  available = await git(process.cwd(), ['--version']).then(() => true, () => false)
  return available
}

/** Prefix of the project folder inside its repository ('' at the top). */
async function prefix(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--show-prefix'])).trim()
  } catch {
    return null
  }
}

const STATE: Record<string, GitFileState> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'added' }
const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

export async function status(root: string): Promise<GitStatus> {
  const empty: GitStatus = { available: true, repo: false, branch: null, upstream: null, ahead: 0, behind: 0, remote: null, files: [], merging: false, identity: null, noCommits: false }
  if (!(await hasGit())) return { ...empty, available: false }
  const pre = await prefix(root)
  if (pre === null) return empty
  const out = await git(root, ['status', '--porcelain=v1', '-b', '-z', '-uall', '--', '.'])
  const parts = out.split('\0')
  const head = parts[0].startsWith('## ') ? parts.shift()!.slice(3) : ''
  const result: GitStatus = { ...empty, repo: true }
  if (/^No commits yet on /.test(head) || /^Initial commit on /.test(head)) {
    result.noCommits = true
    result.branch = head.replace(/^(No commits yet|Initial commit) on /, '').split('...')[0]
  } else if (/^HEAD \(no branch\)/.test(head)) {
    result.branch = null
  } else {
    const m = head.match(/^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/)
    result.branch = m?.[1] ?? null
    result.upstream = m?.[2] ?? null
    result.ahead = Number(m?.[3]?.match(/ahead (\d+)/)?.[1] ?? 0)
    result.behind = Number(m?.[3]?.match(/behind (\d+)/)?.[1] ?? 0)
  }
  const strip = (p: string): string => (pre && p.startsWith(pre) ? p.slice(pre.length) : p)
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const path = strip(entry.slice(3))
    const file: GitFile = { path, state: 'modified' }
    if (xy === '??') file.state = 'untracked'
    else if (CONFLICT.has(xy)) file.state = 'conflict'
    else file.state = STATE[xy[0] !== ' ' ? xy[0] : xy[1]] ?? 'modified'
    if (xy[0] === 'R' || xy[0] === 'C') file.from = strip(parts[++i] ?? '')
    result.files.push(file)
  }
  const [remote, name, email, gitDir] = await Promise.all([
    git(root, ['remote', 'get-url', 'origin']).then((s) => s.trim(), () => null),
    git(root, ['config', 'user.name']).then((s) => s.trim(), () => ''),
    git(root, ['config', 'user.email']).then((s) => s.trim(), () => ''),
    git(root, ['rev-parse', '--git-dir']).then((s) => s.trim(), () => '.git')
  ])
  result.remote = remote
  result.identity = name && email ? { name, email } : null
  result.merging = existsSync(join(isAbsolute(gitDir) ? gitDir : join(root, gitDir), 'MERGE_HEAD'))
  return result
}

export async function log(root: string): Promise<GitCommit[]> {
  const out = await git(root, ['log', '-n', '40', '--date=relative', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s', '--', '.']).catch(() => '')
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, author, when, subject] = line.split('\x1f')
      return { hash, author, when, subject }
    })
}

/** Safe relative path inside the project, for use after `--`. */
function rel(root: string, path: string): string {
  const full = resolve(root, path)
  if (full !== root && !full.startsWith(root.endsWith('/') || root.endsWith('\\') ? root : root + (isWin ? '\\' : '/'))) throw new GitError('Path is outside the project')
  return path.replace(/\\/g, '/')
}

export async function diff(root: string, path: string): Promise<string> {
  const p = rel(root, path)
  const tracked = await git(root, ['ls-files', '--error-unmatch', '--', p]).then(() => true, () => false)
  if (!tracked) {
    // A new file: everything is an addition.
    const text = await readFile(resolve(root, p), 'utf8').catch(() => '')
    const lines = text.slice(0, 200_000).split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return [`new file ${p}`, ...lines.map((l) => `+${l}`)].join('\n')
  }
  const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(() => true, () => false)
  const out = await git(root, hasHead ? ['diff', 'HEAD', '--no-color', '--', p] : ['diff', '--cached', '--no-color', '--', p])
  return out.length > 400_000 ? `${out.slice(0, 400_000)}\n… (cut: the change is very large)` : out
}

const GITIGNORE = `target/
*.log
.idea/
*.iml
.vscode/
.DS_Store
`

export async function init(root: string): Promise<void> {
  await git(root, ['init', '-b', 'main']).catch(async () => {
    // Git older than 2.28 has no -b.
    await git(root, ['init'])
    await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  })
  // Build output and editor files never belong in the repository.
  if (!existsSync(join(root, '.gitignore'))) await writeFile(join(root, '.gitignore'), GITIGNORE, 'utf8')
}

export async function commit(root: string, message: string, paths: string[]): Promise<string> {
  const msg = message.trim()
  if (!msg) throw new GitError('Write a commit message first.')
  const specs = paths.length ? paths.map((p) => rel(root, p)) : ['.']
  await git(root, ['add', '-A', '--', ...specs])
  // Finishing a merge must commit the whole index: Git refuses a commit limited to paths then.
  const gitDir = (await git(root, ['rev-parse', '--git-dir'])).trim()
  const merging = existsSync(join(isAbsolute(gitDir) ? gitDir : join(root, gitDir), 'MERGE_HEAD'))
  const out = await git(root, merging ? ['commit', '-m', msg] : ['commit', '-m', msg, '--', ...specs])
  return out.match(/^\[[^\]]*?([0-9a-f]{7,})\]/m)?.[1] ?? ''
}

async function currentBranch(root: string): Promise<string> {
  return (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
}

export async function pull(root: string): Promise<string> {
  const out = await git(root, ['pull', '--no-rebase', '--no-edit'], { interactive: true, timeout: 180_000 }).catch(async (e: GitError) => {
    // A merge that stopped on conflicts is not a failure to report as an error: the files are marked.
    const s = await status(root).catch(() => null)
    if (s?.merging) {
      const conflicts = s.files.filter((f) => f.state === 'conflict').map((f) => f.path)
      throw new GitError(
        `Pulled, but ${conflicts.length === 1 ? '1 file conflicts' : `${conflicts.length} files conflict`} with your changes: ${conflicts.slice(0, 3).join(', ')}${conflicts.length > 3 ? ' …' : ''}. Fix ${conflicts.length === 1 ? 'it' : 'them'} and commit, or abort the merge.`
      )
    }
    throw e
  })
  if (/Already up to date/i.test(out)) return 'Already up to date.'
  const changed = out.match(/(\d+) files? changed/)?.[1]
  return changed ? `Pulled: ${changed} ${changed === '1' ? 'file' : 'files'} changed.` : 'Pulled.'
}

export async function push(root: string): Promise<string> {
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).then((s) => s.trim(), () => null)
  if (!upstream) {
    const remote = await git(root, ['remote', 'get-url', 'origin']).then(() => true, () => false)
    if (!remote) throw new GitError('This repository has no remote yet. Add the remote address first.')
    const branch = await currentBranch(root)
    await git(root, ['push', '-u', 'origin', branch], { interactive: true, timeout: 180_000 })
    return `Pushed ${branch} to origin.`
  }
  await git(root, ['push'], { interactive: true, timeout: 180_000 })
  return `Pushed to ${upstream}.`
}

export async function fetch(root: string): Promise<void> {
  await git(root, ['fetch', '--prune'], { interactive: true, timeout: 120_000 })
}

function checkUrl(url: string): string {
  const u = url.trim()
  if (!u || u.startsWith('-') || /\s/.test(u)) throw new GitError('That is not a Git repository address.')
  if (!/^(https?:\/\/|ssh:\/\/|git@|[\w.-]+@[\w.-]+:|file:\/\/|\/|[A-Za-z]:\\)/.test(u)) throw new GitError('Use an HTTPS or SSH address, like https://git.example.com/team/order-service.git')
  return u
}

export async function setRemote(root: string, url: string): Promise<void> {
  const u = checkUrl(url)
  const has = await git(root, ['remote', 'get-url', 'origin']).then(() => true, () => false)
  await git(root, has ? ['remote', 'set-url', 'origin', u] : ['remote', 'add', 'origin', u])
}

/** Saved in the user's global Git configuration, as `git config --global` does. */
export async function setIdentity(name: string, email: string): Promise<void> {
  if (!name.trim() || !/^[^\s@]+@[^\s@]+$/.test(email.trim())) throw new GitError('Enter your name and a valid email address.')
  await git(process.cwd(), ['config', '--global', 'user.name', name.trim()])
  await git(process.cwd(), ['config', '--global', 'user.email', email.trim()])
}

/** Settles a conflicting file by taking one whole side: the local version or the pulled one. */
export async function resolveConflict(root: string, path: string, side: 'mine' | 'theirs'): Promise<void> {
  const p = rel(root, path)
  // A file deleted on one side has no version there to check out: keeping that side removes it.
  const ok = await git(root, ['checkout', side === 'mine' ? '--ours' : '--theirs', '--', p]).then(() => true, () => false)
  if (ok) await git(root, ['add', '--', p])
  else await git(root, ['rm', '-q', '--', p])
}

export async function abortMerge(root: string): Promise<void> {
  await git(root, ['merge', '--abort'])
}

export async function clone(url: string, parentDir: string): Promise<string> {
  const u = checkUrl(url)
  const name = basename(u.replace(/[\\/]+$/, '').replace(/\.git$/, '')).replace(/^.*:/, '')
  if (!name || name === '.' || name === '..') throw new GitError('Could not tell the folder name from that address.')
  const dest = join(resolve(parentDir), name)
  if (existsSync(dest)) throw new GitError(`${dest} already exists. Choose another location.`)
  await git(resolve(parentDir), ['clone', '--', u, dest], { interactive: true, timeout: 15 * 60_000 })
  return dest
}
