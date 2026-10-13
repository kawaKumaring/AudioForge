import { useEffect, useRef } from 'react'
import { EXPRESSION_ICONS, expressionParts, type ExpressionIcon } from '../../shared/expressionIcons'
import { field } from './kit'

export function expressionDomText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
  if (node instanceof HTMLElement && node.dataset.expressionToken) return node.dataset.expressionToken
  if (node instanceof HTMLBRElement) return '\n'
  const children = Array.from(node.childNodes)
  return children.map((child, i) => {
    const block = child instanceof HTMLElement && ['DIV', 'P'].includes(child.tagName)
    return (block && i > 0 ? '\n' : '') + expressionDomText(child)
  }).join('')
}
function marker(cue: ExpressionIcon, original: string = cue.token) {
  const el = document.createElement('span')
  el.dataset.expressionToken = original
  el.contentEditable = 'false'; el.textContent = cue.icon
  el.title = `${cue.label} — ${cue.description}`; el.setAttribute('aria-label', el.title)
  el.style.cssText = 'display:inline-block;vertical-align:baseline;margin:0 3px;padding:0 4px;border-radius:5px;background:var(--accent-glow);outline:1px solid var(--border-subtle);user-select:all;'
  return el
}
export default function ExpressionPromptEditor({ value, change, label, disabled, activate, register }: {
  value: string; change: (text: string) => void; label: string; disabled: boolean
  activate: (insert: (cue: ExpressionIcon) => void) => void
  register?: (insert: ((cue: ExpressionIcon) => void) | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null), range = useRef<Range | null>(null)
  const composing = useRef(false), queued = useRef<ExpressionIcon[]>([])
  const insertion = useRef(0)
  const remember = () => {
    const selection = window.getSelection()
    if (selection?.rangeCount && ref.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) range.current = selection.getRangeAt(0).cloneRange()
  }
  const insert = (cue: ExpressionIcon) => {
    const root = ref.current
    if (!root || root.getAttribute('aria-disabled') === 'true') return
    if (composing.current) { queued.current.push(cue); return }
    root.focus(); const r = range.current?.cloneRange() || document.createRange()
    if (!root.contains(r.commonAncestorContainer)) { r.selectNodeContents(root); r.collapse(true) }
    // 고른 대사를 교체하지 않고 그 앞에 표시를 넣는다.
    r.collapse(true)
    // 같은 자리에 연출만 바꾸면 앞 표시를 교체한다. 대사 글자와 직접 쓴 이모지는 지우지 않는다.
    let previous: Node | null = r.startContainer.nodeType === Node.TEXT_NODE
      ? (r.startOffset === 0 ? r.startContainer.previousSibling : null)
      : r.startContainer.childNodes[r.startOffset - 1] || null
    while (previous?.nodeType === Node.TEXT_NODE && !previous.textContent) previous = previous.previousSibling
    let preserved = ''
    if (previous instanceof HTMLElement && previous.dataset.expressionToken) {
      const existing = EXPRESSION_ICONS.find(c => previous.dataset.expressionToken?.startsWith(c.token))
      preserved = existing ? previous.dataset.expressionToken.slice(existing.token.length) : ''
      r.selectNode(previous)
    }
    let next: Node | null = r.endContainer.nodeType === Node.TEXT_NODE ? r.endContainer : r.endContainer.childNodes[r.endOffset] || null
    while (next?.nodeType === Node.TEXT_NODE && !next.textContent) next = next.nextSibling
    const nextOffset = next === r.endContainer ? r.endOffset : 0
    const literal = next?.nodeType === Node.TEXT_NODE ? EXPRESSION_ICONS.find(c => next!.textContent?.slice(nextOffset).startsWith(c.icon))?.icon : ''
    if (literal && next) { preserved += literal; r.setEnd(next, nextOffset + literal.length) }
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(r)
    if (previous instanceof HTMLElement && previous.dataset.expressionToken === cue.token + preserved) {
      r.setStartAfter(previous); r.collapse(true); selection?.removeAllRanges(); selection?.addRange(r); remember(); return
    }
    // 안전한 고정 표시만 HTML로 삽입해 브라우저의 되돌리기 이력에도 남긴다.
    const node = marker(cue, cue.token + preserved), key = String(++insertion.current); node.dataset.expressionInsert = key
    if (!document.execCommand('insertHTML', false, node.outerHTML)) return
    const added = root.querySelector(`[data-expression-insert="${key}"]`)
    if (added) {
      added.removeAttribute('data-expression-insert'); r.setStartAfter(added); r.collapse(true)
      root.focus(); selection?.removeAllRanges(); selection?.addRange(r)
    }
    remember(); change(expressionDomText(root))
  }
  useEffect(() => {
    const root = ref.current
    if (!root || composing.current || expressionDomText(root) === value) return
    const fragment = document.createDocumentFragment()
    const parts = expressionParts(value)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i], next = parts[i + 1]
      const literal = part.cue && next && !next.cue ? EXPRESSION_ICONS.find(c => next.text.startsWith(c.icon))?.icon || '' : ''
      if (literal) next.text = next.text.slice(literal.length)
      fragment.appendChild(part.cue ? marker(part.cue, part.text + literal) : document.createTextNode(part.text))
    }
    root.replaceChildren(fragment); range.current = null
  }, [value])
  useEffect(() => { register?.(insert); return () => register?.(null) }, [register])
  return <><style>{'.af-expression-input:empty::before{content:attr(data-placeholder);color:var(--text-muted);pointer-events:none}'}</style><div className="af-expression-input" ref={ref} role="textbox" aria-label={label} aria-multiline="true" aria-disabled={disabled}
    data-testid="card-script" data-placeholder="대사를 입력하세요" contentEditable={!disabled} suppressContentEditableWarning spellCheck={false}
    onFocus={() => { remember(); activate(insert) }} onMouseUp={remember} onKeyUp={remember} onBlur={remember}
    onInput={() => { remember(); if (!composing.current && ref.current) change(expressionDomText(ref.current)) }}
    onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => {
      composing.current = false; remember(); if (ref.current) change(expressionDomText(ref.current))
      const operations = queued.current.splice(0); for (const cue of operations) insert(cue)
    }}
    onPaste={e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')) }}
    onCopy={e => {
      const selected = window.getSelection(); if (!selected?.rangeCount) return
      e.preventDefault(); e.clipboardData.setData('text/plain', expressionDomText(selected.getRangeAt(0).cloneContents()))
    }}
    onCut={e => {
      if (disabled) { e.preventDefault(); return }
      const selected = window.getSelection(); if (!selected?.rangeCount) return
      e.preventDefault(); e.clipboardData.setData('text/plain', expressionDomText(selected.getRangeAt(0).cloneContents()))
      document.execCommand('delete'); remember()
    }}
    style={{ ...field, width: '100%', minHeight: 76, maxHeight: 320, resize: 'vertical', overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 15, lineHeight: 1.75, background: 'var(--bg-base)', padding: '11px 13px', margin: '9px 0 0', cursor: disabled ? 'default' : 'text' }}/></>
}
