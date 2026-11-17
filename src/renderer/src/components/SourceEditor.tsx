import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { Annotation, EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { yaml } from '@codemirror/lang-yaml'
import { java } from '@codemirror/lang-java'
import { tags as t } from '@lezer/highlight'
import { Lock } from 'lucide-react'
import { rangeOf, samePath } from '@/model/camel'
import { generateFor } from '@/model/source'
import { cx } from './util'
import { useActiveFile, useStudio } from '@/store'

/** Marks transactions that mirror a canvas edit, so they are not echoed back to the store. */
const External = Annotation.define<boolean>()

// Colours come from CSS variables, so the editor follows the app theme without being rebuilt.
const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName), t.attributeName], color: 'var(--syn-key)' },
  { tag: [t.string, t.special(t.string), t.content], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-key)' },
  { tag: [t.annotation, t.meta], color: 'var(--syn-meta)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.bracket], color: 'var(--text-3)' }
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', color: 'var(--text)', backgroundColor: 'var(--bg-1)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-1)', color: 'var(--text-3)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-2)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-2)', color: 'var(--text-2)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--select)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--bg-3)', outline: 'none' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-3)', border: 'none', color: 'var(--text-2)' }
})

function ModelEditor({ extra }: { extra?: ReactNode }): React.JSX.Element {
  const file = useActiveFile()
  const selection = useStudio((s) => s.selection)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const path = file?.path
  const language = file?.language
  const readOnly = language === 'java'

  useEffect(() => {
    if (!host.current || !path) return
    const current = useStudio.getState().files[path]
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: current?.text ?? '',
        extensions: [
          basicSetup,
          keymap.of([indentWithTab]),
          language === 'java' ? java() : yaml(),
          syntaxHighlighting(highlight),
          theme,
          EditorState.tabSize.of(2),
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.some((tr) => tr.annotation(External))) return
            useStudio.getState().setText(path, u.state.doc.toString())
          })
        ]
      })
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
  }, [path, language, readOnly])

  // Canvas edits rewrite the text: mirror them into the editor.
  useEffect(() => {
    const v = view.current
    if (!v || file === null) return
    const doc = v.state.doc.toString()
    if (doc === file.text) return
    v.dispatch({ changes: { from: 0, to: doc.length, insert: file.text }, annotations: External.of(true) })
  }, [file, file?.text])

  // Selecting a step on the canvas reveals it in the source.
  useEffect(() => {
    const v = view.current
    if (!v || !file || file.language !== 'yaml' || !selection || v.hasFocus) return
    const range = rangeOf(file.text, selection.path)
    if (!range) return
    const max = v.state.doc.length
    const from = Math.min(range[0], max)
    v.dispatch({ selection: { anchor: from, head: Math.min(range[1], max) }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
  }, [selection]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="source-pane">
      <div className="source-head">
        <span className="crumb">{file?.rel ?? 'No file'}</span>
        <span className="spacer" />
        {extra}
        {readOnly && (
          <span className="chip">
            <Lock size={11} /> read-only
          </span>
        )}
        {file?.error && <span className="chip error">{file.error}</span>}
      </div>
      <div className="source-body" ref={host} />
    </div>
  )
}

/** Java projects: the class Camel Studio will write on save, kept in step with the canvas. Read-only. */
function JavaPreview({ extra }: { extra: ReactNode }): React.JSX.Element {
  const file = useActiveFile()
  const project = useStudio((s) => s.project)
  const catalog = useStudio((s) => s.catalog)
  const selection = useStudio((s) => s.selection)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const result = useMemo(() => (file?.js && project && catalog ? generateFor(file.js, project, file.name, file.rel, catalog) : null), [file?.js, file?.name, file?.rel, project, catalog])
  const code = result?.code ?? ''

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: '', extensions: [basicSetup, java(), syntaxHighlighting(highlight), theme, EditorState.readOnly.of(true)] })
    })
    view.current = v
    return () => {
      v.destroy()
      view.current = null
    }
  }, [])

  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === code) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: code } })
  }, [code])

  // Selecting a step on the canvas reveals the line generated for it.
  useEffect(() => {
    const v = view.current
    if (!v || !result || !selection) return
    const hit = [...result.lines].find(([, target]) => samePath(target.path, selection.path))
    if (!hit || hit[0] > v.state.doc.lines) return
    const line = v.state.doc.line(hit[0])
    v.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
  }, [selection, result])

  return (
    <div className="source-pane">
      <div className="source-head">
        <span className="crumb">{project && result ? `${project.javaDir}/${result.fileName}` : 'No file'}</span>
        <span className="spacer" />
        {extra}
        <span className="chip">
          <Lock size={11} /> generated
        </span>
      </div>
      <div className="source-body" ref={host} />
    </div>
  )
}

export function SourceEditor(): React.JSX.Element {
  const file = useActiveFile()
  const isJavaProject = useStudio((s) => s.project?.routeFormat === 'java')
  const [show, setShow] = useState<'java' | 'model'>('java')
  if (!isJavaProject || file?.language !== 'yaml') return <ModelEditor />
  const toggle = (
    <div className="seg small">
      <button className={cx(show === 'java' && 'is-on')} onClick={() => setShow('java')}>
        Java
      </button>
      <button className={cx(show === 'model' && 'is-on')} onClick={() => setShow('model')} title="The visual model Camel Studio edits; the Java class is generated from it">
        Model
      </button>
    </div>
  )
  return show === 'java' ? <JavaPreview extra={toggle} /> : <ModelEditor extra={toggle} />
}
