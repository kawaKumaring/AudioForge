import { stripSpokenSymbols } from './speechSymbols.ts'
import { applyOrdinals, findOrdinals, type OrdinalChange } from './spokenOrdinals.ts'
/**
 * 낭독 — **보이는 글과 읽는 글을 나누는 규칙**, 그리고 낭독 설정.
 *
 * ★보이는 글은 건드리지 않는다. 덩이는 원문 글자 자리(start/end)를 들고 다니며
 *   본문 표시·건너뛰기를 잇는다 — 원문을 고치면 그 고리가 끊긴다.
 *   그래서 **소리로 보낼 때만** 이 규칙을 탄다.
 */

/** 설정 파일의 열쇠 — 낭독 설정 한 벌. */
export const READER_PREFS_STORAGE_KEY = 'readerPrefs'

export interface ReaderPrefs {
  shelfView: 'cover' | 'compact' | 'list'
  shelfGrouped: boolean
  autoNext: boolean
  /** 읽는 구절을 화면이 따라간다. */
  follow: boolean
  /**
   * 괄호 속 한자를 읽지 않는다 — `학교(學校)` 를 "학교" 로만 읽는다.
   * ★지시 (2026-09-29): "(한자) 가 있을 때 한자를 중국어로 읽는데, 옵션으로 () 안의 한문은
   *   읽지 않도록." 기본은 **끔** — 켜기 전에는 예전과 똑같이 읽는다.
   */
  skipHanjaInParens: boolean
  /**
   * 본문 글자 크기(px). ★지시 (2026-09-30): "텍스트를 불러오면 처음 셋팅되어 있는 텍스트 크기가 크다.
   *   크기를 줄이고 해당 크기를 옵션에서 조절할 수 있게." 예전 기본은 19 였다.
   */
  fontSize: number
  /**
   * 전에 쓴 **내 목소리 파일**(참조 목소리) — 목소리 고르기에 다시 보인다(최근 것부터, 최대 READER_RECENT_MAX).
   * ★2026-10-01 이전에는 다른 목소리로 바꾸면 그 파일을 다시 골라 준비부터 다시 해야 했다.
   */
  recentVoices: Array<{ path: string; label: string }>
  /**
   * 대사에 감정을 담아 읽는다(2026-10-01 지시: "낭독에도 감정 표현을 적용하라") — Qwen 지정 목소리 + 1.7B 일 때만 쓰인다.
   * 감정은 대사와 앞뒤 서술의 단서 낱말로 정한다(readerEmotion). 기본 켬.
   */
  emotion: boolean
  /**
   * 사용자가 **고른 목소리 지정** (2026-10-02 재검수 — 앱을 껐다 켜도 고른 목소리가 남는다). 지정만 저장한다 — 소리 파일을 복사하지 않는다.
   *  · 기본 목소리 — 엔진 + 모델 이름. ★경로가 아니다: 앱을 옮기거나 다시 깔아 경로가 달라져도 같은 목소리를 찾는다.
   *  · 내 목소리 파일 — 준비해 둔 목소리 조각(또는 원본)의 경로.
   * 고른 적이 없으면 null(처음 쓰는 사람만 첫 기본 목소리가 기본값이 된다).
   */
  voice: SavedReaderVoice | null
}

export type SavedReaderVoice =
  | { kind: 'builtin'; engineId: string; modelId: string; label: string }
  | { kind: 'reference'; path: string; label: string }

export const READER_RECENT_MAX = 5

/** 저장본의 목소리 지정을 믿지 않는다 — 모양이 다르면 없는 것으로. */
export function parseSavedVoice(raw: unknown): SavedReaderVoice | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const str = (v: unknown, max: number): string => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : '')
  const label = str(o.label, 200)
  if (!label) return null
  if (o.kind === 'builtin') {
    const engineId = str(o.engineId, 60), modelId = str(o.modelId, 120)
    return engineId && modelId ? { kind: 'builtin', engineId, modelId, label } : null
  }
  if (o.kind === 'reference') {
    const path = str(o.path, 2000)
    return path ? { kind: 'reference', path, label } : null
  }
  return null
}

export const READER_FONT_MIN = 13
export const READER_FONT_MAX = 24

export const DEFAULT_READER_PREFS: ReaderPrefs = { shelfView: 'compact', shelfGrouped: true, autoNext: true, follow: true, skipHanjaInParens: false, fontSize: 16, recentVoices: [], emotion: true, voice: null }

