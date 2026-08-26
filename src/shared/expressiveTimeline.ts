// 표현형 운율(expressive prosody) LANGUAGE 계약 — AST/타입 정의 + 순수 파서.
//
// ⚠️ 하위호환 불변식(최우선):
//   이 모듈은 v2 계획(ttsGrammar.parseTtsScript)의 출력·해시를 '전혀' 건드리지 않는다.
//   TTS_PARSER_VERSION 은 2 로 남고, computePlanFullSha256 의 canonical 입력도 그대로다.
//   따라서 오늘 합성되는 모든 스크립트는 오늘과 완전히 동일한 full sha256 을 만들고,
//   separate.py 의 PARSER_PARITY_MISMATCH 게이트는 이 변경으로 새로 실패할 수 없다.
//   이 파일은 '추가(additive)' 레이어이며, 아직 어떤 합성 경로도 호출하지 않는다(dormant).
//
// ⚠️ 버전 선택 규칙(계약 정정):
//   표현형 모드는 '명시적으로 선택'된다. 본문 내용은 절대 버전을 고르지 않는다.
//   - 옵션 없이 호출하면 EXPRESSIVE_DEFAULT_MODE = 'legacy_v2'.
//   - legacy_v2 에서는 '.', '...', '!?', '~', '[ㅋㅋ]' 가 오늘과 똑같이 취급된다
//     (운율/웃음 이벤트를 만들지 않는다. 문장부호는 리터럴 텍스트, 웃음 대괄호는 UNKNOWN 태그).
//   - 즉 본문에 표현형 토큰이 들어 있어도 legacy 세션은 자동으로 v3 로 넘어가지 않는다.
//
// 사용자 의도(계약의 근거):
//   1) 감정 태그는 "여기서 새 WAV 를 시작하라"가 아니다. 한 사람이 계속 말하는 도중
//      감정이 자연스럽게 바뀌는 '전이 지점'이다. → 기본 blend, 추가 pause 0, chunk 경계 아님.
//   2) 문장부호는 문장 분할자가 아니다. 마지막 몇 음절에 걸리는 'LOCAL 운율 명령'이다.
//      → localProsody 는 절대 chunk 경계를 만들지 않는다. 홑점('.')은 '중립 종결'일 뿐이며
//        '...' 이나 '!' 보다 뚜렷하게 약하다(과장 금지).
//   3) 대괄호 웃음은 읽어야 할 글자가 아니라 '비언어 발성 이벤트'다.
//      → 대괄호 밖의 'ㅋㅋㅋㅋ' 는 그대로 리터럴 텍스트로 남는다.
//
// Python 동형: python/expressive_timeline.py (stdlib only). 두 구현은 byte-identical 결과를 낸다.

// 이 모듈은 '의존성 없는 자립 모듈'이다(repo 관례: src/shared 모듈끼리 런타임 import 금지 —
//   번들러와 node 의 해석 규칙이 달라서 ttsConfig.ts 도 같은 이유로 상수를 미러링한다).
//   아래 EXPRESSIVE_EMOTION_LABEL_TO_ID / EXPRESSIVE_PAUSE_NAMES / expressiveSha256Hex 는
//   ttsGrammar.ts 의 거울이며, 드리프트는 다음 테스트가 잡는다:
//     - src/shared/expressiveTimeline.test.ts  (ttsGrammar.ts 와 직접 대조)
//     - python/test_expressive_timeline.py     (expressiveTimeline.ts 소스를 읽어 tts_grammar 와 대조)

// ─────────────────────────────────────────────────────────────────────────────
// 0. 버전 / 모드 계약
// ─────────────────────────────────────────────────────────────────────────────

/** 이 모듈이 정의하는 표현형 계약의 버전. v2 wire plan 과 '별개'의 축이다. */
export const EXPRESSIVE_CONTRACT_VERSION = 3 as const
/** 기존 wire plan(ttsParserVersion / ttsParsedPlanSha256)의 버전. 이 레이어가 바꾸지 않는다. */
export const EXPRESSIVE_LEGACY_PLAN_VERSION = 2 as const

/**
 * 파싱 모드. 오직 호출자(capability/config/session flag)만 고른다 — 본문 내용은 절대 고르지 않는다.
 * - 'legacy_v2'     : 오늘과 동일. 운율/웃음 이벤트 없음. effectiveVersion = 2.
 * - 'expressive_v3' : 표현형 계약 활성. effectiveVersion = 3.
 */
export const EXPRESSIVE_MODES = ['legacy_v2', 'expressive_v3'] as const
export type ExpressiveMode = typeof EXPRESSIVE_MODES[number]
/** 명시 선택이 없으면 언제나 legacy — 조용한 마이그레이션 금지. */
export const EXPRESSIVE_DEFAULT_MODE: ExpressiveMode = 'legacy_v2'
export const EXPRESSIVE_MODE_TO_VERSION: Readonly<Record<ExpressiveMode, 2 | 3>> = Object.freeze({
  legacy_v2: 2,
  expressive_v3: 3,
})

// 드리프트 가드는 테스트가 담당한다(런타임 cross-module import 없음):
//   EXPRESSIVE_LEGACY_PLAN_VERSION === ttsGrammar.TTS_PARSER_VERSION 을 TS/Python 양쪽 테스트가 단언한다.

// ─────────────────────────────────────────────────────────────────────────────
// 0b. ttsGrammar.ts 거울(자립 모듈이라 값 복사 — 드리프트는 테스트가 감시)
// ─────────────────────────────────────────────────────────────────────────────

/** ttsGrammar.TTS_EMOTION_LABEL_TO_ID 의 거울. 감정 label/id -> emotionId. */
export const EXPRESSIVE_EMOTION_LABEL_TO_ID: Readonly<Record<string, string>> = Object.freeze({
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
  'climax': 'climax', 'moaning': 'moaning', 'ecstasy': 'ecstasy',})

/** ttsGrammar.TTS_PAUSE_NAMES 의 거울. */
export const EXPRESSIVE_PAUSE_NAMES: ReadonlySet<string> = new Set(['쉼', 'pause'])

// ─────────────────────────────────────────────────────────────────────────────
// 1. enum 집합 (TS/Python 공용 — parity 테스트가 서로의 소스를 읽어 대조한다)
// ─────────────────────────────────────────────────────────────────────────────

export const EXPRESSIVE_NODE_KINDS = [
  'text', 'lineBreak', 'emotionTransition', 'localProsody', 'nonverbalLaugh', 'explicitPause',
] as const
export type ExpressiveNodeKind = typeof EXPRESSIVE_NODE_KINDS[number]

export const EMOTION_TRANSITION_MODES = ['blend', 'immediate'] as const
export type EmotionTransitionMode = typeof EMOTION_TRANSITION_MODES[number]

export const LOCAL_PROSODY_KINDS = [
  'firm_end', 'fade_end', 'emphasis', 'question_rise', 'shock_rise', 'vowel_extend',
] as const
export type LocalProsodyKind = typeof LOCAL_PROSODY_KINDS[number]

export const PROSODY_SCOPE_KINDS = ['final_syllables', 'final_word', 'latter_half', 'final_vowel'] as const
export type ProsodyScopeKind = typeof PROSODY_SCOPE_KINDS[number]

export const LAUGH_STYLES = ['chuckle', 'breathy', 'bashful', 'open', 'high_giggle'] as const
export type LaughStyle = typeof LAUGH_STYLES[number]

export const LAUGH_POSITIONS = ['leading', 'inline', 'trailing', 'standalone'] as const
export type LaughPosition = typeof LAUGH_POSITIONS[number]

export const VOWEL_EXTEND_DEGRADE_REASONS = [
  'final_consonant', 'unsupported_script', 'no_preceding_text', 'no_preceding_vowel',
] as const
export type VowelExtendDegradeReason = typeof VOWEL_EXTEND_DEGRADE_REASONS[number]

export const EXPRESSIVE_BOUNDARY_KINDS = ['explicitPause', 'sentenceGap', 'finalTail'] as const
export type ExpressiveBoundaryKind = typeof EXPRESSIVE_BOUNDARY_KINDS[number]

/**
 * 계약 5 — 의미 우선순위(나중에 오는 planner 가 '다르게 재유도'할 수 없도록 여기에 고정).
 * 감정 태그 → local prosody → 웃음 → 명시 [쉼] → 문장 gap(명시 쉼이 없는 곳에서만) → final tail(파일 끝 1회).
 */
export const EXPRESSIVE_EVENT_PRIORITY = [
  'emotionTransition', 'localProsody', 'nonverbalLaugh', 'explicitPause', 'sentenceGap', 'finalTail',
] as const
export type ExpressiveEventPriorityEntry = typeof EXPRESSIVE_EVENT_PRIORITY[number]

/** 구조화 오류/경고 코드. v2 의 TTS_GRAMMAR_ERROR_CODES 와 '별개 집합'(v2 계약을 건드리지 않기 위해). */
export const EXPRESSIVE_ERROR_CODES = [
  'UNKNOWN_EXPRESSIVE_TAG',      // error   — 감정/쉼/웃음 어느 것도 아닌 control-tag
  'INVALID_EXPRESSIVE_PAUSE',    // error   — [쉼 N] 형식/범위 위반
  'INVALID_EMOTION_MODIFIER',    // error   — [감정|???] 미지원 수식어(v3 전용 구문)
  'AMBIGUOUS_LAUGH_TOKEN',       // error   — 웃음 문자만으로 이뤄졌으나 어떤 style 에도 일치하지 않음
  'UNSUPPORTED_VOWEL_EXTEND',    // warning — '~' 의 최종 모음 위치를 확정할 수 없음(자음/전체 늘이기 금지)
  'PROSODY_WITHOUT_HOST',        // warning — 앞선 발화 텍스트 없이 놓인 운율 토큰
  'EXPRESSIVE_PARITY_MISMATCH',  // error   — TS/Python 표현형 해시 불일치(런타임 게이트용 예약)
  'EXPRESSIVE_MODE_INVALID',     // error   — 모드 플래그 값이 계약 밖(조용한 기본값 승격 금지)
  'EXPRESSIVE_MODE_CARRIER_MISMATCH', // error — session/config/metadata 세 곳의 모드가 불일치
] as const
export type ExpressiveErrorCode = typeof EXPRESSIVE_ERROR_CODES[number]

