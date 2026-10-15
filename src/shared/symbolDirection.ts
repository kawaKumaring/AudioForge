/** 기호 연출 v1: 원문 불변, 명시적 추가 쉼과 지원되는 줄 단위 말투 요청만. */
// @ts-ignore TS5097
import { cardScriptWithEmotion, voiceSupports, type CardVoice } from './synthesisCardVoice.ts'
export const DIRECTION_SYMBOLS = ['!', ',', '.', '~', '-', '♥'] as const
export interface DirectionSettings { symbolDirection?: boolean; symbolDisabled?: string[]; emotion: string }
export interface DirectionEntry { start: number; end: number; symbol: string; label: string; kind: 'pause' | 'request' | 'kept' | 'silent' }
export interface SymbolReading { version: 1; original: string; script: string; entries: DirectionEntry[] }
export function symbolDisabled(value: unknown): string[] {
  return Array.isArray(value) ? DIRECTION_SYMBOLS.filter(s => value.includes(s)) : []
}
export function cardSymbolReading(original: string, settings: DirectionSettings, voice: CardVoice): SymbolReading {
  const entries: DirectionEntry[] = []
  if (!settings.symbolDirection) return { version: 1, original, script: cardScriptWithEmotion(original, settings.emotion, voice), entries }
  const disabled = symbolDisabled(settings.symbolDisabled)
  const canEmotion = voiceSupports(voice).emotion
  let offset = 0
  const script = original.split('\n').map(line => {
    const base = offset; offset += line.length + 1
    // 직접 쓴 태그·코드·이스케이프가 있는 줄은 이중 해석하지 않는다.
    if (/[\[\]`\\]/.test(line)) {
      for (const m of line.matchAll(/[!,.~♥-]+/g)) entries.push({ start: base+m.index!, end: base+m.index!+m[0].length, symbol: m[0], kind: 'kept', label: '직접 쓴 태그·코드·이스케이프가 있어 이 줄은 그대로' })
      return line
    }
    const protectedAt = new Set<number>()
    // 주소·메일·파일명·숫자가 든 토큰은 표기 자체가 뜻을 가진다.
    for (const m of line.matchAll(/\S+/g)) {
      if (/[0-9０-９]/.test(m[0]) || /[:/@=]/.test(m[0]) || /[A-Za-z][.~-][A-Za-z]/.test(m[0]))
        for (let i=m.index!; i<m.index!+m[0].length; i++) protectedAt.add(i)
    }
    // 사이에 말이 없는 연속 기호는 쉼 태그를 중복 생성하지 않는다.
    for (const m of line.matchAll(/[!,.~♥-](?:\s+[!,.~♥-])+/g))
      for (let i=m.index!; i<m.index!+m[0].length; i++) protectedAt.add(i)
    let requested = ''
    let conflict = false
    const pending: number[] = []
    const directed = line.replace(/[!,.~♥-]+/g, (marks: string, at: number) => {
      const before=line.slice(0,at), after=line.slice(at+marks.length)
      const symbol=marks[0]
      const entry: DirectionEntry = { start: base+at, end: base+at+marks.length, symbol: marks, kind: 'kept', label: '원문 기호 유지 · 억양은 모델에 맡김' }
      entries.push(entry)
      if (disabled.includes(symbol)) { entry.label='이 기호 연출 끔 · 원문 유지'; return marks }
      if ([...marks].some(s => s !== symbol) || [...marks].some((_,i) => protectedAt.has(at+i))) {
        entry.label='숫자·주소 또는 복합 기호 보호 · 원문 유지'; return marks
      }
      if (!/[\p{L}]/u.test(before)) return marks
      if (symbol === ',' || symbol === '.' || symbol === '-') {
        // 문맥 모델에서는 문장부호마다 독립 합성을 만들지 않는다.
        if (voice.kind === 'reference' && voice.engine === 'cosyvoice3') {
          entry.label = '원문 문장부호 유지 · 같은 생성 안에서 자연스러운 쉼 요청(길이 보장 없음)'
          return marks
        }
        const standaloneDash = symbol !== '-' || (/\s$/.test(before) && /^\s/.test(after) && !/[0-9０-９=]/.test(line))
        const sentenceDot = symbol !== '.' || (marks.length === 1 && /[가-힣][”’"')]*$/.test(before) && /^(?:\s|$)/.test(after))
        if (!standaloneDash || !sentenceDot || !/[\p{L}]/u.test(after) || (symbol !== '-' && marks.length !== 1)) return marks
        // 한 글자 감탄사를 독립 생성하면 끝내지 못할 수 있다(실제 "음 -" 생성 상한 재현).
        // 가까운 기호 사이 발화를 보수적으로 확인하고, 짧으면 원문 기호만 모델에 맡긴다.
        const leftClause = before.split(/[!,.~♥-]/).at(-1) || ''
        const rightClause = after.split(/[!,.~♥-]/)[0]
        if ((leftClause.match(/\p{L}/gu) || []).length < 2 || (rightClause.match(/\p{L}/gu) || []).length < 2) {
          // 독립 대시는 그대로 보내면 "마이너스"로 읽기도 한다. 글자는 남기고 장식만 제외한다.
          entry.kind = symbol === '-' ? 'silent' : 'kept'
          entry.label = symbol === '-'
            ? '짧은 발화를 나누지 않고 대시만 읽지 않음 · 쉼 길이 지정 안 함'
            : '짧은 발화를 나누지 않고 원문 기호 유지 · 쉼 길이 지정 안 함'
          return symbol === '-' ? '' : marks
        }
        const seconds = symbol === ',' ? .15 : symbol === '.' ? .3 : .2
        entry.kind='pause'; entry.label=`추가 쉼 ${seconds}초 · 원래 발화의 쉼은 유지`
        return (symbol === '-' ? '' : marks) + `[쉼 ${seconds}]`
      }
      // 말끝 장식에만 적용. A♥B, 문자열 가운데 물결 등은 보존한다.
      if (!/^[\s”’"')]*$/.test(after)) return marks
      const mood = symbol === '!' ? '자신감' : '다정'
      if (!canEmotion || (settings.emotion && settings.emotion !== '자연스럽게')) {
        entry.kind = symbol === '!' ? 'kept' : 'silent'
        entry.label = (canEmotion ? '선택한 감정 우선' : '이 목소리는 말투 지시 미지원') + (symbol === '!' ? ' · 느낌표 유지' : ' · 장식 기호는 읽지 않음')
        return symbol === '!' ? marks : ''
      }
      if (requested && requested !== mood) conflict=true
      requested=mood; pending.push(entries.length-1)
      entry.kind='request'; entry.label=symbol === '!' ? '이 줄에 강조 요청 · 고함 보장 아님' : '이 줄에 다정한 말투 요청 · 말끝 길이 변경 없음'
      return symbol === '!' ? marks : ''
    })
    if (conflict) {
      for (const i of pending) { entries[i].kind='kept'; entries[i].label='서로 다른 말투 기호 · 자동 요청 없이 원문 유지' }
      return line
    }
    return requested ? `[${requested}] ${directed}` : directed
  }).join('\n')
  return { version: 1, original, script: cardScriptWithEmotion(script, settings.emotion, voice), entries }
}
/** 저장된 과거 요청을 현재 설정으로 다시 계산하지 않는다. */
export function readSymbolReading(raw: unknown): SymbolReading | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r=raw as SymbolReading
  if (r.version !== 1 || typeof r.original !== 'string' || typeof r.script !== 'string' || !Array.isArray(r.entries)) return undefined
  if (!r.entries.every(e => e && Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= 0 && e.end >= e.start && e.end <= r.original.length && typeof e.label === 'string' && typeof e.symbol === 'string' && ['pause','request','kept','silent'].includes(e.kind))) return undefined
  return { version: 1, original: r.original, script: r.script, entries: r.entries.map(e=>({...e})) }
}


