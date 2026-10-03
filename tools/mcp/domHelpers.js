// AudioForge 개발툴 MCP — 렌더러(화면) 안에서 실행되는 조작 도우미. MCP 서버(tools/mcp/server.cjs)가 명령마다 이 코드를 앞에 붙여 실행한다.
//   출처: Spine2DManager tools/mcp/domHelpers.js(§278)를 옮겨 왔다. 바꾼 것 — AudioForge 는 요소마다 data-testid 를 달아 두므로
//   ① 요소 설명에 testid 를 싣고 ② 'testid:이름' 으로 지정할 수 있게 했다.
//   마우스·키보드(OS 입력)를 쓰지 않고 화면 요소(DOM)에 직접 이벤트를 보낸다 → 창이 화면 밖·비활성이어도 동작.
//   요소 지정(target) 규칙:
//     '@12'           → query 결과의 ref 번호(요소에 data-mcp-ref 로 붙여 둔 번호 — 화면이 다시 그려지면 바뀔 수 있음)
//     '.cls' '#id' '[attr]' 'tag.cls > x' → CSS 선택자(보이는 첫 요소, index로 n번째)
//     그 밖의 문자열   → 보이는 글자로 찾기(버튼 우선 · 가장 안쪽 요소 우선) → 없으면 title/aria-label/placeholder
/* eslint-disable no-unused-vars */
const __mcp = (() => {
  const vis = (el) => { if (!el || !el.getBoundingClientRect) return false; const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) return false; const s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' }
  const refOf = (el) => {
    if (!el.dataset.mcpRef) { window.__mcpRefSeq = (window.__mcpRefSeq || 0) + 1; el.dataset.mcpRef = String(window.__mcpRefSeq) }
    return '@' + el.dataset.mcpRef
  }
  const INTERACTIVE = 'button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem], [role=checkbox], [role=option], [role=dialog], [contenteditable=true], label, summary, [tabindex]:not([tabindex="-1"]), [data-testid]'
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim()
  const isSelector = (q) => /^[.#[]/.test(q) || /^[a-z]+[.#[:\s>]/i.test(q) || /^(button|input|select|textarea|canvas|label|div|span|a)$/i.test(q)
  function rootOf (within) { if (!within) return document; const r = resolve(within, null, false, 0); return r || null }
  function resolve (target, within, exact, index) {
    if (target == null) return null
    const root = rootOf(within); if (!root) return null
    const q = String(target)
    if (q.startsWith('testid:')) { const els = [...root.querySelectorAll('[data-testid="' + q.slice(7) + '"]')].filter(vis); return els[index || 0] || null }
    if (q[0] === '@') { const el = document.querySelector(`[data-mcp-ref="${q.slice(1)}"]`); return el && root.contains(el) ? el : null }
    if (isSelector(q)) { try { const els = [...root.querySelectorAll(q)].filter(vis); if (els.length) return els[index || 0] || null } catch {} }
    const cands = [...root.querySelectorAll(INTERACTIVE + ', li, span, div, td, th, h1, h2, h3, h4, p')].filter(vis)
    const txt = (e) => (e.innerText || '').replace(/\s+/g, ' ').trim()
    const rank = (e) => (/^(BUTTON|A|LABEL|INPUT|SELECT)$/.test(e.tagName) || e.getAttribute('role') === 'button' ? 0 : 1) * 1e6 + txt(e).length
    let hits = cands.filter((e) => (exact ? txt(e) === q : txt(e).includes(q))).sort((a, b) => rank(a) - rank(b))
    if (!hits.length) hits = cands.filter((e) => [e.getAttribute('title'), e.getAttribute('aria-label'), e.getAttribute('placeholder')].some((v) => v && (exact ? v === q : v.includes(q))))
    return hits[index || 0] || null
  }
  function describe (el, withRect = true) {
    const o = { ref: refOf(el), tag: el.tagName.toLowerCase() }
    if (el.dataset && el.dataset.testid) o.testid = el.dataset.testid
    const t = label(el); if (t) o.text = t.slice(0, 120)
    const title = el.getAttribute('title'); if (title && title !== t) o.title = title.slice(0, 200)
    if (el.type && el.tagName === 'INPUT') o.type = el.type
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') o.disabled = true
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) o.checked = el.checked
    else if ('value' in el && el.tagName !== 'BUTTON' && el.tagName !== 'LI') o.value = String(el.value).slice(0, 200)
    if (el.tagName === 'SELECT') o.options = [...el.options].map((op) => ({ value: op.value, label: op.textContent.trim(), ...(op.disabled ? { disabled: true } : {}), ...(op.selected ? { selected: true } : {}), ...(op.title ? { reason: op.title } : {}) }))
    const cls = typeof el.className === 'string' ? el.className.trim() : ''; if (cls) o.class = cls.slice(0, 80)
    if (el.classList.contains('active') || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true') o.active = true
    if (withRect) { const r = el.getBoundingClientRect(); o.rect = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
    return o
  }
  function query ({ filter = 'interactive', within = null, text = null, limit = 200 }) {
    const root = rootOf(within); if (!root) return { error: 'within 대상 없음: ' + within }
    let els = [...root.querySelectorAll(filter === 'all' ? INTERACTIVE + ', h1, h2, h3, h4, th, td, li, p, span, div' : INTERACTIVE)].filter(vis)
    if (filter === 'all') els = els.filter((e) => e.matches(INTERACTIVE) || [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    if (text) els = els.filter((e) => label(e).includes(text))
    const total = els.length
    return { total, shown: Math.min(total, limit), items: els.slice(0, limit).map((e) => describe(e)) }
  }
  function fire (el, type, Ctor = MouseEvent) { el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window })) }
  function click ({ target, within, exact, index }) {
    const el = resolve(target, within, exact, index)
    if (!el) return { clicked: false, error: '대상 없음: ' + target }
    if (el.disabled) return { clicked: false, error: '비활성 요소', element: describe(el) }
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const P = window.PointerEvent || MouseEvent
    fire(el, 'pointerdown', P); fire(el, 'mousedown'); fire(el, 'pointerup', P); fire(el, 'mouseup')
    el.click()
    return { clicked: true, element: describe(el) }
  }
  function setNative (el, value) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const d = Object.getOwnPropertyDescriptor(proto, 'value'); d.set.call(el, value) // React가 값 변화를 알아채도록 원본 setter 사용
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  function set ({ target, value, within, exact }) {
    const el = resolve(target, within, exact, 0)
    if (!el) return { set: false, error: '대상 없음: ' + target }
    if (el.disabled) return { set: false, error: '비활성 요소', element: describe(el) }
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) { if (el.checked !== !!value) el.click(); return { set: true, element: describe(el) } }
    if (el.tagName === 'SELECT') {
      const op = [...el.options].find((o) => o.value === String(value)) || [...el.options].find((o) => o.textContent.trim() === String(value))
      if (!op) return { set: false, error: '선택지 없음: ' + value, element: describe(el) }
      if (op.disabled) return { set: false, error: '비활성 선택지: ' + value + (op.title ? ' — ' + op.title : ''), element: describe(el) }
      setNative(el, op.value); return { set: true, element: describe(el) }
    }
    if (el.isContentEditable) { el.textContent = String(value); el.dispatchEvent(new Event('input', { bubbles: true })); return { set: true, element: describe(el) } }
    if ('value' in el) { el.focus(); setNative(el, String(value)); el.blur(); return { set: true, element: describe(el) } }
    return { set: false, error: '값을 넣을 수 없는 요소', element: describe(el) }
  }
  function text (selector, maxChars) { const el = selector === 'body' ? document.body : (resolve(selector, null, false, 0)); const t = el ? (el.innerText || '') : ''; return { chars: t.length, text: t.slice(0, maxChars) } }
  function rect (selector) { const el = resolve(selector, null, false, 0); if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.round(r.width), height: Math.round(r.height) } }
  // 긴 문자열(data URL 등)은 잘라 요약 — 응답이 수 MB가 되지 않게
  function summarize (v, depth = 0) {
    if (typeof v === 'string') return v.length > 400 ? v.slice(0, 120) + `…<${v.length}자 생략>` : v
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return `<바이너리 ${v.byteLength}바이트>`
    if (Array.isArray(v)) return depth > 6 ? `<배열 ${v.length}개>` : (v.length > 300 ? [...v.slice(0, 300).map((x) => summarize(x, depth + 1)), `…<${v.length - 300}개 생략>`] : v.map((x) => summarize(x, depth + 1)))
    if (v && typeof v === 'object') { if (depth > 6) return '<객체>'; const o = {}; for (const [k, x] of Object.entries(v)) o[k] = summarize(x, depth + 1); return o }
    return v
  }
  // AudioForge 의 window.api 는 묶음으로 나뉜다(audio.getFileUrl · reader.speak …) — 점으로 이은 이름으로 부른다.
  function apiFn (method) {
    const parts = String(method).split('.')
    let owner = null, cur = window.api
    for (const p of parts) { owner = cur; cur = cur == null ? undefined : cur[p] }
    return typeof cur === 'function' ? cur.bind(owner) : null
  }
  async function api (method, args, full) {
    const fn = apiFn(method)
    if (!fn) throw new Error('window.api에 없는 함수: ' + method + " — api_list 로 이름 확인('audio.getFileUrl' 처럼 점으로)")
    const r = await fn(...(args || []))
    return full ? r : summarize(r)
  }
  const apiList = () => {
    const out = []
    const walk = (o, pre, depth) => {
      for (const k of Object.keys(o || {})) {
        const v = o[k]
        if (typeof v === 'function') out.push(pre + k)
        else if (v && typeof v === 'object' && depth < 3) walk(v, pre + k + '.', depth + 1)
      }
    }
    walk(window.api, '', 0)
    return out.sort()
  }
  const visibleEl = (selector) => { const el = resolve(selector, null, false, 0); return el && vis(el) ? describe(el) : null }
  return { query, click, set, text, rect, api, apiList, visibleEl, describe, resolve }
})()
