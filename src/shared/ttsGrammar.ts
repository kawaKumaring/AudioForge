// TTS 감정/쉼 문법 공용 계약 타입 (S1 scaffold). 공용 마감 표현 사이클 D 계약 기반.
// ⚠️ 이 파일은 '타입·계약 상수'만 정의한다. 실제 parser 구현·태그 삽입·overlay·runtime config 배선·합성 경로 변경은
//    포함하지 않는다(그건 Agent A/B 구현 단계). parser_version=2(legacy 단일 태그=암묵적 v1과 구분).

export const TTS_PARSER_VERSION = 3 as const

/**
 * 의미 기반 plan hash 입력의 스키마 버전. **파서 계약 버전과 다른 축이다.**
 *
 * `parser_version` 을 hash 입력에 그대로 넣으면 문법을 넓힐 때마다 기존 대본의 지문이
 * 달라진다. 그 지문이 renderer↔Python parity 기준이라, 의미가 하나도 안 바뀐 대본이
 * `PARSER_PARITY_MISMATCH` 로 막히게 된다. 그래서 "무엇을 해석할 수 있는가"(파서 계약)와
 * "이 대본이 무엇을 뜻하는가"(의미 hash)를 따로 센다.
 *
 * 이 값은 hash 입력의 구성이 바뀔 때만 올린다. 버전을 숨기는 것이 아니다 —
 * `parser_version=3` 은 plan·config·metadata·run bundle 에 그대로 나간다.
 */
export const SEMANTIC_PLAN_HASH_VERSION = 2 as const

// 구조화 오류 코드(문자열 prefix 추론 금지 — renderer/Python 공용 집합). 대사 전문·오디오 바이트는 payload에 넣지 않는다.
export const TTS_GRAMMAR_ERROR_CODES = [
  'UNKNOWN_TTS_TAG',        // control-tag 형식이나 알려진 감정/쉼이 아님 → 합성 차단(조용한 default 금지)
  'INVALID_PAUSE_TAG',      // [쉼 N] 범위(0.05~5.0s)·형식 위반·인접 중복 → 합성 차단(조용한 clamp 금지)
  'EMPTY_EMOTION_SEGMENT',  // spoken text 없는 감정 구간(연속 태그 등) → 합성 차단
  'PARSER_PARITY_MISMATCH', // renderer full sha256 ≠ Python 재파싱 → 모델 로딩 전 차단
  'INVALID_TTS_CONFIG',     // config 값 범위 밖(Python 권위 검증, 조용한 clamp 금지)
  'INVALID_SPEAKER_TAG',    // [화자] 이름 없음 / 허용 문자 밖 / 형식 위반 → 합성 차단
] as const
export type TtsGrammarErrorCode = typeof TTS_GRAMMAR_ERROR_CODES[number]

// 오류 payload(비민감): 코드 + 위치/식별자만. 대사 전문 금지.
export interface TtsGrammarError {
  code: TtsGrammarErrorCode
  /** control-tag id 또는 raw 이름(감정/쉼 식별용). 대사 전문 아님. */
  tag?: string
  /** 잘못된 pause 인자 원문(형식 오류 표시용). */
  arg?: string
  /** 세부 사유(예: 'adjacent_duplicate'). */
  reason?: string
  /** UI selection 정합용 UTF-16 code-unit offset. */
  uiOffsetUtf16?: number
}

// D-7 dual offset(혼용 금지): UI용 UTF-16 code-unit, 텍스트/Python용 Unicode code-point.
export interface DualOffset {
  uiStartUtf16: number
  uiEndUtf16: number
  textStartCodepoint: number
  textEndCodepoint: number
}

// 경계 타입(추가 계약 3 우선순위: explicitPause > lineSilenceGap > emotionBoundaryPause > internal). 합산하지 않고 하나만.
export type TransitionBoundaryType =
  | 'explicitPause'        // [쉼 N] — 자동 gap을 대체(합산 아님)
  | 'lineSilenceGap'       // 원 줄바꿈 경계의 silence_gap
  | 'emotionBoundaryPause' // 감정 변경 경계(immediate|pause 모드의 pause)
  | 'internal'             // 자동분할 내부 경계(gap 0)

export interface PauseBoundary {
  /** 정수 milliseconds(D-7: float 금지). */
  pauseMs: number
  boundaryType: TransitionBoundaryType
  offset: DualOffset
}

// 파싱된 감정 구간(태그 ~ 다음 태그/줄 끝). spoken_text는 control token 제거 후 실제 발화 텍스트.
export interface ParsedEmotionSegment {
  originalLineIndex: number
  /** null = 화자 지정 없음(기본 화자). 내부 stable id(정규화). */
  speakerId: string | null
  /** 사용자가 쓴 그대로의 표시 이름. id 와 역할이 다르다. */
  speakerLabel: string | null
  /** null = 선두 감정 태그 없음(기본 참조가 담당; used에 포함되지 않음). */
  emotionId: string | null
  spokenText: string
  offset: DualOffset
  /** 이 구간에 종속된 명시적 쉼(경계). */
  pauses: PauseBoundary[]
  /**
   * 이 구간 **앞의** 경계 타입(우선순위 하나만, 합산 아님). 파싱이 끝난 뒤 채워진다.
   * Python `tts_grammar` 는 segment 에 `boundary_type` 을 실어 보내는데 TS 쪽은 배열로만
   * 들고 있어 plan 을 만들 때 값이 비었다 — 같은 계획을 내야 하므로 여기에도 붙인다.
   */
  boundaryType?: TransitionBoundaryType
}