export const EXPRESSIVE_DIAGNOSTIC_SEVERITIES = ['error', 'warning'] as const
export type ExpressiveDiagnosticSeverity = typeof EXPRESSIVE_DIAGNOSTIC_SEVERITIES[number]

// ─────────────────────────────────────────────────────────────────────────────
// 2. 토큰 문자 집합 (longest-token-first lexing 의 입력) — v3 모드에서만 쓰인다
// ─────────────────────────────────────────────────────────────────────────────

/** dot family. '…'(U+2026) 는 점 3개 무게로 센다. '。' 는 1. 텍스트는 절대 재작성하지 않는다. */
export const DOT_RUN_CHARS = '.。…'
export const DOT_CHAR_WEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  '.': 1, '。': 1, '…': 3,
})
/** '!' family(반각/전각). */
export const BANG_RUN_CHARS = '!！'
/** '?' family(반각/전각). */
export const QUESTION_RUN_CHARS = '?？'
/** '~' family(ASCII tilde / fullwidth tilde / wave dash). */
export const TILDE_RUN_CHARS = '~～〜'

/**
 * 공백 판정 — 정규식 \s 의 JS/Python 차이를 배제하기 위한 '명시' 집합.
 * (JS String.trim 과 Python str.strip 은 U+FEFF / U+0085 등에서 서로 다르게 동작한다.
 *  여기서는 두 언어가 완전히 같게 움직이도록 문자 집합을 직접 못 박는다.)
 */
export const EXPRESSIVE_WHITESPACE_CHARS =
  ' \t\n\f\r                 　'

/** 웃음에 쓰이는 문자 집합. 이 문자들'만'으로 이뤄졌는데 style 매칭 실패 → AMBIGUOUS_LAUGH_TOKEN. */
export const LAUGH_TOKEN_CHARS = 'ㅋㅎ헤헷호홋히'

