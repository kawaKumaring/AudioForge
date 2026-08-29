// 감정 태그 데이터(렌더러 전용) — TTSEditor UI와 ProcessButton 게이팅이 공유하는 단일 소스.
// ⚠️ 각 emotion의 id는 Python(python/tts_worker.py의 EMOTION_TAGS 값 / EMOTION_PROMPTS 키)과
// 공유된다. id를 추가/변경하면 Python도 함께 갱신할 것. 불일치는 smoke_test._check_emotions()가
// FAIL로 잡는다(색상/그룹/한글 label은 UI 전용이라 Python과 무관). — L-3

export interface Emotion {
  id: string
  label: string
  color: string
}

export interface EmotionGroup {
  name: string
  emotions: Emotion[]
}

export const EMOTION_GROUPS: EmotionGroup[] = [
  {
    name: '기본',
    emotions: [
      { id: 'default', label: '기본', color: 'var(--text-secondary)' },
      { id: 'narration', label: '나레이션', color: '#cbd5e1' },
      { id: 'polite', label: '공손', color: '#2dd4bf' },
      { id: 'serious', label: '진지', color: '#94a3b8' },
      { id: 'confident', label: '자신감', color: '#38bdf8' },
    ]
  },
  {
    name: '긍정',
    emotions: [
      { id: 'happy', label: '기쁨', color: '#4ade80' },
      { id: 'cheerful', label: '명랑', color: '#fb923c' },
      { id: 'excited', label: '흥분', color: '#ff6b6b' },
      { id: 'proud', label: '득의', color: '#fde047' },
      { id: 'touched', label: '감동', color: '#f472b6' },
      { id: 'curious', label: '호기심', color: '#34d399' },
      { id: 'playful', label: '장난', color: '#facc15' },
      { id: 'admiring', label: '동경', color: '#c4b5fd' },
    ]
  },
  {
    name: '부정',
    emotions: [
      { id: 'sad', label: '슬픔', color: '#60a5fa' },
      { id: 'angry', label: '화남', color: '#f87171' },
      { id: 'annoyed', label: '짜증', color: '#fdba74' },
      { id: 'scared', label: '공포', color: '#a78bfa' },
      { id: 'jealous', label: '질투', color: '#d946ef' },
      { id: 'contempt', label: '경멸', color: '#9f1239' },
      { id: 'sarcastic', label: '냉소', color: '#e879f9' },
      { id: 'mocking', label: '비꼼', color: '#a855f7' },
      { id: 'cold', label: '냉정', color: '#64748b' },
    ]
  },
  {
    name: '불안/피로',
    emotions: [
      { id: 'worried', label: '걱정', color: '#f59e0b' },
      { id: 'nervous', label: '긴장', color: '#fda4af' },
      { id: 'restless', label: '초조', color: '#ef4444' },
      { id: 'flustered', label: '당황', color: '#fca5a5' },
      { id: 'tired', label: '피곤', color: '#78716c' },
      { id: 'bored', label: '지루함', color: '#d4d4d8' },
      { id: 'sighing', label: '한숨', color: '#a1a1aa' },
      { id: 'empty', label: '허탈', color: '#6b7280' },
      { id: 'resigned', label: '체념', color: '#9ca3af' },
    ]
  },
  {
    name: '부드러움',
    emotions: [
      { id: 'whisper', label: '속삭임', color: '#c084fc' },
      { id: 'comforting', label: '위로', color: '#86efac' },
      { id: 'tender', label: '다정', color: '#f9a8d4' },
      { id: 'shy', label: '부끄러움', color: '#f9a8d4' },
      { id: 'cute', label: '애교', color: '#fb7185' },
      { id: 'tearful', label: '울먹', color: '#7dd3fc' },
      { id: 'solemn', label: '비장', color: '#475569' },
      { id: 'surprise', label: '놀람', color: '#fbbf24' },
      { id: 'longing', label: '그리움', color: '#93c5fd' },
      { id: 'bittersweet', label: '애틋', color: '#db2777' },
    ]
  },
  {
    name: '로맨스',
    emotions: [
      { id: 'flutter', label: '설렘', color: '#ff6b9d' },
      { id: 'sweet', label: '달콤', color: '#f9a8d4' },
      { id: 'charming', label: '매력', color: '#ec4899' },
      { id: 'seductive', label: '유혹', color: '#be185d' },
      { id: 'intimate', label: '은밀', color: '#831843' },
      { id: 'aroused', label: '흥분(성적)', color: '#9f1239' },
      { id: 'moaning', label: '신음', color: '#701a75' },
      { id: 'climax', label: '절정', color: '#881337' },
      { id: 'ecstasy', label: '황홀', color: '#a21caf' },
    ]
  },
]