// full internal hash(무결성 비교용) vs metadata 표시용 sha8을 타입으로 구분(혼용 방지).
export type ParsedPlanFullSha256 = string & { readonly __brand: 'ParsedPlanFullSha256' } // 64 hex, 내부 parity 비교 전용
export type ParsedPlanSha8 = string & { readonly __brand: 'ParsedPlanSha8' }             // 8 hex, metadata/GUI 표시 전용

// 파싱 결과 요약(대사 전문 미포함 — metadata/parity용). hash 입력은 D-7 정의를 따른다.
export interface ParsedPlanSummary {
  parserVersion: typeof TTS_PARSER_VERSION
  segmentCount: number
  chunkCount: number
  explicitPauseCount: number
  totalPauseMs: number
  usedEmotionIds: string[]
  /** 대본에 등장한 화자 id(첫 등장 순서). 화자 표기가 없으면 빈 배열. */
  usedSpeakerIds: string[]
  /** metadata/GUI 표시용(8 hex). */
  planSha8: ParsedPlanSha8
}

// 전체 파싱 결과(renderer preview + Python 합성 권위 양측 공통 shape). renderer는 preview, 합성 권위는 Python.
export interface ParsedPlan {
  parserVersion: typeof TTS_PARSER_VERSION
  segments: ParsedEmotionSegment[]
  summary: ParsedPlanSummary
  /** 내부 parity 비교 전용 full sha256(config로만 전달, metadata엔 sha8만). */
  fullSha256: ParsedPlanFullSha256
}

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCTION parser 구현 (parser_version=2). Python `python/tts_grammar.py`와 동형(isomorphic).
// 위의 S1 타입/상수는 그대로 두고 아래에 실제 파서·정규화·해시를 채운다.
// ⚠️ 로그/오류 payload에 대사 전문을 넣지 않는다(case id·offset·code만).
// ─────────────────────────────────────────────────────────────────────────────

// 감정 label(한글)/id(영문) → emotionId. python/tts_worker.py EMOTION_TAGS의 거울.
// 단일 소스 드리프트 방지: (TS) emotions.ts EMOTION_LABEL_TO_ID와 동일해야 하고
// smoke_test._check_emotions()가 emotions.ts↔tts_worker를 잡는다. (Python) tts_grammar.py의
// 동일 표 + test_tts_grammar_parity가 tts_worker.py를 ast로 읽어 대조한다.
export const TTS_EMOTION_LABEL_TO_ID: Readonly<Record<string, string>> = Object.freeze({
  '기본': 'default', '기쁨': 'happy', '슬픔': 'sad', '화남': 'angry',
  '놀람': 'surprise', '속삭임': 'whisper', '진지': 'serious', '명랑': 'cheerful',
  '걱정': 'worried', '피곤': 'tired', '공손': 'polite', '냉소': 'sarcastic',
  '긴장': 'nervous', '부끄러움': 'shy', '자신감': 'confident', '위로': 'comforting',
  '흥분': 'excited', '공포': 'scared', '짜증': 'annoyed', '나레이션': 'narration',
  '그리움': 'longing', '질투': 'jealous', '감동': 'touched', '허탈': 'empty',
  '비꼼': 'mocking', '애교': 'cute', '냉정': 'cold', '다정': 'tender',
  '울먹': 'tearful', '한숨': 'sighing', '비장': 'solemn', '장난': 'playful',
  '경멸': 'contempt', '동경': 'admiring', '초조': 'restless', '체념': 'resigned',
  '호기심': 'curious', '지루함': 'bored', '당황': 'flustered', '득의': 'proud',
  '설렘': 'flutter', '유혹': 'seductive', '달콤': 'sweet', '은밀': 'intimate',
  '애틋': 'bittersweet', '매력': 'charming', '흥분(성적)': 'aroused',
  '절정': 'climax', '신음': 'moaning', '황홀': 'ecstasy',
  // English aliases (id = id)
  'happy': 'happy', 'sad': 'sad', 'angry': 'angry', 'surprise': 'surprise',
  'whisper': 'whisper', 'serious': 'serious', 'cheerful': 'cheerful',
  'worried': 'worried', 'tired': 'tired', 'polite': 'polite', 'sarcastic': 'sarcastic',
  'nervous': 'nervous', 'shy': 'shy', 'confident': 'confident', 'comforting': 'comforting',
  'excited': 'excited', 'scared': 'scared', 'annoyed': 'annoyed', 'narration': 'narration',
  'longing': 'longing', 'jealous': 'jealous', 'touched': 'touched', 'empty': 'empty',
  'mocking': 'mocking', 'cute': 'cute', 'cold': 'cold', 'tender': 'tender',
  'tearful': 'tearful', 'sighing': 'sighing', 'solemn': 'solemn', 'playful': 'playful',
  'contempt': 'contempt', 'admiring': 'admiring', 'restless': 'restless', 'resigned': 'resigned',
  'curious': 'curious', 'bored': 'bored', 'flustered': 'flustered', 'proud': 'proud',
  'flutter': 'flutter', 'seductive': 'seductive', 'sweet': 'sweet', 'intimate': 'intimate',
  'bittersweet': 'bittersweet', 'charming': 'charming', 'aroused': 'aroused',
  'climax': 'climax', 'moaning': 'moaning', 'ecstasy': 'ecstasy',
})