/** 최근 목소리 목록에 넣는다 — 같은 파일은 맨 앞으로 옮기고, 넘치면 오래된 것을 뺀다. */
export function rememberVoice(list: ReaderPrefs['recentVoices'], v: { path: string; label: string }): ReaderPrefs['recentVoices'] {
  return [{ path: v.path, label: v.label }, ...list.filter((x) => x.path !== v.path)].slice(0, READER_RECENT_MAX)
}

/** 저장본을 믿지 않는다 — 모르는 값은 기본으로 돌린다. */
export function parseReaderPrefs(raw: unknown): ReaderPrefs {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    shelfView: o.shelfView === 'cover' || o.shelfView === 'list' ? o.shelfView : 'compact',
    shelfGrouped: typeof o.shelfGrouped === 'boolean' ? o.shelfGrouped : true,
    autoNext: typeof o.autoNext === 'boolean' ? o.autoNext : true,
    follow: typeof o.follow === 'boolean' ? o.follow : DEFAULT_READER_PREFS.follow,
    skipHanjaInParens: typeof o.skipHanjaInParens === 'boolean'
      ? o.skipHanjaInParens : DEFAULT_READER_PREFS.skipHanjaInParens,
    fontSize: typeof o.fontSize === 'number' && Number.isFinite(o.fontSize)
      ? Math.round(Math.min(READER_FONT_MAX, Math.max(READER_FONT_MIN, o.fontSize)))
      : DEFAULT_READER_PREFS.fontSize,
    recentVoices: Array.isArray(o.recentVoices)
      ? o.recentVoices.filter((x): x is { path: string; label: string } =>
          !!x && typeof x === 'object' && typeof (x as { path?: unknown }).path === 'string' && !!(x as { path: string }).path
          && typeof (x as { label?: unknown }).label === 'string').map((x) => ({ path: x.path, label: x.label })).slice(0, READER_RECENT_MAX)
      : [],
    emotion: typeof o.emotion === 'boolean' ? o.emotion : DEFAULT_READER_PREFS.emotion,
    voice: parseSavedVoice(o.voice),
  }
}

// 한자(한중일 통합 한자 + 확장 A + 호환 한자)
const HAN = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF'
/**
 * 괄호 하나 — 안이 **한자뿐**일 때만(띄어쓰기·가운뎃점·쉼표는 한자 사이에 올 수 있다).
 * ★한글·영문·숫자가 섞이면 건드리지 않는다. `(학교)`·`(1920년)`·`(學校, school)` 은 읽는 내용이다.
 * 반각 `()` 과 전각 `（）` 을 모두 본다. 앞의 띄어쓰기도 함께 뺀다 — `대한민국 (大韓民國)` → `대한민국`.
 */
const HANJA_IN_PARENS = new RegExp(`[ \\t]*[(（][ \\t]*[${HAN}][${HAN} \\t·・,、]*[)）]`, 'g')

/**
 * 이 덩이를 **소리로 보낼 글.** 보이는 글은 그대로이고 소리로 보낼 때만 탄다.
 * - 늘: 소리 내지 않는 기호를 뺀다(규칙은 `speechSymbols.ts` 한 곳 — 파이썬 짝과 같은 사례로 검사한다).
 * - 설정을 켜면: 괄호 속 한자를 뺀다(기호보다 먼저 — 한자 괄호를 통째로 알아보려면 괄호가 있어야 한다).
 * 빼고 나서 **읽을 글자가 남지 않으면** 빈 글을 돌려준다 — 부르는 쪽이 소리 없이 건너뛴다.
 */
export function speakableText(text: string, prefs: Pick<ReaderPrefs, 'skipHanjaInParens'>): string {
  return stripSpokenSymbols(prefs.skipHanjaInParens ? text.replace(HANJA_IN_PARENS, '') : text)
}

/** 소리 글 만들기 선택 — 서수 읽기 보정은 **부르는 쪽이 Qwen 목소리일 때만** 켠다(spokenOrdinals.ts). */
export interface PlanOptions extends Pick<ReaderPrefs, 'skipHanjaInParens'> {
  ordinals?: boolean
  /** 이 덩이 **바로 앞의 원문**(문서 좌표로 덩이 시작 앞 ORDINAL_CONTEXT 글자) — 서수 경계를 덩이 밖까지 본다. */
  before?: string
}