// 전체 평면 목록(참조 등록용).
export const ALL_EMOTIONS: Emotion[] = EMOTION_GROUPS.flatMap(g => g.emotions)

// 대사 태그 삽입에서 기본 노출할 '자주 쓰는' 감정(전체는 더보기). id는 Python과 공유되는 값 그대로.
export const FREQUENT_TAG_IDS = ['happy', 'sad', 'angry', 'surprise', 'whisper', 'cheerful', 'worried', 'shy']
export const FREQUENT_TAGS: Emotion[] = ALL_EMOTIONS.filter(e => FREQUENT_TAG_IDS.includes(e.id))

// 태그 문자열(한글 label 또는 영어 id) → emotionId. Python EMOTION_TAGS와 동형(한글 label + 영어 alias).
// 알 수 없는 태그는 Python `_parse_line`처럼 'default'로 귀결.
export const EMOTION_LABEL_TO_ID: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const e of ALL_EMOTIONS) {
    m[e.label] = e.id  // 한글 label
    m[e.id] = e.id     // 영어 id alias
  }
  return m
})()
// 하위호환 별칭(기존 내부 사용).
const LABEL_TO_ID = EMOTION_LABEL_TO_ID

// emotionId → 한글 label(태그 삽입 canonical 표기용). 없으면 id 그대로.
export const EMOTION_ID_TO_LABEL: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const e of ALL_EMOTIONS) if (!(e.id in m)) m[e.id] = e.label
  return m
})()

// 대사 텍스트에서 실제 사용된 emotionId 집합을 파싱.
// Python `_parse_line`(python/tts_worker.py): `^\[([^\]]+)\]\s*(.+)` — 줄 앞 [태그] + 본문.
// 태그만 있고 본문이 없는 줄은 Python에서 문장으로 취급되지 않으므로(정규식 (.+) 불충족) 사용으로 세지 않는다.
// 알 수 없는 태그(→default)와 'default'는 결과에서 제외(기본 참조가 담당, 감정 참조 게이팅 대상 아님).
export function parseUsedEmotionIds(text: string): Set<string> {
  const used = new Set<string>()
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = /^\[([^\]]+)\]\s*(.+)/.exec(line)
    if (!m) continue
    const tag = m[1].trim()
    const id = LABEL_TO_ID[tag] || 'default'
    if (id !== 'default') used.add(id)
  }
  return used
}

// 감정 참조 slot의 구조적 최소 형태(store EmotionRefState와 호환; store 의존 없이 재사용).
export interface EmotionRefSlotLike {
  source: string
  clip: string
  ready: boolean
  message?: string
}

export interface EmotionSendPlan {
  toSend: Record<string, string>  // 대사에 쓰인 ∩ 등록 ∩ 준비된 감정 → effective 경로(clip||source)
  blockedId: string | null        // 쓰인 ∩ 등록 ∩ 미준비 첫 감정(합성 차단 사유 생성용)
}