// 쉼 태그 별칭(둘 다 id는 'pause'). 범위 0.05~5.0초.
export const TTS_PAUSE_NAMES: ReadonlySet<string> = new Set(['쉼', 'pause'])
/** 화자 표기의 예약 접두어. 이 둘만 화자로 읽는다 — 다른 대괄호 표현을 화자로 오인하지 않는다. */
export const TTS_SPEAKER_NAMES: ReadonlySet<string> = new Set(['화자', 'speaker'])
/** 기본 화자로 돌아가는 이름. 앞의 화자 지정을 해제하고 기본 참조로 되돌린다. */
export const TTS_DEFAULT_SPEAKER_NAMES: ReadonlySet<string> = new Set(['기본', 'default'])
/** 화자 식별자에 허용하는 문자: 한국어 음절·영문·숫자·밑줄·붙임표. */
const SPEAKER_ID_RE = /^[0-9A-Za-z_\-\u3131-\u318E\uAC00-\uD7A3]+$/

/**
 * 표시 이름 → **내부 stable id**.
 *
 * 화면에 보이는 것은 사용자가 쓴 그대로(`speakerLabel`)이고, 계획·생성·기록이 쓰는 것은 이
 * 정규화된 id 다. `[speaker Minsu]` 와 `[speaker minsu]` 가 같은 사람이어야 하면서도 화면에는
 * 쓴 표기가 보여야 하기 때문이다. Python `normalize_speaker_id` 와 같은 결과여야 한다.
 */
export function normalizeSpeakerId(name: string): string {
  return (name ?? '').trim().normalize('NFC').toLowerCase()
}
export const TTS_PAUSE_MIN_SEC = 0.05
export const TTS_PAUSE_MAX_SEC = 5.0
// 'used'에서 제외되는 감정(기본 참조가 담당 — 감정 참조 게이팅 대상 아님).
export const TTS_NON_REFERENCE_EMOTION_IDS: ReadonlySet<string> = new Set(['default'])

export interface ParseOptions {
  /** name(label/id) → emotionId | null. 미지정 시 TTS_EMOTION_LABEL_TO_ID 기본. */
  resolveEmotion?: (name: string) => string | null
}

export interface ParseOk { ok: true; plan: ParsedPlan }
export interface ParseErr { ok: false; errors: TtsGrammarError[] }
export type ParseResult = ParseOk | ParseErr

function defaultResolveEmotion(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(TTS_EMOTION_LABEL_TO_ID, name)
    ? TTS_EMOTION_LABEL_TO_ID[name]
    : null
}

// ── 브래킷 내부 분류 ──
type BracketClass =
  | { type: 'emotion'; id: string; name: string }
  | { type: 'speaker'; id: string | null; name: string }
  | { type: 'speakerInvalid'; arg: string; reason: string }
  | { type: 'pause'; seconds: number; ms: number; arg: string }
  | { type: 'pauseInvalid'; arg: string; reason: string }
  | { type: 'unknown'; name: string }
  | { type: 'literalize' }

const PAUSE_ARG_RE = /^[0-9]+(\.[0-9]+)?$/

function validatePauseArg(arg: string): BracketClass {
  if (!PAUSE_ARG_RE.test(arg)) return { type: 'pauseInvalid', arg, reason: 'format' }
  const sec = Number.parseFloat(arg)
  if (!Number.isFinite(sec)) return { type: 'pauseInvalid', arg, reason: 'format' }
  if (sec < TTS_PAUSE_MIN_SEC || sec > TTS_PAUSE_MAX_SEC) return { type: 'pauseInvalid', arg, reason: 'range' }
  const ms = Math.round(sec * 1000)
  return { type: 'pause', seconds: sec, ms, arg }
}

function classifyBracket(inner: string, resolveEmotion: (n: string) => string | null): BracketClass {
  const t = inner.trim()
  if (t === '') return { type: 'literalize' } // 빈 [] → 리터럴
  const parts = t.split(/\s+/)
  if (parts.length === 1) {
    const name = parts[0]
    const eid = resolveEmotion(name)
    if (eid != null) return { type: 'emotion', id: eid, name }
    if (TTS_PAUSE_NAMES.has(name)) return { type: 'pauseInvalid', arg: '', reason: 'missing_arg' }
    // 이름이 없는 `[화자]` 는 조용히 지나가지 않는다 — 무엇을 뜻하는지 알 수 없다.
    if (TTS_SPEAKER_NAMES.has(name)) return { type: 'speakerInvalid', arg: '', reason: 'missing_name' }
    return { type: 'unknown', name }
  }
  if (TTS_SPEAKER_NAMES.has(parts[0])) {
    if (parts.length !== 2) {
      return { type: 'speakerInvalid', arg: parts.slice(1).join(' '), reason: 'format' }
    }
    const raw = parts[1]
    if (TTS_DEFAULT_SPEAKER_NAMES.has(raw)) return { type: 'speaker', id: null, name: raw }
    if (!SPEAKER_ID_RE.test(raw)) return { type: 'speakerInvalid', arg: raw, reason: 'charset' }
    return { type: 'speaker', id: normalizeSpeakerId(raw), name: raw }
  }
  if (TTS_PAUSE_NAMES.has(parts[0])) {
    // 쉼/pause + 인자. 인자가 정확히 하나가 아니면 형식 오류.
    if (parts.length !== 2) return { type: 'pauseInvalid', arg: parts.slice(1).join(' '), reason: 'format' }
    return validatePauseArg(parts[1])
  }
  // 첫 토큰이 쉼/pause가 아닌데 내부 공백 존재(예: [기쁨 안녕하세요]) → control-tag 아님 → 리터럴.
  return { type: 'literalize' }
}