/** 구절 하나 — 보이는 글(덩이 안 자리)과 그 구절을 소리로 읽는 글. */
export interface ReadingPart {
  /** 덩이 글 안의 시작·끝(끝은 포함하지 않는다). */
  from: number; to: number
  /** 소리로 보낸 글자 수(띄어쓰기 빼고) — 쉼 짝짓기의 무게다. */
  weight: number
  /** 문장 끝(또는 줄 끝)에서 끊겼다 — 쉼이 길다. 아니면 쉼표. */
  strong: boolean
  /** 이 구절을 소리로 보낸 글(감정 덩어리마다 나눠 보낼 때 쓴다). 빈 글이면 소리 없음. */
  spoken?: string
}

const CLOSERS = '"”’\'」』)）】›»'

/**
 * 덩이를 **구절**(문장 끝 · 쉼표)로 나누고, 구절마다 소리로 보낼 글을 만든다 (2026-10-01 — 따라가기).
 *
 * ★소리로 보내는 글(say)은 구절들의 읽을 글을 잇는다 — 줄이 바뀐 자리는 줄바꿈으로(쉼이 그대로 남는다),
 *   나머지는 띄어쓰기 하나로. 그래서 구절마다 보이는 자리와 읽는 글자 수를 함께 안다.
 * ★괄호 안의 쉼표에서는 자르지 않는다 — `(學校, 學生)` 을 가르면 괄호 속 한자 빼기가 알아보지 못한다.
 * ★읽을 것이 없는 구절(기호만)은 무게 0 — 소리 없이 지나간다.
 */
export function readingPlan(text: string, prefs: PlanOptions): { say: string; parts: ReadingPart[]; ordinalChanges: number } {
  // ★서수 경계는 **덩이 전체 원문**에서 찾는다(구절로 자른 뒤에는 "1.7번째" 의 7 이 구절 맨 앞이 되어 경계를 잃는다).
  //   바꾼 글은 구절의 소리 글(spoken)에만 — 구절의 원문 자리(from/to)는 그대로라 따라가기·감정 구간이 밀리지 않는다.
  const ordinals: OrdinalChange[] = prefs.ordinals ? findOrdinals(text, prefs.before || '') : []
  let ordinalChanges = 0
  const cuts: Array<{ at: number; strong: boolean }> = []
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '(' || c === '（') { depth++; continue }
    if (c === ')' || c === '）') { depth = Math.max(0, depth - 1); continue }
    if (c === '\n') { cuts.push({ at: i + 1, strong: true }); continue }
    const strong = c === '.' || c === '!' || c === '?' || c === '…' || c === '。'
    const weak = !depth && (c === ',' || c === '，' || c === ';' || c === '、')
    if (!strong && !weak) continue
    let j = i + 1
    while (j < text.length && '.!?…'.includes(text[j])) j++
    while (j < text.length && CLOSERS.includes(text[j])) j++
    cuts.push({ at: j, strong })
    i = j - 1
  }
  const parts: ReadingPart[] = []
  let say = ''
  let from = 0
  let spokenTo = 0                  // 마지막으로 소리 낸 구절의 끝 — 줄바꿈 수를 여기서부터 센다
  const push = (to: number, strong: boolean) => {
    const raw = text.slice(from, to)
    const lead = raw.length - raw.trimStart().length
    const body = raw.trim()
    if (body) {
      const start = from + lead
      let source = body
      if (ordinals.length) { const r = applyOrdinals(text, start, start + body.length, ordinals); source = r.text; ordinalChanges += r.applied }
      const spoken = speakableText(source, prefs)
      if (spoken) {
        // 사이의 줄바꿈 수를 그대로 — 빈 줄(문단 사이)은 합성 쪽에서 긴 쉼이 된다(예전 글과 같게).
        const breaks = text.slice(spokenTo, start).split('\n').length - 1
        say += say ? (breaks ? '\n'.repeat(breaks) : ' ') + spoken : spoken
        spokenTo = start + body.length
      }
      parts.push({ from: start, to: start + body.length, weight: spoken.replace(/\s/g, '').length, strong, spoken })
    }
    from = to
  }
  for (const c of cuts) if (c.at > from) push(c.at, c.strong)
  if (from < text.length) push(text.length, true)
  return { say, parts, ordinalChanges }
}