// 게이팅/전송 계획(계약 §5 불변식) — ProcessButton과 E2E가 공유하는 단일 판정 로직.
//  1) 미등록(slot 없음) 사용 감정 → 기본 참조 폴백(전송·차단 안 함).
//  2) 등록 + 준비 → effective(clip||source) 전송.
//  3) 등록 + 미준비 → blockedId(합성 차단, 전송 안 함).
//  4) 미사용 감정 → 등록 여부와 무관하게 전송·차단 대상 아님(used에 없으므로 자연 제외).
export function planEmotionRefs(text: string, refState: Record<string, EmotionRefSlotLike>): EmotionSendPlan {
  const used = parseUsedEmotionIds(text)
  const toSend: Record<string, string> = {}
  let blockedId: string | null = null
  for (const id of used) {
    const slot = refState[id]
    if (!slot) continue                                   // (1) 미등록 → 기본 폴백
    if (!slot.ready) { if (!blockedId) blockedId = id; continue }  // (3) 미준비 → 차단
    toSend[id] = slot.clip || slot.source                 // (2) 준비 → effective 전송
  }
  return { toSend, blockedId }
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 문법 연동: preview 파싱 브리지 + 감정/쉼 태그 삽입(순수·무손실). EmotionScriptEditor가 소비.
// 모든 offset은 textarea 네이티브 UTF-16 code unit(selectionStart/End)과 같은 좌표계. parser dual-offset과 별개.
// ⚠️ 대사 전문을 로그로 내보내지 않는다.
// ─────────────────────────────────────────────────────────────────────────────
// 값(parseTtsScript)이 아니라 '타입만' import한다 — 런타임 모듈 해석을 유발하지 않아(erased)
// 이 파일을 node --test에서 leaf로 로드 가능(shared env tsc는 bundler resolution으로 extensionless).
import type { TtsGrammarError } from '../../shared/ttsGrammar'

// 렌더러 감정 vocab(emotions.ts 단일 소스) 기반 resolver. parser 기본표는 이것의 거울(smoke/parity가 가드).
// EmotionScriptEditor는 parseTtsScript(shared)에 이 resolver를 주입해 preview를 만든다.
export function resolveEmotionId(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(EMOTION_LABEL_TO_ID, name) ? EMOTION_LABEL_TO_ID[name] : null
}

// emotionId → canonical 삽입 태그 문자열 `[label]`.
export function emotionTagText(emotionId: string): string {
  return '[' + (EMOTION_ID_TO_LABEL[emotionId] ?? emotionId) + ']'
}

export interface EditResult { ok: true; text: string; selStart: number; selEnd: number }
export interface EditError { ok: false; error: TtsGrammarError }
export type EditOutcome = EditResult | EditError

// 줄 경계(시작 index 포함, 끝 index=개행 전) 계산.
interface LineSpan { start: number; end: number; text: string }
function lineSpans(text: string): LineSpan[] {
  const spans: LineSpan[] = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      spans.push({ start, end: i, text: text.slice(start, i) })
      start = i + 1
    }
  }
  return spans
}

// 줄 선두의 감정 태그(선행 공백 허용)를 찾는다. 감정으로 resolve되는 단일 토큰만 인정.
// 반환: { tagStart, tagEnd }(줄 절대 index) 또는 null.
function leadingEmotionTag(text: string, line: LineSpan): { tagStart: number; tagEnd: number } | null {
  const m = /^(\s*)\[([^\]\n]*)\]/.exec(line.text)
  if (!m) return null
  const inner = m[2].trim()
  if (/\s/.test(inner)) return null            // 내부 공백 → 감정 태그 아님(리터럴)
  if (resolveEmotionId(inner) == null) return null
  const lead = m[1].length
  return { tagStart: line.start + lead, tagEnd: line.start + m[0].length }
}

// caret 바로 인접(앞/뒤)한 감정 태그를 찾는다(중복 방지 교체용). 반환 태그 절대 범위 또는 null.
function adjacentEmotionTag(text: string, caret: number): { tagStart: number; tagEnd: number } | null {
  // 태그 정규식으로 전 구간 스캔 후 caret이 [start,end] 경계에 걸치거나 내부면 채택.
  const re = /\[([^\]\n]*)\]/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(text)) != null) {
    const s = mm.index
    const e = mm.index + mm[0].length
    const inner = mm[1].trim()
    if (/\s/.test(inner) || resolveEmotionId(inner) == null) continue // 감정 태그만
    // caret이 태그 내부거나, 바로 앞(공백 없이) 또는 바로 뒤(공백 허용)면 인접으로 간주
    if (caret >= s && caret <= e) return { tagStart: s, tagEnd: e }
  }
  return null
}

/**
 * 감정 태그 삽입(대사 무손실). 계약 §3 + D-1.
 * - 선택 없음: caret 삽입, caret 인접 감정 태그는 교체(중복 방지), 무조건 줄 선두 삽입 금지.
 * - 선택 있음: 선택이 닿는 '비어 있지 않은 각 줄'의 선두 감정 태그 삽입/교체. 대사·인라인 후속 태그 보존.
 *   선택 텍스트를 태그로 대체하지 않음. 수정된 전체 범위를 다시 selection으로.
 */