// ── 오프셋 추적(dual): UTF-16 code unit + Unicode code point. ──
interface Pos { u16: number; cp: number }

type Piece =
  | { kind: 'lit'; text: string; start: Pos; end: Pos; lineIndex: number }
  | { kind: 'emotion'; id: string; name: string; start: Pos; end: Pos; lineIndex: number }
  | { kind: 'pause'; ms: number; seconds: number; start: Pos; end: Pos; lineIndex: number }
  | { kind: 'speaker'; id: string | null; name: string; start: Pos; end: Pos; lineIndex: number }
  | { kind: 'speakerInvalid'; arg: string; reason: string; start: Pos; end: Pos; lineIndex: number }
  | { kind: 'pauseInvalid'; arg: string; reason: string; start: Pos; end: Pos; lineIndex: number }
  | { kind: 'unknown'; name: string; start: Pos; end: Pos; lineIndex: number }
  | { kind: 'linebreak'; start: Pos; end: Pos; lineIndex: number }

function u16len(s: string): number {
  return s.length // JS string length = UTF-16 code unit 수
}

/** 닫히지 않은 `[` 의 위치(원문 좌표). 파서는 이것을 리터럴로 다루므로 오류가 아니다. */
export interface UnclosedTagOffset {
  uiOffsetUtf16: number
  textOffsetCodepoint: number
  lineIndex: number
}

// 원문을 code point 단위로 순회하며 pieces 생성(전역 offset 부착).
// `unclosedOut` 을 주면 닫히지 않은 `[` 위치를 담는다 — 브래킷 규칙은 여기 한 곳에만 둔다.
function tokenize(
  raw: string,
  resolveEmotion: (n: string) => string | null,
  unclosedOut?: UnclosedTagOffset[],
): Piece[] {
  const chars = Array.from(raw) // code point 배열
  const pieces: Piece[] = []
  let i = 0
  let u16 = 0
  let cp = 0
  let lineIndex = 0
  // 진행 중 literal 버퍼(연속 literal 병합) — 실제 텍스트 + 시작 위치
  let litText = ''
  let litStart: Pos | null = null

  const here = (): Pos => ({ u16, cp })
  const advance = (ch: string): void => { u16 += u16len(ch); cp += 1 }

  const flushLit = (): void => {
    if (litStart != null) {
      pieces.push({ kind: 'lit', text: litText, start: litStart, end: here(), lineIndex })
    }
    litText = ''
    litStart = null
  }
  const appendLit = (ch: string): void => {
    if (litStart == null) litStart = here()
    litText += ch
    advance(ch)
  }

  while (i < chars.length) {
    const c = chars[i]
    if (c === '\n') {
      flushLit()
      const s = here()
      advance(c)
      pieces.push({ kind: 'linebreak', start: s, end: here(), lineIndex })
      lineIndex += 1
      i += 1
      continue
    }
    if (c === '\\') {
      const next = chars[i + 1]
      if (next === '\\') {                     // \\ → literal backslash 하나
        appendLit('\\'); advance('\\'); i += 2; continue
      }
      if (next === '[' || next === ']') {       // \[ \] → literal bracket
        appendLit(next); advance('\\'); i += 2; continue
      }
      // \x (기타) → backslash 자체를 literal로 두고 다음 문자 정상 처리
      appendLit('\\'); i += 1; continue
    }
    if (c === '[') {
      // 매칭되는 unescaped ']' 탐색(중첩 '[' 만나면 malformed로 중단)
      let j = i + 1
      let inner = ''
      let close = -1
      // 브래킷 시작 위치 기억(전역 offset)
      const openStart = here()
      // 내부 스캔은 offset을 별도 계산하지 않고 문자만 수집(escape 해석)
      while (j < chars.length) {
        const cj = chars[j]
        if (cj === '\\' && (chars[j + 1] === '[' || chars[j + 1] === ']' || chars[j + 1] === '\\')) {
          inner += chars[j + 1]; j += 2; continue
        }
        if (cj === ']') { close = j; break }
        if (cj === '[') break // 중첩 open → malformed
        if (cj === '\n') break // 줄 안에서 안 닫힘 → malformed
        inner += cj; j += 1
      }
      if (close === -1) {
        // 안 닫힘 → '[' 리터럴. 사용자가 태그를 의도했을 수 있으니 위치만 알린다.
        if (unclosedOut != null) {
          unclosedOut.push({ uiOffsetUtf16: u16, textOffsetCodepoint: cp, lineIndex })
        }
        appendLit('['); i += 1; continue
      }
      const cls = classifyBracket(inner, resolveEmotion)
      if (cls.type === 'literalize') {
        // '[' + inner + ']' 전체를 리터럴 텍스트로. (escape는 inner 수집 시 이미 해석됨)
        flushLit()
        // 리터럴 조각으로 직접 push(위치는 open..close+1)
        const litPieceStart = openStart
        // 위치 진행: i..close 까지 소비
        for (let k = i; k <= close; k++) advance(chars[k])
        pieces.push({ kind: 'lit', text: '[' + inner + ']', start: litPieceStart, end: here(), lineIndex })
        i = close + 1
        continue
      }
      flushLit()
      const startPos = openStart
      for (let k = i; k <= close; k++) advance(chars[k])
      const endPos = here()
      if (cls.type === 'emotion') {
        pieces.push({ kind: 'emotion', id: cls.id, name: cls.name, start: startPos, end: endPos, lineIndex })
      } else if (cls.type === 'pause') {
        pieces.push({ kind: 'pause', ms: cls.ms, seconds: cls.seconds, start: startPos, end: endPos, lineIndex })
      } else if (cls.type === 'speaker') {
        pieces.push({ kind: 'speaker', id: cls.id, name: cls.name, start: startPos, end: endPos, lineIndex })
      } else if (cls.type === 'speakerInvalid') {
        pieces.push({ kind: 'speakerInvalid', arg: cls.arg, reason: cls.reason, start: startPos, end: endPos, lineIndex })
      } else if (cls.type === 'pauseInvalid') {
        pieces.push({ kind: 'pauseInvalid', arg: cls.arg, reason: cls.reason, start: startPos, end: endPos, lineIndex })
      } else {
        pieces.push({ kind: 'unknown', name: cls.name, start: startPos, end: endPos, lineIndex })
      }
      i = close + 1
      continue
    }
    // 일반 문자
    appendLit(c)
    i += 1
  }
  flushLit()
  return pieces
}