/** 감정 수식어 구분자와 표. `[기쁨|즉시]` 처럼 쓴다(v2 에서는 UNKNOWN_TTS_TAG 로 차단되던 형태 → v3 전용). */
export const EMOTION_MODIFIER_SEPARATOR = '|'
export const EMOTION_MODIFIER_TO_MODE: Readonly<Record<string, EmotionTransitionMode>> = Object.freeze({
  '즉시': 'immediate', 'immediate': 'immediate',
  '블렌드': 'blend', 'blend': 'blend',
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 수치 계약 (전부 정수 — canonical 해시에 float 금지)
// ─────────────────────────────────────────────────────────────────────────────

// ── 감정 전이 ──
export const EMOTION_TRANSITION_DEFAULT_MODE: EmotionTransitionMode = 'blend'
export const EMOTION_TRANSITION_DEFAULT_STRENGTH = 100
export const EMOTION_BLEND_DURATION_MS = 300
export const EMOTION_IMMEDIATE_DURATION_MS = 0
/** 감정 태그는 스스로 어떤 무음도 만들지 않는다(계약 1). */
export const EMOTION_TRANSITION_EXTRA_PAUSE_MS = 0
/** 감정 태그는 chunk 경계가 아니다(계약 1). */
export const EMOTION_TRANSITION_IS_CHUNK_BOUNDARY = false

// ── dot run ──
export const DOT_RUN_MIN_COUNT = 1
export const DOT_RUN_MAX_COUNT = 6
/**
 * count 1 = firm_end — '단호한 중립 종결'. 강조가 아니다.
 * 값이 일부러 낮다: '...'(fade_end) 나 '!'(emphasis) 보다 뚜렷하게 약해야 한다.
 */
export const FIRM_END_STRENGTH = 25
export const FIRM_END_DURATION_MS = 120
/** index = effective dot count(2..6). 0/1 은 미사용(1 은 firm_end). */
export const FADE_END_STRENGTH_BY_COUNT: readonly number[] = Object.freeze([0, 0, 40, 55, 70, 85, 100])
export const FADE_END_DURATION_MS_BY_COUNT: readonly number[] = Object.freeze([0, 0, 240, 360, 480, 600, 720])

// ── '!' run ──
export const BANG_RUN_MIN_COUNT = 1
export const BANG_RUN_MAX_COUNT = 3
export const EMPHASIS_STRENGTH_BY_COUNT: readonly number[] = Object.freeze([0, 60, 80, 100])
export const EMPHASIS_DURATION_MS_BY_COUNT: readonly number[] = Object.freeze([0, 300, 400, 500])

// ── '?' run ──
export const QUESTION_RUN_MIN_COUNT = 1
export const QUESTION_RUN_MAX_COUNT = 3
export const QUESTION_RISE_STRENGTH_BY_COUNT: readonly number[] = Object.freeze([0, 70, 85, 100])
export const QUESTION_RISE_DURATION_MS_BY_COUNT: readonly number[] = Object.freeze([0, 250, 300, 350])

// ── '!?' (shock) run ── 한 토큰. 절대 '!' + '?' 로 나뉘지 않는다.
export const SHOCK_RUN_MIN_COUNT = 2
export const SHOCK_RUN_MAX_COUNT = 4
export const SHOCK_RISE_STRENGTH_BY_COUNT: readonly number[] = Object.freeze([0, 0, 80, 90, 100])
export const SHOCK_RISE_DURATION_MS_BY_COUNT: readonly number[] = Object.freeze([0, 0, 350, 400, 450])

// ── '~' run ──
export const TILDE_RUN_MIN_COUNT = 1
export const TILDE_RUN_MAX_COUNT = 4
export const VOWEL_EXTEND_STRENGTH_BY_COUNT: readonly number[] = Object.freeze([0, 40, 60, 80, 100])
export const VOWEL_EXTEND_DURATION_MS_BY_COUNT: readonly number[] = Object.freeze([0, 150, 250, 350, 450])

// ── 웃음 반복 ── 반복 횟수는 '음절 수'가 아니라 duration/intensity HINT 이며 상한이 있다.
export const LAUGH_REPEAT_MIN_COUNT = 1
export const LAUGH_REPEAT_MAX_COUNT = 8
export const LAUGH_INTENSITY_BY_REPEAT: readonly number[] = Object.freeze([0, 30, 45, 55, 65, 75, 85, 92, 100])
export const LAUGH_BRIGHTNESS_BY_REPEAT: readonly number[] = Object.freeze([0, 40, 52, 62, 70, 78, 86, 93, 100])
export const LAUGH_DURATION_MS_BY_REPEAT: readonly number[] = Object.freeze([0, 180, 300, 420, 540, 660, 780, 900, 1020])

// ── 국소 운율 범위 ── "마지막 몇 음절" 을 숫자로 고정.
export const LOCAL_PROSODY_TAIL_SYLLABLES = 3
/** 문장부호는 chunk 경계가 아니다(계약 2). */
export const LOCAL_PROSODY_IS_CHUNK_BOUNDARY = false
/** 문장 gap 은 오직 줄바꿈에서만 생긴다. 문장부호는 문장 분할자가 아니다. */
export const SENTENCE_GAP_SOURCE = 'lineBreak' as const
/** 명시 [쉼] 이 있는 경계에서 문장 gap 은 '대체'된다(합산 아님). */
export const SENTENCE_GAP_SUPPRESSED_BY_EXPLICIT_PAUSE = true
/** 문장 gap 과 감정 전이 pause 는 결코 합산되지 않는다 — 감정 전이는 경계를 만들지도 않는다. */
export const SENTENCE_GAP_AND_EMOTION_PAUSE_MAY_SUM = false
/** final tail 은 파일 전체의 맨 끝에서 정확히 1회. */
export const FINAL_TAIL_APPLIES_ONCE_AT_FILE_END = true

// ── 쉼 태그 범위(v2 와 동일 — 드리프트 방지를 위해 여기서도 명시) ──
export const EXPRESSIVE_PAUSE_MIN_SEC = 0.05
export const EXPRESSIVE_PAUSE_MAX_SEC = 5.0

/** 한글 중성(모음) 표 — '~' 의 최종 모음 판정용. */
export const HANGUL_JUNGSEONG: readonly string[] = Object.freeze([
  'ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ',
  'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ',
  'ㅣ',
])
/** 모음이 자명한 가나만 지원. 나머지 가나/한자는 unsupported_script(정직한 한계). */
export const KANA_VOWEL_MAP: Readonly<Record<string, string>> = Object.freeze({
  'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
  'ア': 'a', 'イ': 'i', 'ウ': 'u', 'エ': 'e', 'オ': 'o',
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. AST 타입
// ─────────────────────────────────────────────────────────────────────────────

/** 단일 지점 offset(UI=UTF-16 code unit / 텍스트=Unicode code point). 혼용 금지. */
export interface ExprOffset {
  utf16: number
  codepoint: number
}

/** 구간 offset(dual). */
export interface ExprRange {
  startUtf16: number
  endUtf16: number
  startCodepoint: number
  endCodepoint: number
}

/**
 * 계약 1 — 감정 전이 이벤트.
 * "여기서 새 WAV" 가 아니라 "한 사람이 계속 말하는 도중 감정이 바뀌는 지점".
 */
export interface EmotionTransitionEvent {
  /** 정규화된 emotionId(예: 'happy'). */
  targetEmotion: string
  /** 원문에 쓰인 이름(한글 label 또는 영문 id). 오류/UI 표시용. */
  targetEmotionLabel: string
  /** 전이가 일어나는 지점(태그 시작). */
  sourceOffset: ExprOffset
  /** 태그 전체가 차지한 원문 구간. */
  sourceRange: ExprRange
  /** 기본 'blend'. 'immediate' 는 명시적으로 요청된 경우에만. */
  transitionMode: EmotionTransitionMode
  /** 0..100 정수. 목표 감정으로 얼마나 완전히 옮겨가는가. */
  transitionStrength: number
  /** 전이에 쓸 시간 힌트(ms, 정수). blend=300, immediate=0. */
  transitionDurationHint: number
  /** 항상 0 — 감정 태그는 스스로 무음을 만들지 않는다. */
  extraPauseMs: typeof EMOTION_TRANSITION_EXTRA_PAUSE_MS
  /** 항상 false — 감정 태그는 chunk 경계가 아니다. */
  isChunkBoundary: typeof EMOTION_TRANSITION_IS_CHUNK_BOUNDARY
  /** 사용자가 수식어로 mode 를 명시했는가(false 면 기본값 blend 적용). */
  explicitMode: boolean
  rawToken: string
  nodeIndex: number
  lineIndex: number
}

/** '~' 의 최종 모음 판정 결과. supported=false 면 절대 자음/전체 발화를 늘이지 말 것. */
export interface VowelExtendInfo {
  supported: boolean
  /** 확정된 모음 문자(한글 중성 또는 라틴/가나 모음). 미확정이면 null. */
  targetVowel: string | null
  degradedReason: VowelExtendDegradeReason | null
}

/**
 * 계약 2 — 국소 운율 이벤트(v3 모드에서만 생성).
 * 문장부호는 문장 분할자가 아니라 '마지막 몇 음절'에 걸리는 국소 명령이다.
 */
export interface LocalProsodyEvent {
  kind: LocalProsodyKind
  /** 토큰 자체가 차지한 원문 구간. */
  sourceRange: ExprRange
  /** 0..100 정수. */
  strength: number
  /** ms 정수. */
  durationHint: number
  rawToken: string
  /** 원문에 쓰인 그대로의 개수/무게(dot 은 '…'=3 가중). */
  rawCount: number
  /** 상한 적용 후 실제 효과에 쓰이는 개수. */
  effectiveCount: number
  /** rawCount > max 라서 효과가 상한에 걸렸는가(텍스트는 절대 바뀌지 않는다). */
  capped: boolean
  scopeKind: ProsodyScopeKind
  /** 효과가 실제로 걸리는 원문 구간. */
  scopeRange: ExprRange
  /** 이 토큰이 수식하는 직전 발화 텍스트 구간(감정 태그는 이 구간을 끊지 않는다). */
  hostRange: ExprRange
  /** 항상 false — 문장부호는 chunk 경계가 아니다. */
  isChunkBoundary: typeof LOCAL_PROSODY_IS_CHUNK_BOUNDARY
  /** 항상 0 — 문장부호는 스스로 무음을 만들지 않는다. */
  extraPauseMs: 0
  /** kind==='vowel_extend' 일 때만 non-null. */
  vowelExtend: VowelExtendInfo | null
  nodeIndex: number
  lineIndex: number
}

/**
 * 계약 4 — 비언어 웃음 이벤트(v3 모드에서만 생성). 대괄호 안에서만 성립한다.
 * 대괄호 밖의 'ㅋㅋㅋㅋ' 는 읽는 글자(리터럴 텍스트)로 남는다.
 */
export interface NonverbalLaughEvent {
  style: LaughStyle
  /** 0..100 정수. */
  intensity: number
  /** 0..100 정수. 반복이 길수록 밝다. */
  brightness: number
  /** ms 정수. */
  durationHint: number
  position: LaughPosition
  rawToken: string
  /** 원문 반복 수(음절 수가 아니라 힌트). */
  rawRepeatCount: number
  /** 상한 적용 후 값. */
  effectiveRepeatCount: number
  capped: boolean
  sourceRange: ExprRange
  /** 웃음 자체는 chunk 경계가 아니다(같은 사람의 같은 발화 흐름). */
  isChunkBoundary: false
  nodeIndex: number
  lineIndex: number
}

/** 명시 [쉼 N] — v2 와 동일 의미. 문장 gap 을 '대체'한다(합산 아님). */
export interface ExplicitPauseEvent {
  /** 정수 ms. */
  pauseMs: number
  rawToken: string
  sourceRange: ExprRange
  nodeIndex: number
  lineIndex: number
}

/** 우선순위가 이미 '해결된' 경계 결정. planner 가 다시 유도하지 않도록 결과를 기록한다. */
export interface ExpressiveBoundary {
  kind: ExpressiveBoundaryKind
  /** 이 위치에서 후보였던 경계들(우선순위 순). */
  candidates: ExpressiveBoundaryKind[]
  /** 우선순위에서 밀려 '억제된' 후보들(합산 금지의 증거). */
  suppressed: ExpressiveBoundaryKind[]
  /** 파싱 시점에 확정 가능한 값만. sentenceGap/finalTail 은 런타임 config 소관이라 null. */
  pauseMs: number | null
  sourceOffset: ExprOffset
  lineIndex: number
}

/** 구조화 진단(대사 전문 없음 — code/사유/offset 만). */
export interface ExpressiveDiagnostic {
  code: ExpressiveErrorCode
  severity: ExpressiveDiagnosticSeverity
  /** control-tag 원문 이름 등 식별자(대사 전문 아님). */
  tag?: string
  /** 잘못된 인자 원문. */
  arg?: string
  reason?: string
  uiOffsetUtf16: number
}

export type ExpressiveNode =
  | { kind: 'text'; rawToken: string; range: ExprRange; lineIndex: number; text: string }
  | { kind: 'lineBreak'; rawToken: string; range: ExprRange; lineIndex: number }
  | { kind: 'emotionTransition'; rawToken: string; range: ExprRange; lineIndex: number; eventIndex: number }
  | { kind: 'localProsody'; rawToken: string; range: ExprRange; lineIndex: number; eventIndex: number }
  | { kind: 'nonverbalLaugh'; rawToken: string; range: ExprRange; lineIndex: number; eventIndex: number }
  | { kind: 'explicitPause'; rawToken: string; range: ExprRange; lineIndex: number; eventIndex: number }

export interface ExpressiveSummary {
  contractVersion: typeof EXPRESSIVE_CONTRACT_VERSION
  /** 이 파싱에 실제로 적용된 모드(호출자가 고른 값 그대로). */
  mode: ExpressiveMode
  /** mode 로부터만 결정되는 버전(2 또는 3). 내용은 절대 이 값을 바꾸지 않는다. */
  effectiveVersion: 2 | 3
  nodeCount: number
  lineCount: number
  emotionTransitionCount: number
  localProsodyCount: number
  laughCount: number
  explicitPauseCount: number
  totalExplicitPauseMs: number
  usedEmotionIds: string[]
  degradedVowelExtendCount: number
  cappedTokenCount: number
  /** 표시용 8 hex(표현형 해시 앞 8자리). v2 planSha8 와 혼용 금지. */
  sha8: string
}

export interface ExpressiveTimeline {
  contractVersion: typeof EXPRESSIVE_CONTRACT_VERSION
  /** 이 타임라인과 나란히 존재하는 v2 plan 의 버전(항상 2 — 이 레이어가 바꾸지 않는다). */
  legacyPlanVersion: typeof EXPRESSIVE_LEGACY_PLAN_VERSION
  /** 호출자가 고른 모드. UI 가 '표현형 모드 켜짐/꺼짐'을 그대로 표시할 수 있다. */
  mode: ExpressiveMode
  /** mode 로부터만 결정되는 버전(2|3). 본문 내용은 절대 이 값에 영향을 주지 않는다. */
  effectiveVersion: 2 | 3
  /** UI 표시용 boolean(= mode === 'expressive_v3'). */
  expressiveEnabled: boolean
  /**
   * 서술용 플래그: 이 파싱에서 실제로 표현형 이벤트가 나왔는가.
   * ⚠️ 버전 선택에 절대 쓰지 말 것(legacy 모드에서는 언제나 false).
   */
  hasExpressiveEvents: boolean
  /** 원문을 빈틈/중복 없이 덮는 순서 있는 노드 목록. rawToken 을 이어붙이면 원문과 완전히 같다. */
  nodes: ExpressiveNode[]
  emotionTransitions: EmotionTransitionEvent[]
  localProsody: LocalProsodyEvent[]
  laughs: NonverbalLaughEvent[]
  explicitPauses: ExplicitPauseEvent[]
  boundaries: ExpressiveBoundary[]
  diagnostics: ExpressiveDiagnostic[]
  /** 발화 텍스트 + 운율 토큰 원문(제어 태그·웃음 제거). 모델에 그대로 넣어도 되는 형태. */
  verbatimText: string
  /** 발화 텍스트만(운율 토큰까지 제거). 운율을 순수 파라미터로만 다루는 엔진용. */
  plainText: string
  summary: ExpressiveSummary
  /** TS/Python parity 비교 전용 full sha256(64 hex). v2 fullSha256 와 별개 축. */
  fullSha256: string
}

export interface ExpressiveParseOptions {
  /**
   * 파싱 모드. capability/config/session flag 에서 '명시적으로' 주입한다.
   * 생략하면 EXPRESSIVE_DEFAULT_MODE('legacy_v2') — 본문 내용으로 추론하지 않는다.
   */
  mode?: ExpressiveMode
  /** name(label/id) → emotionId | null. 미지정 시 EXPRESSIVE_EMOTION_LABEL_TO_ID. */
  resolveEmotion?: (name: string) => string | null
}

export interface ExpressiveParseOk {
  ok: true
  mode: ExpressiveMode
  effectiveVersion: 2 | 3
  timeline: ExpressiveTimeline
}
export interface ExpressiveParseErr {
  ok: false
  mode: ExpressiveMode
  effectiveVersion: 2 | 3
  errors: ExpressiveDiagnostic[]
}
export type ExpressiveParseResult = ExpressiveParseOk | ExpressiveParseErr

// ─────────────────────────────────────────────────────────────────────────────
// 5. 내부 유틸
// ─────────────────────────────────────────────────────────────────────────────

function defaultResolveEmotion(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(EXPRESSIVE_EMOTION_LABEL_TO_ID, name)
    ? EXPRESSIVE_EMOTION_LABEL_TO_ID[name]
    : null
}

function isWhitespace(ch: string): boolean {
  return EXPRESSIVE_WHITESPACE_CHARS.indexOf(ch) >= 0
}

/** 명시 공백 집합 기준 strip(언어별 trim 차이 배제). */
function stripWs(s: string): string {
  const a = Array.from(s)
  let lo = 0
  let hi = a.length
  while (lo < hi && isWhitespace(a[lo])) lo += 1
  while (hi > lo && isWhitespace(a[hi - 1])) hi -= 1
  return a.slice(lo, hi).join('')
}

/** 명시 공백 집합 기준 split(연속 공백 = 1 구분자). */
function splitWs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of s) {
    if (isWhitespace(ch)) {
      if (cur !== '') { out.push(cur); cur = '' }
    } else cur += ch
  }
  if (cur !== '') out.push(cur)
  return out
}

function clampCount(rawCount: number, min: number, max: number): { effective: number; capped: boolean } {
  if (rawCount > max) return { effective: max, capped: true }
  if (rawCount < min) return { effective: min, capped: false }
  return { effective: rawCount, capped: false }
}

type RunFamily = 'dot' | 'bangq' | 'tilde'

function runFamilyOf(ch: string): RunFamily | null {
  if (DOT_RUN_CHARS.indexOf(ch) >= 0) return 'dot'
  if (BANG_RUN_CHARS.indexOf(ch) >= 0 || QUESTION_RUN_CHARS.indexOf(ch) >= 0) return 'bangq'
  if (TILDE_RUN_CHARS.indexOf(ch) >= 0) return 'tilde'
  return null
}

// 웃음 style 매칭 — 계약 3: 일반 감정 태그 규칙보다 '먼저' 시도되는 더 구체적인 규칙.
const LAUGH_PATTERNS: ReadonlyArray<{ style: LaughStyle; re: RegExp }> = Object.freeze([
  { style: 'chuckle', re: /^ㅋ+$/ },
  { style: 'breathy', re: /^ㅎ+$/ },
  { style: 'bashful', re: /^(?:헤+헷?|헷)$/ },
  { style: 'open', re: /^(?:호+홋?|홋)$/ },
  { style: 'high_giggle', re: /^히+$/ },
])

function matchLaughStyle(t: string): LaughStyle | null {
  for (const p of LAUGH_PATTERNS) if (p.re.test(t)) return p.style
  return null
}

function isAllLaughChars(t: string): boolean {
  if (t.length === 0) return false
  for (const ch of t) if (LAUGH_TOKEN_CHARS.indexOf(ch) < 0) return false
  return true
}

const PAUSE_ARG_RE = /^[0-9]+(\.[0-9]+)?$/

// ─────────────────────────────────────────────────────────────────────────────
// 6. bracket 분류
// ─────────────────────────────────────────────────────────────────────────────

type BracketClass =
  | { type: 'literalize' }
  | { type: 'laugh'; style: LaughStyle; repeat: number }
  | { type: 'emotion'; id: string; name: string; mode: EmotionTransitionMode; explicitMode: boolean }
  | { type: 'pause'; ms: number }
  | { type: 'error'; code: ExpressiveErrorCode; tag?: string; arg?: string; reason?: string }

function classifyExpressiveBracket(
  inner: string,
  resolveEmotion: (n: string) => string | null,
  mode: ExpressiveMode,
): BracketClass {
  const t = stripWs(inner)
  if (t === '') return { type: 'literalize' }
  const v3 = mode === 'expressive_v3'

  // 계약 3 — 웃음 규칙이 '일반 감정 태그'보다 더 구체적이므로 먼저 시도한다(v3 전용).
  if (v3) {
    const style = matchLaughStyle(t)
    if (style != null) return { type: 'laugh', style, repeat: Array.from(t).length }
    if (isAllLaughChars(t)) {
      // 웃음 문자만으로 이뤄졌는데 어떤 style 에도 안 맞음 → 조용한 추측 금지.
      return { type: 'error', code: 'AMBIGUOUS_LAUGH_TOKEN', tag: t }
    }
  }

  const parts = splitWs(t)
  if (parts.length === 1) {
    const name = parts[0]
    if (v3 && name.indexOf(EMOTION_MODIFIER_SEPARATOR) >= 0) {
      const segs = name.split(EMOTION_MODIFIER_SEPARATOR)
      const head = segs[0]
      const eid = resolveEmotion(head)
      if (eid == null) return { type: 'error', code: 'UNKNOWN_EXPRESSIVE_TAG', tag: name }
      if (segs.length !== 2) {
        return {
          type: 'error', code: 'INVALID_EMOTION_MODIFIER', tag: name,
          arg: segs.slice(1).join(EMOTION_MODIFIER_SEPARATOR), reason: 'arity',
        }
      }
      const mod = segs[1]
      if (!Object.prototype.hasOwnProperty.call(EMOTION_MODIFIER_TO_MODE, mod)) {
        return { type: 'error', code: 'INVALID_EMOTION_MODIFIER', tag: name, arg: mod, reason: 'unknown_modifier' }
      }
      return { type: 'emotion', id: eid, name: head, mode: EMOTION_MODIFIER_TO_MODE[mod], explicitMode: true }
    }
    const eid = resolveEmotion(name)
    if (eid != null) {
      return { type: 'emotion', id: eid, name, mode: EMOTION_TRANSITION_DEFAULT_MODE, explicitMode: false }
    }
    if (EXPRESSIVE_PAUSE_NAMES.has(name)) {
      return { type: 'error', code: 'INVALID_EXPRESSIVE_PAUSE', arg: '', reason: 'missing_arg' }
    }
    return { type: 'error', code: 'UNKNOWN_EXPRESSIVE_TAG', tag: name }
  }

  if (EXPRESSIVE_PAUSE_NAMES.has(parts[0])) {
    if (parts.length !== 2) {
      return { type: 'error', code: 'INVALID_EXPRESSIVE_PAUSE', arg: parts.slice(1).join(' '), reason: 'format' }
    }
    const arg = parts[1]
    if (!PAUSE_ARG_RE.test(arg)) return { type: 'error', code: 'INVALID_EXPRESSIVE_PAUSE', arg, reason: 'format' }
    const sec = Number.parseFloat(arg)
    if (!Number.isFinite(sec)) return { type: 'error', code: 'INVALID_EXPRESSIVE_PAUSE', arg, reason: 'format' }
    if (sec < EXPRESSIVE_PAUSE_MIN_SEC || sec > EXPRESSIVE_PAUSE_MAX_SEC) {
      return { type: 'error', code: 'INVALID_EXPRESSIVE_PAUSE', arg, reason: 'range' }
    }
    // v2(_validate_pause_arg)와 동일한 반올림식을 그대로 쓴다(두 레이어 간 불일치 방지).
    return { type: 'pause', ms: Math.round(sec * 1000) }
  }

  // 첫 토큰이 쉼/pause 가 아닌데 내부 공백 존재 → control-tag 아님 → 리터럴(v2 와 동일).
  return { type: 'literalize' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 파서
// ─────────────────────────────────────────────────────────────────────────────

interface PendingNode {
  kind: ExpressiveNodeKind
  startIdx: number
  endIdx: number
  lineIndex: number
  text?: string
  textSrc?: number[]
  payload?: BracketClass | { runFamily: RunFamily; run: string }
}

interface HostChar { ch: string; src: number }

/**
 * raw ttsText → ExpressiveTimeline. python/expressive_timeline.parse_expressive_timeline 와 동형.
 * v2 parseTtsScript 는 전혀 호출하지 않으며, v2 결과에도 영향을 주지 않는다.
 * mode 를 주지 않으면 legacy_v2 — 내용에 '.'/'!?'/'~'/'[ㅋㅋ]' 가 있어도 자동 승격하지 않는다.
 */
export function parseExpressiveTimeline(raw: string, opts?: ExpressiveParseOptions): ExpressiveParseResult {
  const mode: ExpressiveMode = opts?.mode ?? EXPRESSIVE_DEFAULT_MODE
  const effectiveVersion: 2 | 3 = EXPRESSIVE_MODE_TO_VERSION[mode]
  const v3 = mode === 'expressive_v3'
  const resolveEmotion = opts?.resolveEmotion ?? defaultResolveEmotion
  const source = raw ?? ''
  const chars = Array.from(source)
  const n = chars.length

  // u16At[k] = chars[0..k) 의 UTF-16 code unit 수
  const u16At = new Array<number>(n + 1)
  u16At[0] = 0
  for (let k = 0; k < n; k++) u16At[k + 1] = u16At[k] + chars[k].length

  const rangeOf = (a: number, b: number): ExprRange => ({
    startUtf16: u16At[a], endUtf16: u16At[b], startCodepoint: a, endCodepoint: b,
  })
  const offsetOf = (a: number): ExprOffset => ({ utf16: u16At[a], codepoint: a })
  const sliceOf = (a: number, b: number): string => chars.slice(a, b).join('')

  const pending: PendingNode[] = []
  const diagnostics: ExpressiveDiagnostic[] = []
  const errors: ExpressiveDiagnostic[] = []

  const pushDiag = (d: ExpressiveDiagnostic): void => {
    diagnostics.push(d)
    if (d.severity === 'error') errors.push(d)
  }

  let i = 0
  let lineIndex = 0
  let litStart = -1
  let litText = ''
  let litSrc: number[] = []

  const flushLit = (endIdx: number): void => {
    if (litStart < 0) return
    pending.push({ kind: 'text', startIdx: litStart, endIdx, lineIndex, text: litText, textSrc: litSrc })
    litStart = -1
    litText = ''
    litSrc = []
  }
  const appendLit = (startIdx: number, ch: string, srcIdx: number): void => {
    if (litStart < 0) litStart = startIdx
    litText += ch
    litSrc.push(srcIdx)
  }

  while (i < n) {
    const c = chars[i]

    if (c === '\n') {
      flushLit(i)
      pending.push({ kind: 'lineBreak', startIdx: i, endIdx: i + 1, lineIndex })
      lineIndex += 1
      i += 1
      continue
    }

    if (c === '\\') {
      const next = i + 1 < n ? chars[i + 1] : ''
      if (next === '\\') { appendLit(i, '\\', i + 1); i += 2; continue }
      if (next === '[' || next === ']') { appendLit(i, next, i + 1); i += 2; continue }
      appendLit(i, '\\', i); i += 1; continue
    }

    if (c === '[') {
      // v2 tokenize 와 동일한 bracket 스캔(중첩 '[' / 줄바꿈 / 미종료 → 리터럴 '[').
      let j = i + 1
      let inner = ''
      const innerSrc: number[] = []
      let close = -1
      while (j < n) {
        const cj = chars[j]
        if (cj === '\\' && (chars[j + 1] === '[' || chars[j + 1] === ']' || chars[j + 1] === '\\')) {
          inner += chars[j + 1]; innerSrc.push(j + 1); j += 2; continue
        }
        if (cj === ']') { close = j; break }
        if (cj === '[') break
        if (cj === '\n') break
        inner += cj; innerSrc.push(j); j += 1
      }
      if (close === -1) { appendLit(i, '[', i); i += 1; continue }

      const cls = classifyExpressiveBracket(inner, resolveEmotion, mode)
      if (cls.type === 'literalize') {
        flushLit(i)
        const text = '[' + inner + ']'
        const textSrc = [i, ...innerSrc, close]
        pending.push({ kind: 'text', startIdx: i, endIdx: close + 1, lineIndex, text, textSrc })
        i = close + 1
        continue
      }
      flushLit(i)
      if (cls.type === 'error') {
        const d: ExpressiveDiagnostic = { code: cls.code, severity: 'error', uiOffsetUtf16: u16At[i] }
        if (cls.tag !== undefined) d.tag = cls.tag
        if (cls.arg !== undefined) d.arg = cls.arg
        if (cls.reason !== undefined) d.reason = cls.reason
        pushDiag(d)
        // 오류여도 위치 정보 보존을 위해 스캔은 계속하되, 결과는 실패로 반환된다.
        i = close + 1
        continue
      }
      const kind: ExpressiveNodeKind =
        cls.type === 'laugh' ? 'nonverbalLaugh' : cls.type === 'emotion' ? 'emotionTransition' : 'explicitPause'
      pending.push({ kind, startIdx: i, endIdx: close + 1, lineIndex, payload: cls })
      i = close + 1
      continue
    }

    if (v3) {
      const fam = runFamilyOf(c)
      if (fam != null) {
        // longest-token-first: 같은 family 문자의 '최대' 연속 구간을 한 토큰으로 삼는다.
        // → '!?' 는 절대 '!'+'?' 로 쪼개지지 않고, '......' 는 '...'+'...' 이 아니다.
        let j = i
        while (j < n && runFamilyOf(chars[j]) === fam) j += 1
        flushLit(i)
        pending.push({
          kind: 'localProsody', startIdx: i, endIdx: j, lineIndex,
          payload: { runFamily: fam, run: sliceOf(i, j) },
        })
        i = j
        continue
      }
    }

    appendLit(i, c, i)
    i += 1
  }
  flushLit(n)

  // ── 이벤트 조립 ──
  const nodes: ExpressiveNode[] = []
  const nodeTextSrc: (number[] | null)[] = []
  const emotionTransitions: EmotionTransitionEvent[] = []
  const localProsody: LocalProsodyEvent[] = []
  const laughs: NonverbalLaughEvent[] = []
  const explicitPauses: ExplicitPauseEvent[] = []

  function collectHost(nodeIndex: number): HostChar[] {
    const out: HostChar[] = []
    for (let k = nodeIndex - 1; k >= 0; k--) {
      const nd = nodes[k]
      if (nd.kind === 'emotionTransition') continue // 감정 태그는 발화를 끊지 않는다(계약 1)
      if (nd.kind !== 'text') break
      const src = nodeTextSrc[k] ?? []
      const t = Array.from(nd.text)
      const seg: HostChar[] = []
      for (let q = 0; q < t.length; q++) seg.push({ ch: t[q], src: src[q] ?? nd.range.startCodepoint })
      out.unshift(...seg)
    }
    return out
  }

  function buildLocalProsody(
    pay: { runFamily: RunFamily; run: string },
    p: PendingNode,
    nodeIndex: number,
    range: ExprRange,
    rawToken: string,
  ): LocalProsodyEvent {
    const runChars = Array.from(pay.run)
    let kind: LocalProsodyKind
    let rawCount: number
    let minC: number
    let maxC: number
    if (pay.runFamily === 'dot') {
      rawCount = 0
      for (const ch of runChars) rawCount += DOT_CHAR_WEIGHTS[ch] ?? 1
      minC = DOT_RUN_MIN_COUNT; maxC = DOT_RUN_MAX_COUNT
      kind = rawCount <= 1 ? 'firm_end' : 'fade_end'
    } else if (pay.runFamily === 'tilde') {
      rawCount = runChars.length
      minC = TILDE_RUN_MIN_COUNT; maxC = TILDE_RUN_MAX_COUNT
      kind = 'vowel_extend'
    } else {
      let bangs = 0
      let questions = 0
      for (const ch of runChars) {
        if (BANG_RUN_CHARS.indexOf(ch) >= 0) bangs += 1
        else questions += 1
      }
      rawCount = runChars.length
      if (bangs > 0 && questions > 0) {
        kind = 'shock_rise'; minC = SHOCK_RUN_MIN_COUNT; maxC = SHOCK_RUN_MAX_COUNT
      } else if (bangs > 0) {
        kind = 'emphasis'; minC = BANG_RUN_MIN_COUNT; maxC = BANG_RUN_MAX_COUNT
      } else {
        kind = 'question_rise'; minC = QUESTION_RUN_MIN_COUNT; maxC = QUESTION_RUN_MAX_COUNT
      }
    }
    const clamped = clampCount(rawCount, minC, maxC)
    const effective = clamped.effective

    let strength: number
    let durationHint: number
    let scopeKind: ProsodyScopeKind
    if (kind === 'firm_end') {
      strength = FIRM_END_STRENGTH; durationHint = FIRM_END_DURATION_MS; scopeKind = 'final_syllables'
    } else if (kind === 'fade_end') {
      strength = FADE_END_STRENGTH_BY_COUNT[effective]; durationHint = FADE_END_DURATION_MS_BY_COUNT[effective]
      scopeKind = 'final_syllables'
    } else if (kind === 'emphasis') {
      strength = EMPHASIS_STRENGTH_BY_COUNT[effective]; durationHint = EMPHASIS_DURATION_MS_BY_COUNT[effective]
      scopeKind = 'latter_half'
    } else if (kind === 'question_rise') {
      strength = QUESTION_RISE_STRENGTH_BY_COUNT[effective]; durationHint = QUESTION_RISE_DURATION_MS_BY_COUNT[effective]
      scopeKind = 'final_word'
    } else if (kind === 'shock_rise') {
      strength = SHOCK_RISE_STRENGTH_BY_COUNT[effective]; durationHint = SHOCK_RISE_DURATION_MS_BY_COUNT[effective]
      scopeKind = 'final_word'
    } else {
      strength = VOWEL_EXTEND_STRENGTH_BY_COUNT[effective]; durationHint = VOWEL_EXTEND_DURATION_MS_BY_COUNT[effective]
      scopeKind = 'final_vowel'
    }

    const host = collectHost(nodeIndex)
    const hostRange: ExprRange = host.length > 0
      ? rangeOf(host[0].src, host[host.length - 1].src + 1)
      : rangeOf(p.startIdx, p.startIdx)

    let hostEnd = host.length
    while (hostEnd > 0 && isWhitespace(host[hostEnd - 1].ch)) hostEnd -= 1

    let scopeRange: ExprRange
    let vowelExtend: VowelExtendInfo | null = null
    if (hostEnd === 0) {
      scopeRange = rangeOf(p.startIdx, p.startIdx)
      pushDiag({ code: 'PROSODY_WITHOUT_HOST', severity: 'warning', reason: kind, uiOffsetUtf16: range.startUtf16 })
      if (kind === 'vowel_extend') {
        vowelExtend = { supported: false, targetVowel: null, degradedReason: 'no_preceding_text' }
        pushDiag({
          code: 'UNSUPPORTED_VOWEL_EXTEND', severity: 'warning',
          reason: 'no_preceding_text', uiOffsetUtf16: range.startUtf16,
        })
      }
    } else {
      let from: number
      if (scopeKind === 'final_vowel') {
        from = hostEnd - 1
      } else if (scopeKind === 'final_syllables') {
        from = hostEnd - Math.min(LOCAL_PROSODY_TAIL_SYLLABLES, hostEnd)
      } else if (scopeKind === 'latter_half') {
        from = hostEnd - Math.floor((hostEnd + 1) / 2)
      } else {
        from = hostEnd
        while (from > 0 && !isWhitespace(host[from - 1].ch)) from -= 1
      }
      scopeRange = rangeOf(host[from].src, host[hostEnd - 1].src + 1)
      if (kind === 'vowel_extend') {
        vowelExtend = resolveVowelExtend(host[hostEnd - 1].ch)
        if (!vowelExtend.supported) {
          pushDiag({
            code: 'UNSUPPORTED_VOWEL_EXTEND', severity: 'warning',
            reason: vowelExtend.degradedReason ?? 'no_preceding_vowel', uiOffsetUtf16: range.startUtf16,
          })
        }
      }
    }

    return {
      kind, sourceRange: range, strength, durationHint, rawToken, rawCount,
      effectiveCount: effective, capped: clamped.capped, scopeKind, scopeRange, hostRange,
      isChunkBoundary: LOCAL_PROSODY_IS_CHUNK_BOUNDARY, extraPauseMs: 0, vowelExtend,
      nodeIndex, lineIndex: p.lineIndex,
    }
  }

  for (const p of pending) {
    const nodeIndex = nodes.length
    const range = rangeOf(p.startIdx, p.endIdx)
    const rawToken = sliceOf(p.startIdx, p.endIdx)
    if (p.kind === 'text') {
      nodes.push({ kind: 'text', rawToken, range, lineIndex: p.lineIndex, text: p.text ?? '' })
      nodeTextSrc.push(p.textSrc ?? [])
      continue
    }
    if (p.kind === 'lineBreak') {
      nodes.push({ kind: 'lineBreak', rawToken, range, lineIndex: p.lineIndex })
      nodeTextSrc.push(null)
      continue
    }
    if (p.kind === 'emotionTransition') {
      const cls = p.payload as Extract<BracketClass, { type: 'emotion' }>
      const eventIndex = emotionTransitions.length
      emotionTransitions.push({
        targetEmotion: cls.id,
        targetEmotionLabel: cls.name,
        sourceOffset: offsetOf(p.startIdx),
        sourceRange: range,
        transitionMode: cls.mode,
        transitionStrength: EMOTION_TRANSITION_DEFAULT_STRENGTH,
        transitionDurationHint: cls.mode === 'immediate' ? EMOTION_IMMEDIATE_DURATION_MS : EMOTION_BLEND_DURATION_MS,
        extraPauseMs: EMOTION_TRANSITION_EXTRA_PAUSE_MS,
        isChunkBoundary: EMOTION_TRANSITION_IS_CHUNK_BOUNDARY,
        explicitMode: cls.explicitMode,
        rawToken, nodeIndex, lineIndex: p.lineIndex,
      })
      nodes.push({ kind: 'emotionTransition', rawToken, range, lineIndex: p.lineIndex, eventIndex })
      nodeTextSrc.push(null)
      continue
    }
    if (p.kind === 'explicitPause') {
      const cls = p.payload as Extract<BracketClass, { type: 'pause' }>
      const eventIndex = explicitPauses.length
      explicitPauses.push({ pauseMs: cls.ms, rawToken, sourceRange: range, nodeIndex, lineIndex: p.lineIndex })
      nodes.push({ kind: 'explicitPause', rawToken, range, lineIndex: p.lineIndex, eventIndex })
      nodeTextSrc.push(null)
      continue
    }
    if (p.kind === 'nonverbalLaugh') {
      const cls = p.payload as Extract<BracketClass, { type: 'laugh' }>
      const clamped = clampCount(cls.repeat, LAUGH_REPEAT_MIN_COUNT, LAUGH_REPEAT_MAX_COUNT)
      const eventIndex = laughs.length
      laughs.push({
        style: cls.style,
        intensity: LAUGH_INTENSITY_BY_REPEAT[clamped.effective],
        brightness: LAUGH_BRIGHTNESS_BY_REPEAT[clamped.effective],
        durationHint: LAUGH_DURATION_MS_BY_REPEAT[clamped.effective],
        position: 'standalone', // 아래에서 확정
        rawToken,
        rawRepeatCount: cls.repeat,
        effectiveRepeatCount: clamped.effective,
        capped: clamped.capped,
        sourceRange: range,
        isChunkBoundary: false,
        nodeIndex, lineIndex: p.lineIndex,
      })
      nodes.push({ kind: 'nonverbalLaugh', rawToken, range, lineIndex: p.lineIndex, eventIndex })
      nodeTextSrc.push(null)
      continue
    }
    // localProsody
    const pay = p.payload as { runFamily: RunFamily; run: string }
    const eventIndex = localProsody.length
    localProsody.push(buildLocalProsody(pay, p, nodeIndex, range, rawToken))
    nodes.push({ kind: 'localProsody', rawToken, range, lineIndex: p.lineIndex, eventIndex })
    nodeTextSrc.push(null)
  }

  // ── 웃음 position 확정 ──
  const speechBefore: boolean[] = new Array(nodes.length).fill(false)
  const speechAfter: boolean[] = new Array(nodes.length).fill(false)
  {
    let cur = false
    for (let k = 0; k < nodes.length; k++) {
      speechBefore[k] = cur
      const nd = nodes[k]
      if (nd.kind === 'lineBreak') cur = false
      else if (nd.kind === 'text') { if (hasNonWhitespace(nd.text)) cur = true }
      else if (nd.kind === 'localProsody') cur = true
    }
    let curA = false
    for (let k = nodes.length - 1; k >= 0; k--) {
      speechAfter[k] = curA
      const nd = nodes[k]
      if (nd.kind === 'lineBreak') curA = false
      else if (nd.kind === 'text') { if (hasNonWhitespace(nd.text)) curA = true }
      else if (nd.kind === 'localProsody') curA = true
    }
  }
  for (const lg of laughs) {
    const b = speechBefore[lg.nodeIndex]
    const a = speechAfter[lg.nodeIndex]
    lg.position = b && a ? 'inline' : b ? 'trailing' : a ? 'leading' : 'standalone'
  }

  // ── 경계 결정(우선순위 고정, 합산 금지) ──
  const boundaries: ExpressiveBoundary[] = []
  {
    const consumedLineBreak = new Set<number>()
    for (const pz of explicitPauses) {
      const adjacent = findAdjacentLineBreak(nodes, pz.nodeIndex)
      const candidates: ExpressiveBoundaryKind[] = ['explicitPause']
      const suppressed: ExpressiveBoundaryKind[] = []
      if (adjacent >= 0) {
        consumedLineBreak.add(adjacent)
        candidates.push('sentenceGap')
        suppressed.push('sentenceGap')
      }
      boundaries.push({
        kind: 'explicitPause', candidates, suppressed, pauseMs: pz.pauseMs,
        sourceOffset: { utf16: pz.sourceRange.startUtf16, codepoint: pz.sourceRange.startCodepoint },
        lineIndex: pz.lineIndex,
      })
    }
    for (let k = 0; k < nodes.length; k++) {
      const nd = nodes[k]
      if (nd.kind !== 'lineBreak' || consumedLineBreak.has(k)) continue
      boundaries.push({
        kind: 'sentenceGap', candidates: ['sentenceGap'], suppressed: [],
        pauseMs: null, // 런타임 config(ttsSilenceGap) 소관 — 파서가 정하지 않는다
        sourceOffset: { utf16: nd.range.startUtf16, codepoint: nd.range.startCodepoint },
        lineIndex: nd.lineIndex,
      })
    }
    boundaries.sort((x, y) => x.sourceOffset.codepoint - y.sourceOffset.codepoint)
    // final tail — 파일 전체의 맨 끝에서 정확히 1회.
    boundaries.push({
      kind: 'finalTail', candidates: ['finalTail'], suppressed: [], pauseMs: null,
      sourceOffset: offsetOf(n), lineIndex,
    })
  }

  if (errors.length > 0) return { ok: false, mode, effectiveVersion, errors }

  // ── 파생 텍스트 ──
  let verbatimText = ''
  let plainText = ''
  for (const nd of nodes) {
    if (nd.kind === 'text') { verbatimText += nd.text; plainText += nd.text }
    else if (nd.kind === 'lineBreak') { verbatimText += '\n'; plainText += '\n' }
    else if (nd.kind === 'localProsody') { verbatimText += nd.rawToken }
  }

  const usedEmotionIds: string[] = []
  const seen = new Set<string>()
  for (const et of emotionTransitions) {
    if (et.targetEmotion !== 'default' && !seen.has(et.targetEmotion)) {
      seen.add(et.targetEmotion)
      usedEmotionIds.push(et.targetEmotion)
    }
  }

  let totalExplicitPauseMs = 0
  for (const pz of explicitPauses) totalExplicitPauseMs += pz.pauseMs
  let degradedVowelExtendCount = 0
  let cappedTokenCount = 0
  for (const lp of localProsody) {
    if (lp.vowelExtend != null && !lp.vowelExtend.supported) degradedVowelExtendCount += 1
    if (lp.capped) cappedTokenCount += 1
  }
  for (const lg of laughs) if (lg.capped) cappedTokenCount += 1

  const lineCount = nodes.length === 0 ? 0 : lineIndex + 1

  const fullSha256 = computeExpressiveSha256(
    mode, effectiveVersion, nodes, emotionTransitions, localProsody, laughs,
    explicitPauses, boundaries, diagnostics, verbatimText, plainText,
  )

  const summary: ExpressiveSummary = {
    contractVersion: EXPRESSIVE_CONTRACT_VERSION,
    mode,
    effectiveVersion,
    nodeCount: nodes.length,
    lineCount,
    emotionTransitionCount: emotionTransitions.length,
    localProsodyCount: localProsody.length,
    laughCount: laughs.length,
    explicitPauseCount: explicitPauses.length,
    totalExplicitPauseMs,
    usedEmotionIds,
    degradedVowelExtendCount,
    cappedTokenCount,
    sha8: fullSha256.slice(0, 8),
  }

  const timeline: ExpressiveTimeline = {
    contractVersion: EXPRESSIVE_CONTRACT_VERSION,
    legacyPlanVersion: EXPRESSIVE_LEGACY_PLAN_VERSION,
    mode,
    effectiveVersion,
    expressiveEnabled: v3,
    hasExpressiveEvents: localProsody.length > 0 || laughs.length > 0,
    nodes, emotionTransitions, localProsody, laughs, explicitPauses, boundaries, diagnostics,
    verbatimText, plainText, summary, fullSha256,
  }
  return { ok: true, mode, effectiveVersion, timeline }
}

function hasNonWhitespace(s: string): boolean {
  for (const ch of s) if (!isWhitespace(ch)) return true
  return false
}

/** explicit pause 노드 기준으로, 사이에 공백 텍스트만 두고 인접한 lineBreak 노드 index(없으면 -1). */
function findAdjacentLineBreak(nodes: ExpressiveNode[], pauseNodeIndex: number): number {
  for (let k = pauseNodeIndex + 1; k < nodes.length; k++) {
    const nd = nodes[k]
    if (nd.kind === 'lineBreak') return k
    if (nd.kind === 'text' && !hasNonWhitespace(nd.text)) continue
    break
  }
  for (let k = pauseNodeIndex - 1; k >= 0; k--) {
    const nd = nodes[k]
    if (nd.kind === 'lineBreak') return k
    if (nd.kind === 'text' && !hasNonWhitespace(nd.text)) continue
    break
  }
  return -1
}

/** '~' 의 최종 모음 판정. 확정 불가면 degraded — 자음/전체 발화를 늘이는 폴백은 금지. */
export function resolveVowelExtend(lastChar: string): VowelExtendInfo {
  const cp = lastChar.codePointAt(0)
  if (cp == null) return { supported: false, targetVowel: null, degradedReason: 'no_preceding_text' }
  if (cp >= 0xac00 && cp <= 0xd7a3) {
    const idx = cp - 0xac00
    const jong = idx % 28
    if (jong !== 0) return { supported: false, targetVowel: null, degradedReason: 'final_consonant' }
    const jung = Math.floor(idx / 28) % 21
    return { supported: true, targetVowel: HANGUL_JUNGSEONG[jung], degradedReason: null }
  }
  if (Object.prototype.hasOwnProperty.call(KANA_VOWEL_MAP, lastChar)) {
    return { supported: true, targetVowel: KANA_VOWEL_MAP[lastChar], degradedReason: null }
  }
  const isLatin = (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)
  if (isLatin) {
    const lower = lastChar.toLowerCase()
    if ('aeiou'.indexOf(lower) >= 0) return { supported: true, targetVowel: lower, degradedReason: null }
    return { supported: false, targetVowel: null, degradedReason: 'final_consonant' }
  }
  // 그 밖의 CJK/자모/가나 등 — 발음 사전 없이는 모음 위치를 확정할 수 없다.
  const isKana = cp >= 0x3040 && cp <= 0x30ff
  const isHan = (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)
  const isJamo = (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)
  if (isKana || isHan || isJamo) return { supported: false, targetVowel: null, degradedReason: 'unsupported_script' }
  return { supported: false, targetVowel: null, degradedReason: 'no_preceding_vowel' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 원문 무손실 round-trip
// ─────────────────────────────────────────────────────────────────────────────

/** 노드 rawToken 을 순서대로 이어붙여 원문을 복원한다. */
export function reconstructSource(timeline: ExpressiveTimeline): string {
  let out = ''
  for (const nd of timeline.nodes) out += nd.rawToken
  return out
}

export interface RoundTripReport {
  ok: boolean
  reconstructed: string
  /** 노드 range 가 빈틈/중복 없이 [0, len) 을 덮는가. */
  contiguous: boolean
}

/** 원문 무손실 검증: 복원 문자열 일치 + range 연속성. */
export function verifyRoundTrip(raw: string, timeline: ExpressiveTimeline): RoundTripReport {
  const reconstructed = reconstructSource(timeline)
  let cursorCp = 0
  let cursorU16 = 0
  let contiguous = true
  for (const nd of timeline.nodes) {
    if (nd.range.startCodepoint !== cursorCp || nd.range.startUtf16 !== cursorU16) { contiguous = false; break }
    cursorCp = nd.range.endCodepoint
    cursorU16 = nd.range.endUtf16
  }
  const src = raw ?? ''
  if (contiguous && (cursorCp !== Array.from(src).length || cursorU16 !== src.length)) contiguous = false
  return { ok: reconstructed === src && contiguous, reconstructed, contiguous }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. canonical 직렬화 + 해시 (TS/Python 동일 알고리즘, 정수만)
// ─────────────────────────────────────────────────────────────────────────────

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

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function textDigest(s: string): { bytes: number; sha256: string } {
  const b = utf8Bytes(s)
  return { bytes: b.length, sha256: expressiveSha256Hex(b) }
}

function computeExpressiveSha256(
  mode: ExpressiveMode,
  effectiveVersion: 2 | 3,
  nodes: ExpressiveNode[],
  emotionTransitions: EmotionTransitionEvent[],
  localProsody: LocalProsodyEvent[],
  laughs: NonverbalLaughEvent[],
  explicitPauses: ExplicitPauseEvent[],
  boundaries: ExpressiveBoundary[],
  diagnostics: ExpressiveDiagnostic[],
  verbatimText: string,
  plainText: string,
): string {
  const canonNodes: CanonValue[] = nodes.map((nd, i) => {
    const d = textDigest(nd.rawToken)
    return {
      i, kind: nd.kind, line_index: nd.lineIndex,
      start_cp: nd.range.startCodepoint, end_cp: nd.range.endCodepoint,
      start_u16: nd.range.startUtf16, end_u16: nd.range.endUtf16,
      raw_bytes: d.bytes, raw_sha256: d.sha256,
    }
  })
  const canonEmotions: CanonValue[] = emotionTransitions.map((e, i) => ({
    i, node_index: e.nodeIndex, target_emotion: e.targetEmotion, mode: e.transitionMode,
    strength: e.transitionStrength, duration_hint: e.transitionDurationHint,
    extra_pause_ms: e.extraPauseMs, is_chunk_boundary: e.isChunkBoundary, explicit_mode: e.explicitMode,
    start_cp: e.sourceRange.startCodepoint, end_cp: e.sourceRange.endCodepoint,
  }))
  const canonProsody: CanonValue[] = localProsody.map((e, i) => ({
    i, node_index: e.nodeIndex, kind: e.kind, strength: e.strength, duration_hint: e.durationHint,
    raw_count: e.rawCount, effective_count: e.effectiveCount, capped: e.capped,
    scope_kind: e.scopeKind, scope_start_cp: e.scopeRange.startCodepoint, scope_end_cp: e.scopeRange.endCodepoint,
    host_start_cp: e.hostRange.startCodepoint, host_end_cp: e.hostRange.endCodepoint,
    start_cp: e.sourceRange.startCodepoint, end_cp: e.sourceRange.endCodepoint,
    extra_pause_ms: e.extraPauseMs, is_chunk_boundary: e.isChunkBoundary,
    vowel_supported: e.vowelExtend == null ? null : e.vowelExtend.supported,
    vowel_target: e.vowelExtend == null ? null : e.vowelExtend.targetVowel,
    vowel_reason: e.vowelExtend == null ? null : e.vowelExtend.degradedReason,
  }))
  const canonLaughs: CanonValue[] = laughs.map((e, i) => ({
    i, node_index: e.nodeIndex, style: e.style, intensity: e.intensity, brightness: e.brightness,
    duration_hint: e.durationHint, position: e.position, raw_repeat: e.rawRepeatCount,
    effective_repeat: e.effectiveRepeatCount, capped: e.capped,
    start_cp: e.sourceRange.startCodepoint, end_cp: e.sourceRange.endCodepoint,
  }))
  const canonPauses: CanonValue[] = explicitPauses.map((e, i) => ({
    i, node_index: e.nodeIndex, pause_ms: e.pauseMs,
    start_cp: e.sourceRange.startCodepoint, end_cp: e.sourceRange.endCodepoint,
  }))
  const canonBoundaries: CanonValue[] = boundaries.map((b, i) => ({
    i, kind: b.kind, candidates: b.candidates.slice(), suppressed: b.suppressed.slice(),
    pause_ms: b.pauseMs, offset_cp: b.sourceOffset.codepoint, line_index: b.lineIndex,
  }))
  const canonDiags: CanonValue[] = diagnostics.map((d, i) => ({
    i, code: d.code, severity: d.severity, reason: d.reason ?? null, offset_u16: d.uiOffsetUtf16,
  }))
  const vd = textDigest(verbatimText)
  const pd = textDigest(plainText)
  const canonObj: CanonValue = {
    contract_version: EXPRESSIVE_CONTRACT_VERSION,
    legacy_plan_version: EXPRESSIVE_LEGACY_PLAN_VERSION,
    mode,
    effective_version: effectiveVersion,
    node_count: nodes.length,
    nodes: canonNodes,
    emotion_transitions: canonEmotions,
    local_prosody: canonProsody,
    laughs: canonLaughs,
    explicit_pauses: canonPauses,
    boundaries: canonBoundaries,
    diagnostics: canonDiags,
    verbatim_bytes: vd.bytes, verbatim_sha256: vd.sha256,
    plain_bytes: pd.bytes, plain_sha256: pd.sha256,
  }
  return expressiveSha256Hex(utf8Bytes(canonicalize(canonObj)))
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. 모드 플래그 영속 계약 (store/session.json · buildTtsConfig payload · result metadata)
//
//  ⚠️ 세 곳 모두 '같은 필드 이름·같은 타입·같은 값'이어야 한다.
//     필드 이름은 EXPRESSIVE_MODE_FIELD 하나뿐이며, 메타데이터의 snake_case 관습보다
//     '세 캐리어가 문자 그대로 비교 가능한 것'을 우선한다(요구사항).
//  ⚠️ 필드가 없으면 언제나 legacy_v2. 본문 내용은 절대 이 값을 바꾸지 않는다.
//  ⚠️ 값이 있는데 계약 밖이면 조용히 기본값으로 넘어가지 말고 EXPRESSIVE_MODE_INVALID 로 실패시킨다
//     (resolve 결과의 mode 는 안전한 legacy_v2 로 채워지지만 valid=false 이다).
// ─────────────────────────────────────────────────────────────────────────────

/** store/session.json · TtsConfig payload · result metadata 가 공통으로 쓰는 유일한 필드 이름. */
export const EXPRESSIVE_MODE_FIELD = 'ttsExpressiveMode' as const
export type ExpressiveModeField = typeof EXPRESSIVE_MODE_FIELD

/** 이 값을 실어야 하는 세 캐리어. */
export const EXPRESSIVE_MODE_CARRIERS = ['session', 'config', 'metadata'] as const
export type ExpressiveModeCarrier = typeof EXPRESSIVE_MODE_CARRIERS[number]

export const EXPRESSIVE_MODE_CARRIER_PAIRS = [
  'session_vs_config', 'session_vs_metadata', 'config_vs_metadata',
] as const
export type ExpressiveModeCarrierPair = typeof EXPRESSIVE_MODE_CARRIER_PAIRS[number]

/** preset 은 절대 이 플래그를 바꾸지 않는다(계약). */
export const EXPRESSIVE_MODE_PRESET_MAY_CHANGE = false

export const EXPRESSIVE_MODE_SOURCES = ['absent', 'explicit', 'invalid'] as const
export type ExpressiveModeSource = typeof EXPRESSIVE_MODE_SOURCES[number]

export interface ExpressiveModeResolution {
  /** 실제로 써야 하는 모드. invalid 여도 '안전한' legacy_v2 로 채워진다(우발적 v3 승격 금지). */
  mode: ExpressiveMode
  source: ExpressiveModeSource
  valid: boolean
  /** invalid 일 때만 non-null. */
  errorCode: ExpressiveErrorCode | null
  /** invalid 일 때 원문 값의 타입 이름만(대사/민감정보 아님). */
  rawType: string | null
}

/**
 * 있을 수도 없을 수도 있는 플래그 값 → 모드. 세 캐리어 모두 이 함수 하나만 쓴다
 * (기본값을 세 군데서 각자 정하다가 어긋나는 일을 구조적으로 막는다).
 * - undefined / null  → absent → EXPRESSIVE_DEFAULT_MODE('legacy_v2'), valid
 * - 'legacy_v2' | 'expressive_v3' → explicit, valid
 * - 그 밖의 모든 값(''· boolean · 숫자 · 'v3' 등) → invalid(mode 는 legacy_v2, valid=false)
 */
export function resolveExpressiveMode(value: unknown): ExpressiveModeResolution {
  if (value === undefined || value === null) {
    return { mode: EXPRESSIVE_DEFAULT_MODE, source: 'absent', valid: true, errorCode: null, rawType: null }
  }
  if (typeof value === 'string' && (EXPRESSIVE_MODES as readonly string[]).includes(value)) {
    return { mode: value as ExpressiveMode, source: 'explicit', valid: true, errorCode: null, rawType: 'string' }
  }
  return {
    mode: EXPRESSIVE_DEFAULT_MODE, source: 'invalid', valid: false,
    errorCode: 'EXPRESSIVE_MODE_INVALID', rawType: typeof value,
  }
}

/** 캐리어 객체(session/config/metadata 어느 것이든)에서 EXPRESSIVE_MODE_FIELD 를 읽어 모드로 해석. */
export function readExpressiveMode(carrier: Record<string, unknown> | null | undefined): ExpressiveModeResolution {
  if (carrier == null) {
    return { mode: EXPRESSIVE_DEFAULT_MODE, source: 'absent', valid: true, errorCode: null, rawType: null }
  }
  if (!Object.prototype.hasOwnProperty.call(carrier, EXPRESSIVE_MODE_FIELD)) {
    return { mode: EXPRESSIVE_DEFAULT_MODE, source: 'absent', valid: true, errorCode: null, rawType: null }
  }
  return resolveExpressiveMode(carrier[EXPRESSIVE_MODE_FIELD])
}

/** 캐리어 객체에 모드를 기록한 '새 객체'를 돌려준다(round-trip 의 쓰기 쪽). */
export function writeExpressiveMode<T extends Record<string, unknown>>(carrier: T, mode: ExpressiveMode): T {
  return { ...carrier, [EXPRESSIVE_MODE_FIELD]: mode }
}

/**
 * preset 적용 헬퍼 — preset 이 이 플래그를 조용히 바꾸지 못하게 한다.
 * base 의 값(없으면 없음 그대로)을 반드시 유지한다.
 */
export function applyPresetPreservingExpressiveMode<T extends Record<string, unknown>>(
  base: T, preset: Record<string, unknown>,
): T {
  const merged: Record<string, unknown> = { ...base, ...preset }
  if (Object.prototype.hasOwnProperty.call(base, EXPRESSIVE_MODE_FIELD)) {
    merged[EXPRESSIVE_MODE_FIELD] = base[EXPRESSIVE_MODE_FIELD]
  } else {
    delete merged[EXPRESSIVE_MODE_FIELD]
  }
  return merged as T
}

export interface ExpressiveModeCarrierMismatch {
  pair: ExpressiveModeCarrierPair
  left: ExpressiveMode
  right: ExpressiveMode
}

export interface ExpressiveModeCarrierReport {
  ok: boolean
  /** 세 캐리어가 모두 유효하고 일치할 때만 non-null. */
  mode: ExpressiveMode | null
  resolved: Record<ExpressiveModeCarrier, ExpressiveModeResolution>
  invalidCarriers: ExpressiveModeCarrier[]
  mismatches: ExpressiveModeCarrierMismatch[]
  /** INVALID 가 있으면 EXPRESSIVE_MODE_INVALID, 아니면 불일치 시 EXPRESSIVE_MODE_CARRIER_MISMATCH. */
  errorCode: ExpressiveErrorCode | null
}

/**
 * store/session.json · config payload · result metadata 세 곳의 모드가 같은지 검증한다.
 * 통합 담당은 이 결과가 ok 가 아니면 '조용히 진행하지 말고' errorCode 로 크게 실패시킨다.
 */
export function assertExpressiveModeCarriers(
  session: Record<string, unknown> | null | undefined,
  config: Record<string, unknown> | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): ExpressiveModeCarrierReport {
  const resolved: Record<ExpressiveModeCarrier, ExpressiveModeResolution> = {
    session: readExpressiveMode(session),
    config: readExpressiveMode(config),
    metadata: readExpressiveMode(metadata),
  }
  const invalidCarriers: ExpressiveModeCarrier[] = []
  for (const c of EXPRESSIVE_MODE_CARRIERS) if (!resolved[c].valid) invalidCarriers.push(c)

  const mismatches: ExpressiveModeCarrierMismatch[] = []
  const pairs: Array<[ExpressiveModeCarrierPair, ExpressiveModeCarrier, ExpressiveModeCarrier]> = [
    ['session_vs_config', 'session', 'config'],
    ['session_vs_metadata', 'session', 'metadata'],
    ['config_vs_metadata', 'config', 'metadata'],
  ]
  for (const [pair, a, b] of pairs) {
    if (resolved[a].mode !== resolved[b].mode) {
      mismatches.push({ pair, left: resolved[a].mode, right: resolved[b].mode })
    }
  }
  const errorCode: ExpressiveErrorCode | null =
    invalidCarriers.length > 0 ? 'EXPRESSIVE_MODE_INVALID'
      : mismatches.length > 0 ? 'EXPRESSIVE_MODE_CARRIER_MISMATCH'
        : null
  const ok = errorCode === null
  return { ok, mode: ok ? resolved.session.mode : null, resolved, invalidCarriers, mismatches, errorCode }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. SHA-256 (ttsGrammar.ts sha256Hex 의 거울 — 값 동일성은 테스트가 보장)
// ─────────────────────────────────────────────────────────────────────────────

export function expressiveSha256Hex(input: Uint8Array): string {
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