export function insertEmotionTag(text: string, selStart: number, selEnd: number, emotionId: string): EditResult {
  const tag = emotionTagText(emotionId)
  const a = Math.max(0, Math.min(selStart, selEnd))
  const b = Math.max(0, Math.max(selStart, selEnd))

  if (a === b) {
    // ── 선택 없음: caret 삽입 / 인접 교체 ──
    const adj = adjacentEmotionTag(text, a)
    if (adj) {
      const next = text.slice(0, adj.tagStart) + tag + text.slice(adj.tagEnd)
      const caret = adj.tagStart + tag.length
      return { ok: true, text: next, selStart: caret, selEnd: caret }
    }
    const insert = tag + ' '
    const next = text.slice(0, a) + insert + text.slice(a)
    const caret = a + insert.length
    return { ok: true, text: next, selStart: caret, selEnd: caret }
  }

  // ── 선택 있음: 닿는 비어있지 않은 각 줄의 선두 태그 삽입/교체(뒤에서 앞으로 처리해 index 안정화) ──
  const spans = lineSpans(text)
  const touched = spans.filter((ln) => a <= ln.end && b >= ln.start && ln.text.trim() !== '')
  let out = text
  let firstStart = a
  let lastEnd = b
  const targets = touched.slice().reverse()
  for (const ln of targets) {
    const lead = leadingEmotionTag(out, ln)
    if (lead) {
      out = out.slice(0, lead.tagStart) + tag + out.slice(lead.tagEnd)
    } else {
      const wsMatch = /^\s*/.exec(ln.text)
      const insAt = ln.start + (wsMatch ? wsMatch[0].length : 0)
      out = out.slice(0, insAt) + tag + ' ' + out.slice(insAt)
    }
  }
  // 재선택: 첫 touched 줄 시작 ~ 마지막 touched 줄 끝(수정 반영). 간단히 전체 touched 범위로.
  if (touched.length > 0) {
    firstStart = touched[0].start
    // 마지막 줄 끝은 길이 변동분 반영이 복잡하므로 out에서 재계산.
    const newSpans = lineSpans(out)
    // touched 첫 줄 인덱스 기준으로 같은 줄 수만큼 끝을 잡는다.
    const startLineIdx = spans.indexOf(touched[0])
    const endLineIdx = spans.indexOf(touched[touched.length - 1])
    lastEnd = newSpans[Math.min(endLineIdx, newSpans.length - 1)].end
    firstStart = newSpans[Math.min(startLineIdx, newSpans.length - 1)].start
  }
  return { ok: true, text: out, selStart: firstStart, selEnd: lastEnd }
}

// 초 표기(canonical): 정수초는 N.0, 그 외는 최소 표기. 0.05→"0.05", 0.5→"0.5", 1.0→"1.0".
function formatPauseSeconds(ms: number): string {
  const s = ms / 1000
  return Number.isInteger(s) ? s.toFixed(1) : String(s)
}

const PAUSE_TAG_RE = /\[\s*(쉼|pause)\s+[^\]\n]*\]/g

// 삽입 지점 인접(공백 무시)에 기존 쉼 태그가 있는지.
function pauseAdjacent(text: string, pos: number): boolean {
  const before = text.slice(0, pos)
  if (/\[\s*(?:쉼|pause)\s+[^\]\n]*\]\s*$/.test(before)) return true
  const after = text.slice(pos)
  if (/^\s*\[\s*(?:쉼|pause)\s+[^\]\n]*\]/.test(after)) return true
  return false
}

/**
 * 쉼 태그 삽입(선택 텍스트 무손실). 계약 §4 + D-4.
 * - caret(또는 contracted selection end)에 canonical `[쉼 N]` 삽입.
 * - 0.05~5.0s 밖 → INVALID_PAUSE_TAG(조용한 clamp 금지). 인접 중복 → INVALID_PAUSE_TAG(합산·정규화 금지).
 * - 선택 텍스트를 삭제하지 않는다.
 */
export function insertPauseTag(text: string, selStart: number, selEnd: number, pauseMs: number): EditOutcome {
  const seconds = pauseMs / 1000
  if (!Number.isFinite(seconds) || seconds < 0.05 || seconds > 5.0) {
    return { ok: false, error: { code: 'INVALID_PAUSE_TAG', arg: String(seconds), reason: 'range' } }
  }
  const pos = Math.max(selStart, selEnd) // 선택 있으면 끝(contracted end), 없으면 caret
  if (pauseAdjacent(text, pos)) {
    return { ok: false, error: { code: 'INVALID_PAUSE_TAG', reason: 'adjacent_duplicate', uiOffsetUtf16: pos } }
  }
  const tag = '[쉼 ' + formatPauseSeconds(pauseMs) + ']'
  const next = text.slice(0, pos) + tag + text.slice(pos)
  const caret = pos + tag.length
  return { ok: true, text: next, selStart: caret, selEnd: caret }
}

// 미사용 경고 억제(정규식 상수 export 안 함 — 내부 전용). PAUSE_TAG_RE는 향후 하이라이트용.
void PAUSE_TAG_RE