// 왼쪽 공백만 제거(구분 공백 소거). 오른쪽/내부 공백은 보존.
function lstrip(s: string): string {
  return s.replace(/^\s+/, '')
}

interface OpenSeg {
  speakerId: string | null
  speakerLabel: string | null
  emotionId: string | null
  emotionName: string | null // EMPTY 오류 tag용
  parts: string[]
  start: Pos | null
  end: Pos | null
  lineIndex: number
  leadingPauseMs: number | null
  leadingPauseSec: number | null
}

/**
 * raw ttsText → ParseResult(parser_version=2). Python tts_grammar.parse_tts_script와 동형.
 * 성공: 정규화 segments + summary + fullSha256. 실패: 구조화 오류(대사 전문 없음).
 */
// ── 줄 끝 정규화(공용 parser 입력 경계) ─────────────────────────────────────
// Windows 에서 붙여넣은 CRLF 의 CR 이 spoken text 에 남으면 tokenizer 결과·chunk 계획·
// 실제 발화·시간 예측이 LF 입력과 갈라진다(실측). 그래서 **파서 입구에서** 정규화한다.
// 사용자가 입력한 원문은 건드리지 않는다 — 밖으로 나가는 offset 은 map 으로 원문 좌표로
// 되돌린다. Python 쪽 `tts_grammar.normalize_line_endings` 와 같은 규칙이다.

export interface LineEndingNormalization {
  text: string
  /** 정규화본 UTF-16 index -> 원문 UTF-16 index. 끝 경계까지 담아 길이가 하나 더 길다. */
  u16Map: number[]
  /** 정규화본 code point index -> 원문 code point index. */
  cpMap: number[]
  changed: boolean
}

export function normalizeLineEndings(raw: string): LineEndingNormalization {
  const src = raw ?? ''
  const out: string[] = []
  const u16Map: number[] = []
  const cpMap: number[] = []
  let su16 = 0
  let cpIndex = 0
  const cps = Array.from(src)
  for (let i = 0; i < cps.length; i += 1) {
    const ch = cps[i]
    if (ch === '\r') {
      cpMap.push(cpIndex)
      u16Map.push(su16)
      out.push('\n')
      if (i + 1 < cps.length && cps[i + 1] === '\n') {
        su16 += 2
        cpIndex += 2
        i += 1
      } else {
        su16 += 1
        cpIndex += 1
      }
      continue
    }
    cpMap.push(cpIndex)
    const w = ch.length
    for (let k = 0; k < w; k += 1) u16Map.push(su16 + k)
    out.push(ch)
    su16 += w
    cpIndex += 1
  }
  cpMap.push(cpIndex)
  u16Map.push(su16)
  const text = out.join('')
  return { text, u16Map, cpMap, changed: text !== src }
}

function mapIndex(map: number[], value: number | undefined): number | undefined {
  if (value === undefined || value === null || value < 0) return value
  return value < map.length ? map[value] : map[map.length - 1]
}

/**
 * 닫히지 않은 `[` 의 **원문 좌표** 목록.
 *
 * 파서는 이것을 리터럴로 삼아 계속 진행한다(오류가 아니다). 그래서 `[기쁨` 처럼 쓴 줄은
 * 조용히 대사 안에 대괄호가 남는다. 사전 경고가 그 사실을 말해야 하므로 위치를 따로 낸다.
 * 합성을 막지도, 원문을 고치지도 않는다.
 */
export function unclosedTagOffsets(raw: string, opts?: ParseOptions): UnclosedTagOffset[] {
  const resolveEmotion = opts?.resolveEmotion ?? defaultResolveEmotion
  const norm = normalizeLineEndings(raw ?? '')
  const found: UnclosedTagOffset[] = []
  tokenize(norm.text, resolveEmotion, found)
  if (!norm.changed) return found
  return found.map((o) => ({
    uiOffsetUtf16: mapIndex(norm.u16Map, o.uiOffsetUtf16) as number,
    textOffsetCodepoint: mapIndex(norm.cpMap, o.textOffsetCodepoint) as number,
    lineIndex: o.lineIndex,
  }))
}

