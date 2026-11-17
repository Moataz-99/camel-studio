import { useEffect, useRef } from 'react'
import { basicSetup, EditorView } from 'codemirror'
import { Annotation, EditorState } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { tags as t } from '@lezer/highlight'

const External = Annotation.define<boolean>()

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.tagName, t.attributeName], color: 'var(--syn-key)' },
  { tag: [t.string, t.attributeValue, t.content], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--syn-number)' },
  { tag: [t.comment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.bracket, t.angleBracket], color: 'var(--text-3)' }
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', color: 'var(--text)', backgroundColor: 'var(--bg-0)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--bg-0)', color: 'var(--text-3)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'var(--bg-2)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: 'var(--select)' }
})

/** A small code editor for messages: JSON or XML, editable or read-only. */
export function CodeArea(props: { value: string; language: 'json' | 'xml'; readOnly?: boolean; onChange?(text: string): void }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const onChange = useRef(props.onChange)
  onChange.current = props.onChange

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          props.language === 'json' ? json() : xml(),
          syntaxHighlighting(highlight),
          theme,
          EditorState.readOnly.of(!!props.readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) onChange.current?.(u.state.doc.toString())
          })
        ]
      })
    })
    view.current = v
    return () => v.destroy()
  }, [props.language, props.readOnly]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === props.value) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: props.value }, annotations: External.of(true) })
  }, [props.value])

  return <div className="code-area" ref={host} />
}
