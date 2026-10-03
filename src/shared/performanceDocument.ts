/** Plain dialogue and bounded acting annotations. Offsets are UTF-16, end-exclusive. */
export interface Acting { emotion: string; strength?: 'low' | 'normal' | 'high'; transition?: 'immediate' | 'gradual' }
export interface ActingRange { start: number; end: number; acting: Acting }
export interface PerformanceDocument { text: string; ranges: ActingRange[]; revision: number }
export interface TextEdit { start: number; end: number; insert: string }
export interface SelectionRange { start: number; end: number }

export function plainDocument(text = ''): PerformanceDocument { return { text, ranges: [], revision: 0 } }
function same(a: Acting, b: Acting): boolean {
  return a.emotion === b.emotion && a.strength === b.strength && a.transition === b.transition
}
function boundary(text: string, n: number): boolean {
  if (!Number.isInteger(n) || n < 0 || n > text.length) return false
  return !(n > 0 && n < text.length && /[\uD800-\uDBFF]/.test(text[n - 1]) && /[\uDC00-\uDFFF]/.test(text[n]))
}
function validate(text: string, start: number, end: number): void {
  if (!boundary(text, start) || !boundary(text, end) || end < start) throw new Error('INVALID_TEXT_RANGE')
}
function merge(ranges: ActingRange[]): ActingRange[] {
  const result: ActingRange[] = []
  for (const item of ranges.filter(r => r.end > r.start).sort((a, b) => a.start - b.start)) {
    const last = result.at(-1)
    if (last && last.end > item.start) throw new Error('OVERLAPPING_ACTING_RANGES')
    if (last && last.end === item.start && same(last.acting, item.acting)) last.end = item.end
    else result.push({ ...item, acting: { ...item.acting } })
  }
  return result
}

/** Replace just the selected annotation; preserve the unaffected left/right portions. */
export function markActing(doc: PerformanceDocument, selection: SelectionRange, acting: Acting | null): PerformanceDocument {
  const { start, end } = selection
  validate(doc.text, start, end)
  if (start === end) return doc
  const ranges: ActingRange[] = []
  for (const r of doc.ranges) {
    if (r.end <= start || r.start >= end) ranges.push(r)
    else {
      if (r.start < start) ranges.push({ ...r, end: start })
      if (r.end > end) ranges.push({ ...r, start: end })
    }
  }
  if (acting) ranges.push({ start, end, acting })
  const next = merge(ranges)
  if (JSON.stringify(next) === JSON.stringify(doc.ranges)) return doc
  return { ...doc, ranges: next, revision: doc.revision + 1 }
}

/** Inserted text inherits acting only inside a surviving range, never at its outer edges. */
export function editText(doc: PerformanceDocument, edit: TextEdit): PerformanceDocument {
  const { start: a, end: b, insert } = edit
  validate(doc.text, a, b)
  const text = doc.text.slice(0, a) + insert + doc.text.slice(b)
  if (text === doc.text) return doc
  const delta = insert.length - (b - a)
  const ranges: ActingRange[] = []
  // A whole-script replacement does not guess how old acting maps onto new dialogue.
  if (!(a === 0 && b === doc.text.length && b > a)) for (const r of doc.ranges) {
    if (r.end <= a) { ranges.push(r); continue }
    if (r.start >= b) { ranges.push({ ...r, start: r.start + delta, end: r.end + delta }); continue }
    if (r.start < a) ranges.push({ ...r, end: a })
    const inside = a === b ? r.start < a && a < r.end
      : r.start <= a && b <= r.end && !(a === r.start && b === r.end)
    if (inside && insert.length) ranges.push({ ...r, start: a, end: a + insert.length })
    if (r.end > b) ranges.push({ ...r, start: b + delta, end: r.end + delta })
  }
  return { text, ranges: merge(ranges), revision: doc.revision + 1 }
}

/** Prefer the browser's beforeinput range: repeated letters make plain text diff ambiguous. */
export function inferEdit(before: string, after: string, hint?: SelectionRange): TextEdit {
  if (hint && boundary(before, hint.start) && boundary(before, hint.end) && hint.end >= hint.start) {
    const count = after.length - (before.length - (hint.end - hint.start))
    if (count >= 0 && after.slice(0, hint.start) === before.slice(0, hint.start)
      && after.slice(hint.start + count) === before.slice(hint.end)) {
      return { ...hint, insert: after.slice(hint.start, hint.start + count) }
    }
  }
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  while (start > 0 && (!boundary(before, start) || !boundary(after, start))) start--
  let end = before.length, nextEnd = after.length
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
  while (!boundary(before, end) || !boundary(after, nextEnd)) { end++; nextEnd++ }
  return { start, end, insert: after.slice(start, nextEnd) }
}

export interface EditorHistory { past: PerformanceDocument[]; present: PerformanceDocument; future: PerformanceDocument[] }
export function beginHistory(doc: PerformanceDocument): EditorHistory { return { past: [], present: doc, future: [] } }
export function commitHistory(h: EditorHistory, doc: PerformanceDocument): EditorHistory {
  if (doc === h.present) return h
  return { past: [...h.past.slice(-99), h.present], present: doc, future: [] }
}
export function stepHistory(h: EditorHistory, direction: 'undo' | 'redo'): EditorHistory {
  const from = direction === 'undo' ? h.past : h.future
  const target = from.at(-1)
  if (!target) return h
  // Never revive an old revision number: an old generation must remain stale after undo.
  const present = { ...target, revision: h.present.revision + 1 }
  return direction === 'undo'
    ? { past: h.past.slice(0, -1), present, future: [...h.future, h.present] }
    : { past: [...h.past, h.present], present, future: h.future.slice(0, -1) }
}

export function toCodePointRange(doc: PerformanceDocument, range: SelectionRange, expectedRevision: number): SelectionRange {
  if (doc.revision !== expectedRevision) throw new Error('STALE_DOCUMENT')
  validate(doc.text, range.start, range.end)
  return { start: Array.from(doc.text.slice(0, range.start)).length, end: Array.from(doc.text.slice(0, range.end)).length }
}