export function parseTtsScript(raw: string, opts?: ParseOptions): ParseResult {
  const resolveEmotion = opts?.resolveEmotion ?? defaultResolveEmotion
  // 파서 입력 경계에서만 정규화한다. 원문 문자열 자체는 어디서도 바꾸지 않는다.
  const norm = normalizeLineEndings(raw ?? '')
  const text = norm.text
  const pieces = tokenize(text, resolveEmotion)
  const errors: TtsGrammarError[] = []

  const segments: ParsedEmotionSegment[] = []
  let open: OpenSeg | null = null
  let pendingPauseMs: number | null = null
  let pendingPauseSec: number | null = null
  let stripNextWS = false
  // 활성 감정(줄 안에서 쉼 경계를 넘어 유지, 줄바꿈에서 리셋 — 줄별 독립 감정).
  let curEmotion: string | null = null
  let curEmotionName: string | null = null
  // 활성 화자. **줄바꿈에서 리셋하지 않는다** — 다음 화자 표기까지 유지된다(v1.4 확정).
  // 감정과 다른 축이다: 하나는 인물이 누구인가, 다른 하나는 그 줄을 어떻게 말하는가.
  let curSpeaker: string | null = null
  let curSpeakerLabel: string | null = null

  const newOpen = (lineIndex: number, start: Pos | null): OpenSeg => {
    const o: OpenSeg = {
      speakerId: curSpeaker, speakerLabel: curSpeakerLabel,
      emotionId: curEmotion, emotionName: curEmotionName, parts: [], start, end: start, lineIndex,
      leadingPauseMs: pendingPauseMs, leadingPauseSec: pendingPauseSec,
    }
    pendingPauseMs = null   // 대기 중 쉼은 이 구간에 귀속(1회 소비)
    pendingPauseSec = null
    return o
  }

  const spokenOf = (o: OpenSeg): string => o.parts.join('')

  const flushOpen = (): void => {
    if (open == null) return
    const spoken = spokenOf(open)
    if (open.emotionId != null && spoken === '') {
      // 감정 태그는 있는데 발화 텍스트가 없음 → 오류
      errors.push({ code: 'EMPTY_EMOTION_SEGMENT', tag: open.emotionName ?? undefined, uiOffsetUtf16: open.start?.u16 })
      open = null
      return
    }
    if (spoken === '' && open.emotionId == null && open.leadingPauseMs == null) {
      open = null // 빈 null 구간(빈 줄 등) → 버림
      return
    }
    const start = open.start ?? { u16: 0, cp: 0 }
    const end = open.end ?? start
    const pauses: PauseBoundary[] = []
    if (open.leadingPauseMs != null) {
      pauses.push({
        pauseMs: open.leadingPauseMs,
        boundaryType: 'explicitPause',
        offset: { uiStartUtf16: start.u16, uiEndUtf16: start.u16, textStartCodepoint: start.cp, textEndCodepoint: start.cp },
      })
    }
    segments.push({
      originalLineIndex: open.lineIndex,
      // 내부 stable id 와 화면 표시 이름을 나눠 싣는다(id 는 정규화, label 은 쓴 그대로).
      speakerId: open.speakerId,
      speakerLabel: open.speakerLabel,
      emotionId: open.emotionId,
      spokenText: spoken,
      offset: { uiStartUtf16: start.u16, uiEndUtf16: end.u16, textStartCodepoint: start.cp, textEndCodepoint: end.cp },
      pauses,
    })
    open = null
  }

  for (const p of pieces) {
    if (p.kind === 'unknown') {
      errors.push({ code: 'UNKNOWN_TTS_TAG', tag: p.name, uiOffsetUtf16: p.start.u16 })
      // unknown은 합성 차단이므로 segment 조립은 계속하되 결과는 오류로 반환된다.
      continue
    }
    if (p.kind === 'pauseInvalid') {
      errors.push({ code: 'INVALID_PAUSE_TAG', arg: p.arg, reason: p.reason, uiOffsetUtf16: p.start.u16 })
      continue
    }
    if (p.kind === 'lit') {
      if (open == null) open = newOpen(p.lineIndex, p.start)
      if (open.start == null) { open.start = p.start }
      let t = p.text
      if (stripNextWS) { t = lstrip(t); stripNextWS = false }
      open.parts.push(t)
      open.end = p.end
      continue
    }
    if (p.kind === 'speakerInvalid') {
      // 해석하지 못한 화자 표기는 **이전 화자를 바꾸지 않는다.** 오류로만 남는다.
      errors.push({ code: 'INVALID_SPEAKER_TAG', arg: p.arg, reason: p.reason, uiOffsetUtf16: p.start.u16 })
      continue
    }
    if (p.kind === 'speaker') {
      // 화자 표기는 **항상 앞의 말을 닫는다**(감정 태그와 다르다). 감정은 앞에 감정이 없던
      // 구간에 소급 적용되지만, 화자는 그럴 수 없다 — 태그 앞의 말은 그 사람이 한 말이 아니다.
      flushOpen()
      curSpeaker = p.id
      curSpeakerLabel = p.id == null ? null : p.name
      stripNextWS = true
      continue
    }
    if (p.kind === 'emotion') {
      curEmotion = p.id
      curEmotionName = p.name
      if (open != null && open.emotionId != null) {
        // 이미 감정이 배정된 구간 진행 중 → 새 감정 = 새 구간
        flushOpen()
        open = newOpen(p.lineIndex, p.start)
      } else if (open != null && open.emotionId == null) {
        // 선두 literal(감정 미배정) → 이 감정이 back-fill(선두 감정이 앞 텍스트 지배). start 유지.
        open.emotionId = p.id
        open.emotionName = p.name
      } else {
        open = newOpen(p.lineIndex, p.start)
      }
      open.end = p.end
      stripNextWS = true
      continue
    }
    if (p.kind === 'pause') {
      // 현재 open을 닫고(내용 있으면 segment), pending pause 설정.
      if (open != null) flushOpen()
      if (pendingPauseMs != null) {
        errors.push({ code: 'INVALID_PAUSE_TAG', reason: 'adjacent_duplicate', uiOffsetUtf16: p.start.u16 })
      } else {
        pendingPauseMs = p.ms
        pendingPauseSec = p.seconds
      }
      stripNextWS = true
      continue
    }
    if (p.kind === 'linebreak') {
      flushOpen()
      stripNextWS = false
      curEmotion = null      // 줄별 독립 감정(legacy _parse_line 동형)
      curEmotionName = null
      // curSpeaker 는 그대로 둔다 — 화자는 다음 화자 표기까지 유지된다.
      continue
    }
  }
  flushOpen()

  if (errors.length > 0) {
    // 성공 경로와 같은 계약: 밖으로 나가는 좌표는 언제나 원문 기준이다.
    // (전에는 실패 경로만 정규화 좌표로 나가 CRLF 입력에서 위치가 어긋났다.)
    if (norm.changed) {
      for (const e of errors) {
        if (e.uiOffsetUtf16 !== undefined) e.uiOffsetUtf16 = mapIndex(norm.u16Map, e.uiOffsetUtf16)
      }
    }
    return { ok: false, errors }
  }

  // 경계 타입 부여(추가계약3 우선순위, 합산 금지). segment[0]은 선행 경계 없음.
  const boundaryTypes: TransitionBoundaryType[] = []
  for (let idx = 0; idx < segments.length; idx++) {
    const s = segments[idx]
    let bt: TransitionBoundaryType
    if (idx === 0) {
      bt = 'internal'
    } else if (s.pauses.some((x) => x.boundaryType === 'explicitPause')) {
      bt = 'explicitPause'
    } else if (s.originalLineIndex > segments[idx - 1].originalLineIndex) {
      bt = 'lineSilenceGap'
    } else if (s.emotionId !== segments[idx - 1].emotionId) {
      bt = 'emotionBoundaryPause'
    } else {
      bt = 'internal'
    }
    boundaryTypes.push(bt)
    s.boundaryType = bt
  }

  // used emotion ids(첫 등장 순서, default/null 제외)
  const usedEmotionIds: string[] = []
  const seen = new Set<string>()
  for (const s of segments) {
    if (s.emotionId != null && !TTS_NON_REFERENCE_EMOTION_IDS.has(s.emotionId) && !seen.has(s.emotionId)) {
      seen.add(s.emotionId)
      usedEmotionIds.push(s.emotionId)
    }
  }

  const usedSpeakerIds: string[] = []
  const seenSpeakers = new Set<string>()
  for (const seg of segments) {
    const sid = seg.speakerId
    if (sid != null && !seenSpeakers.has(sid)) { seenSpeakers.add(sid); usedSpeakerIds.push(sid) }
  }

  let explicitPauseCount = 0
  let totalPauseMs = 0
  for (const s of segments) {
    for (const b of s.pauses) {
      if (b.boundaryType === 'explicitPause') { explicitPauseCount += 1; totalPauseMs += b.pauseMs }
    }
  }

  if (norm.changed) {
    // spoken text·plan sha 는 정규화본 기준이라 LF 와 CRLF 가 같은 계획을 만든다.
    // 밖으로 나가는 좌표만 원문으로 되돌린다.
    for (const seg of segments) {
      seg.offset = {
        uiStartUtf16: mapIndex(norm.u16Map, seg.offset.uiStartUtf16) as number,
        uiEndUtf16: mapIndex(norm.u16Map, seg.offset.uiEndUtf16) as number,
        textStartCodepoint: mapIndex(norm.cpMap, seg.offset.textStartCodepoint) as number,
        textEndCodepoint: mapIndex(norm.cpMap, seg.offset.textEndCodepoint) as number,
      }
      for (const b of seg.pauses ?? []) {
        b.offset = {
          uiStartUtf16: mapIndex(norm.u16Map, b.offset.uiStartUtf16) as number,
          uiEndUtf16: mapIndex(norm.u16Map, b.offset.uiEndUtf16) as number,
          textStartCodepoint: mapIndex(norm.cpMap, b.offset.textStartCodepoint) as number,
          textEndCodepoint: mapIndex(norm.cpMap, b.offset.textEndCodepoint) as number,
        }
      }
    }
    for (const e of errors) {
      if (e.uiOffsetUtf16 !== undefined) e.uiOffsetUtf16 = mapIndex(norm.u16Map, e.uiOffsetUtf16)
    }
  }
  const fullSha256 = computePlanFullSha256(segments, boundaryTypes)
  const planSha8 = fullSha256.slice(0, 8) as ParsedPlanSha8

  const summary: ParsedPlanSummary = {
    parserVersion: TTS_PARSER_VERSION,
    segmentCount: segments.length,
    chunkCount: segments.length, // 파싱 단계 chunk = segment(실제 autosplit는 Python 합성 단계)
    explicitPauseCount,
    totalPauseMs,
    usedEmotionIds,
    usedSpeakerIds,
    planSha8,
  }
  const plan: ParsedPlan = {
    parserVersion: TTS_PARSER_VERSION,
    segments,
    summary,
    fullSha256: fullSha256 as ParsedPlanFullSha256,
  }
  return { ok: true, plan }
}

// segment[i]의 선행 경계 타입 조회 헬퍼(경계 우선순위 테스트/UI용). 첫 줄→해당 줄 첫 segment 기준.
export function lineBoundaryType(plan: ParsedPlan, lineIndexA: number, lineIndexB: number): TransitionBoundaryType | null {
  const idxB = plan.segments.findIndex((s) => s.originalLineIndex === lineIndexB)
  if (idxB <= 0) return null
  const prev = plan.segments[idxB - 1]
  if (prev.originalLineIndex !== lineIndexA) return null
  const s = plan.segments[idxB]
  if (s.pauses.some((x) => x.boundaryType === 'explicitPause')) return 'explicitPause'
  if (s.originalLineIndex > prev.originalLineIndex) return 'lineSilenceGap'
  if (s.emotionId !== prev.emotionId) return 'emotionBoundaryPause'
  return 'internal'
}

// ── canonical 직렬화 + 해시(D-7). TS/Python 동일 알고리즘. ──
// 규칙: object는 key 알파벳 정렬, 배열 순서 유지, 공백 없음, string은 JSON escape(ascii), int만(float 금지), null=null.
type CanonValue = string | number | boolean | null | CanonValue[] | { [k: string]: CanonValue }

function canonicalize(v: CanonValue): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('canonical: float 금지')
    return String(v)
  }
  if (typeof v === 'string') return jsonEscape(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map((k) => jsonEscape(k) + ':' + canonicalize(v[k])).join(',') + '}'
}

function jsonEscape(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0) as number
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0')
    else out += ch
  }
  return out + '"'
}

/**
 * 구조 해시용 결정적 직렬화. Python `tts_grammar.canonical_json` 과 같은 문자열이어야 한다.
 *
 * plan hash 를 이 파일 밖(예: scriptPlan)에서 계산할 때 알고리즘을 다시 쓰지 않게 공개한다 —
 * 직렬화가 두 곳에 있으면 언젠가 갈라진다.
 */
export function canonicalJson(value: CanonValue): string {
  return canonicalize(value)
}

export type { CanonValue }

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

/**
 * 대본이 **무엇을 뜻하는가**의 지문. 파서 계약 버전은 여기 들어가지 않는다.
 *
 * 1. `parser_version` 대신 `SEMANTIC_PLAN_HASH_VERSION` 을 쓴다 — 문법을 넓혀 파서 버전이
 *    올라가도 의미가 같은 대본의 지문은 그대로여야 한다.
 * 2. 화자는 **화자 표기가 실제로 있는 대본에서만** 입력에 들어간다. 그래서 v1.3.0 대본의
 *    지문은 한 바이트도 달라지지 않는다. 화자가 하나라도 있으면 모든 segment 에 키가 붙는다.
 */
function computePlanFullSha256(segments: ParsedEmotionSegment[], boundaryTypes: TransitionBoundaryType[]): string {
  const hasSpeaker = segments.some((s) => s.speakerId != null)
  const canonSegments: CanonValue[] = segments.map((s, i) => {
    let pauseMs = 0
    for (const b of s.pauses) if (b.boundaryType === 'explicitPause') pauseMs = b.pauseMs
    const bytes = utf8Bytes(s.spokenText)
    const row: { [k: string]: CanonValue } = {
      boundary: boundaryTypes[i],
      emotion_id: s.emotionId,
      i,
      line_index: s.originalLineIndex,
      pause_ms: pauseMs,
      text_bytes: bytes.length,
      text_sha256: sha256Hex(bytes),
    }
    // 표시 이름은 넣지 않는다 — 같은 사람을 다르게 적었을 뿐이면 의미는 같다.
    if (hasSpeaker) row.speaker_id = s.speakerId
    return row
  })
  const canonObj: CanonValue = {
    parser_version: SEMANTIC_PLAN_HASH_VERSION,
    segment_count: segments.length,
    segments: canonSegments,
  }
  return sha256Hex(utf8Bytes(canonicalize(canonObj)))
}

// 순수 JS SHA-256(브라우저·node 동일, 의존성 없음). 입력 Uint8Array → hex 64자.
export function sha256Hex(input: Uint8Array): string {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])

  const l = input.length
  const bitLen = l * 8
  // padding: 0x80, zeros, 64-bit big-endian length. 512-bit(64B) 블록 정렬.
  const withOne = l + 1
  const k = (56 - (withOne % 64) + 64) % 64
  const total = withOne + k + 8
  const msg = new Uint8Array(total)
  msg.set(input, 0)
  msg[l] = 0x80
  // 길이(비트) big-endian 64bit — 상위 32bit는 대개 0(입력 < 512MB)
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  msg[total - 8] = (hi >>> 24) & 0xff
  msg[total - 7] = (hi >>> 16) & 0xff
  msg[total - 6] = (hi >>> 8) & 0xff
  msg[total - 5] = hi & 0xff
  msg[total - 4] = (lo >>> 24) & 0xff
  msg[total - 3] = (lo >>> 16) & 0xff
  msg[total - 2] = (lo >>> 8) & 0xff
  msg[total - 1] = lo & 0xff

  const w = new Uint32Array(64)
  const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0

  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) {
      const j = off + t * 4
      w[t] = ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) >>> 0
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + temp1) >>> 0
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  let hex = ''
  for (let idx = 0; idx < 8; idx++) hex += H[idx].toString(16).padStart(8, '0')
  return hex
}

// 편의: 문자열 → sha256 hex.
export function sha256HexOfString(s: string): string {
  return sha256Hex(utf8Bytes(s))
}
