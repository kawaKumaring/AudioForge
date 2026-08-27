// 감정 샘플러(Emotion Sampler) 공용 순수 모듈 — 캐시 키 · 상태 기계 · 표준 문구 세트.
//
// ⚠️ '감정 샘플러'는 '감정 참조 등록'과 다른 기능이다. 혼동 금지:
//   · 감정 참조 등록(EmotionReferenceManager): 감정마다 **별도 참조 클립을 등록**한다.
//     상태는 전용 목소리 등록됨 / 등록 필요 / 기본 목소리 사용. 등록물은 합성 입력으로 영속 사용된다.
//   · 감정 샘플러(이 모듈): **기본(default) 참조 목소리 하나**로 감정별 표준 문구를 미리 합성해
//     "내 목소리로 [기쁨]은 어떻게 들리나?"를 대사 작성 전에 들어보게 한다.
//     결과물은 **일회성 미리듣기 샘플**이며 절대 감정 참조로 등록되지 않는다(등록 경로 없음).
//
// 순수성 계약: fs / Electron / React / IPC / 네트워크 의존 없음. 값 import 없음(레포 규약 —
// node --test 가 로더 없이 type-strip 해 바로 실행할 수 있어야 한다). 타입 import 도 쓰지 않는다.
// 비민감 계약: 절대경로 · 참조 전사문 · 합성 프롬프트 문자열을 상태 객체 / 캐시 키 입력 / 표시 문자열에
// 절대 넣지 않는다. 표준 문구 자체도 키 입력과 표시 문자열에서 제외하고 '버전 번호'만 흐른다.
//
// Python 거울: python/emotion_sampler.py (같은 상수 · 같은 canonical 직렬화 · 같은 상태/사유 코드).
// 양쪽 테스트가 서로의 소스를 파싱해 parity 를 강제한다(레포의 parity-by-parsing 선례를 따름).

// ─────────────────────────────────────────────────────────────────────────────
// 1) 버전 상수
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 캐시 키 '형식' 버전. 직렬화 구조를 바꾸면 올린다(기존 키 전부 무효화).
 * v2: 목소리 입력을 경로 기반 지문(path|size|mtimeMs)에서 **참조 라이브러리의 콘텐츠 SHA-256**으로 교체.
 * v3: 표현 이벤트(expression.kind)와 세기(expression.strength)를 키에 추가.
 */
export const EMOTION_SAMPLER_KEY_VERSION = 3

/**
 * 표준 문구/이벤트 세트 버전. 문구나 행 카탈로그가 바뀌면 반드시 올린다 → 캐시 샘플 전부 무효화.
 * v2: 표현 프로소디 언어 계약 소비로 전환(스크립트가 계약 토큰으로 조립됨) + 구두점/웃음 행 추가.
 */
export const EMOTION_SAMPLER_PHRASE_VERSION = 2

// ─────────────────────────────────────────────────────────────────────────────
// 2) 표준 문구 세트(버전 있는 상수)
//    짧고 중립적이며 감정색이 없는 문장만. 모든 감정이 **같은 문구**를 쓴다 → 감정 차이만 귀에 남는다.
//    ⚠️ 이 문자열들은 화면에 렌더하지 않는다(계약 6: 프롬프트 문자열 표시 금지). 버전만 표시한다.
// ─────────────────────────────────────────────────────────────────────────────

export const EMOTION_SAMPLER_PHRASES: readonly string[] = Object.freeze([
  '안녕하세요.',
  '잠시 후에 다시 말씀드리겠습니다.',
])

/**
 * 구두점·웃음 행이 얹히는 호스트 문구(v2 추가). 최종 음절 '요'는 종성이 없어
 * '~'(vowel_extend)가 계약상 open_vowel 로 분류된다 — 분류 판정은 계약 파서가 한다.
 */
export const EMOTION_SAMPLER_EXPRESSION_HOST = '그럼 이제 시작할게요'

/** 감정 baseline 문구 세트를 대본 한 줄로 결합(공백 하나). Python `phrase_script()`와 동일. */
export function emotionSamplerPhraseScript(): string {
  return EMOTION_SAMPLER_PHRASES.join(' ')
}

/**
 * 문구 세트 지문 = sha256(canonical({phrase_version, phrases})).
 * 아래 EMOTION_SAMPLER_PHRASE_SET_SHA256 과 단위테스트가 대조한다 —
 * 문구를 바꾸면 이 테스트가 먼저 깨지고, 통과시키려면 PHRASE_VERSION 을 올리고 상수를 갱신해야 한다.
 */
export function emotionSamplerPhraseSetDigest(): string {
  return samplerSha256Hex(canonicalize({
    host: EMOTION_SAMPLER_EXPRESSION_HOST,
    phrase_version: EMOTION_SAMPLER_PHRASE_VERSION,
    phrases: EMOTION_SAMPLER_PHRASES.slice(),
    rows: EMOTION_SAMPLE_ROWS.map((r) => `${r.rowId}:${r.family}:${r.expectKind}`),
  }))
}

/** 현재 문구 세트(버전 포함)의 고정 지문. 문구 변경 시 PHRASE_VERSION 을 올리고 함께 갱신할 것. */
export const EMOTION_SAMPLER_PHRASE_SET_SHA256 =
  '54b752e341268b6d5446378197ad127f9655ddf8a203dab9ee4eb0d2557c468a'

// ─────────────────────────────────────────────────────────────────────────────
// 3) 상태 / 사유 코드 — 조용한 무표시 금지. 실패·강등은 각각 '이름 있는' 상태다.
// ─────────────────────────────────────────────────────────────────────────────

export const EMOTION_SAMPLE_STATES = [
  'idle',          // 미생성
  'generating',    // 생성 중
  'ready',         // 재생 가능(정상)
  'degraded',      // 재생 가능하지만 x-vector-only 로 강등되어 만들어짐
  'limitExceeded', // 생성 한도 초과 → 결과 폐기(재생 불가)
  'failed',        // 생성 실패 + 사유
  'unsupported',   // 엔진 capability 가 '못 한다'고 판정 — 생성 시도 자체를 막는다
  'unverified',    // capability 가 프로브로 확인되지 않음(unknown) — '됨'으로 표시하지 않는다
] as const
export type EmotionSampleState = typeof EMOTION_SAMPLE_STATES[number]

export const EMOTION_SAMPLE_STATE_LABEL: Readonly<Record<EmotionSampleState, string>> = Object.freeze({
  idle: '미생성',
  generating: '생성 중',
  ready: '재생 가능',
  degraded: '재생 가능(음색만 반영)',
  limitExceeded: '생성 한도 초과',
  failed: '실패',
  unsupported: '지원 안 됨',
  unverified: '미검증',
})

export const EMOTION_SAMPLE_REASON_CODES = [
  'SAMPLER_XVECTOR_ONLY',      // degraded 전용 — 참조 전사 없이(x-vector-only) 생성됨
  'SAMPLER_GENERATION_LIMIT',  // limitExceeded 전용 — 생성 반복 상한 도달, 결과 폐기
  'SAMPLER_ENGINE_ERROR',      // failed — 합성 엔진/브리지 오류
  'SAMPLER_REFERENCE_MISSING', // failed — 기본 참조 목소리 없음/사라짐
  'SAMPLER_CANCELLED',         // failed — 사용자가 중단
  'SAMPLER_UNKNOWN',           // failed — 분류되지 않은 오류(조용한 무표시 대신 이 코드를 쓴다)
  // ↓ 엔진 capability 계약(python/expressive_capability.py · expressive_planner.py)의 코드를
  //   **그대로** 쓴다. 병렬 어휘를 만들지 않기 위해서다. 그 모듈은 아직 이 브랜치에 병합되지 않았으므로
  //   parity 테스트로 대조할 수 없다 — 병합되면 드리프트 가드를 추가할 것.
  'LAUGH_NO_STRATEGY',           // unsupported — 웃음 전략 A~D 전부 불가
  'VOWEL_EXTEND_NOT_REALIZABLE', // unsupported — 받침 계열: 자음 늘이기/반복 금지라 실현 경로 없음
  'CAPABILITY_UNVERIFIED',       // unverified — 실제 엔진 프로브 없이는 판정 불가(성공 아님)
] as const
export type EmotionSampleReasonCode = typeof EMOTION_SAMPLE_REASON_CODES[number]

export const EMOTION_SAMPLE_REASON_LABEL: Readonly<Record<EmotionSampleReasonCode, string>> = Object.freeze({
  SAMPLER_XVECTOR_ONLY: '참조 전사 없이 생성되어 음색만 반영되었습니다',
  SAMPLER_GENERATION_LIMIT: '생성 한도에 도달해 결과를 버렸습니다',
  SAMPLER_ENGINE_ERROR: '합성 엔진 오류',
  SAMPLER_REFERENCE_MISSING: '기본 목소리를 찾을 수 없습니다',
  SAMPLER_CANCELLED: '사용자가 중단했습니다',
  SAMPLER_UNKNOWN: '알 수 없는 오류',
  LAUGH_NO_STRATEGY: '이 엔진에는 웃음을 만드는 방법이 아직 없습니다',
  VOWEL_EXTEND_NOT_REALIZABLE: '받침이 있어 늘일 수 없습니다(자음을 반복하는 방식은 금지)',
  CAPABILITY_UNVERIFIED: '엔진이 실제로 해낼 수 있는지 아직 확인되지 않았습니다',
})

/** 상태별로 허용되는 사유 코드(교차 오염 방지 — 상태와 사유는 1:N 고정). */
export const EMOTION_SAMPLE_STATE_REASONS: Readonly<Record<EmotionSampleState, readonly EmotionSampleReasonCode[]>> =
  Object.freeze({
    idle: Object.freeze([]) as readonly EmotionSampleReasonCode[],
    generating: Object.freeze([]) as readonly EmotionSampleReasonCode[],
    ready: Object.freeze([]) as readonly EmotionSampleReasonCode[],
    degraded: Object.freeze(['SAMPLER_XVECTOR_ONLY']) as readonly EmotionSampleReasonCode[],
    limitExceeded: Object.freeze(['SAMPLER_GENERATION_LIMIT']) as readonly EmotionSampleReasonCode[],
    failed: Object.freeze([
      'SAMPLER_ENGINE_ERROR', 'SAMPLER_REFERENCE_MISSING', 'SAMPLER_CANCELLED', 'SAMPLER_UNKNOWN',
    ]) as readonly EmotionSampleReasonCode[],
    unsupported: Object.freeze([
      'LAUGH_NO_STRATEGY', 'VOWEL_EXTEND_NOT_REALIZABLE',
    ]) as readonly EmotionSampleReasonCode[],
    unverified: Object.freeze(['CAPABILITY_UNVERIFIED']) as readonly EmotionSampleReasonCode[],
  })

/** 입력 검증 실패 코드(문자열 prefix 추론 금지 — Python 과 공유). */
export const EMOTION_SAMPLER_INPUT_ERROR_CODES = [
  'SAMPLER_PATH_LIKE_VALUE',           // 경로처럼 보이는 값이 키/상태에 들어오려 함
  'SAMPLER_TEXT_LIKE_VALUE',           // 문장/전사문처럼 보이는 값(공백·비ASCII)이 들어오려 함
  'SAMPLER_INVALID_VOICE_CONTENT_SHA256',
  'SAMPLER_INVALID_ENGINE_ID',
  'SAMPLER_INVALID_MODEL_ID',
  'SAMPLER_INVALID_EMOTION_ID',
  'SAMPLER_INVALID_CONFIG',
  'SAMPLER_INVALID_CACHE_KEY',
  'SAMPLER_INVALID_ROW_ID',      // 카탈로그에 없는 샘플 행 id
  'SAMPLER_INVALID_EXPRESSION',  // expression 축(kind/strength) 형식 위반
  'SAMPLER_EXPRESSION_MISSING',  // 계약 타임라인에 이 행이 기대한 이벤트가 없음
] as const
export type EmotionSamplerInputErrorCode = typeof EMOTION_SAMPLER_INPUT_ERROR_CODES[number]

export class EmotionSamplerInputError extends Error {
  readonly code: EmotionSamplerInputErrorCode
  readonly field: string
  constructor(code: EmotionSamplerInputErrorCode, field: string) {
    // ⚠️ 위반한 '값'은 메시지에 넣지 않는다(경로·전사문이 로그로 새는 통로가 된다). 코드 + 필드명만.
    super(`${code} (field=${field})`)
    this.name = 'EmotionSamplerInputError'
    this.code = code
    this.field = field
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 합성 설정(키에 들어가는 부분만)
//    샘플은 '감정 하나 · 표준 문구 한 줄'이므로 줄 경계/감정 전환 경계 설정은 결과에 영향이 없다 →
//    ttsSilenceGap / ttsEmotionBoundary* 는 의도적으로 키에서 제외한다(과도한 캐시 무효화 방지).
// ─────────────────────────────────────────────────────────────────────────────

export type EmotionSamplerTailMode = 'off' | 'auto'

export interface EmotionSamplerSynthConfig {
  /** 말 속도 배율. 0.5 ~ 2.0. 키에는 ×1000 정수(speed_milli)로 들어간다. */
  speed: number
  /** 음높이(반음). -2.0 ~ 2.0. 키에는 ×100 정수(pitch_centi)로 들어간다. */
  pitch: number
  tailMode: EmotionSamplerTailMode
  /** 0 ~ 300 정수 ms. */
  tailPaddingMs: number
  /** 0 ~ 20 정수 ms. */
  tailFadeMs: number
}

export const EMOTION_SAMPLER_DEFAULT_CONFIG: Readonly<EmotionSamplerSynthConfig> = Object.freeze({
  speed: 1.0,
  pitch: 0.0,
  tailMode: 'auto' as EmotionSamplerTailMode,
  tailPaddingMs: 120,
  tailFadeMs: 8,
})

const SPEED_MIN = 0.5
const SPEED_MAX = 2.0
const PITCH_MIN = -2.0
const PITCH_MAX = 2.0
const TAIL_PADDING_MIN = 0
const TAIL_PADDING_MAX = 300
const TAIL_FADE_MIN = 0
const TAIL_FADE_MAX = 20

// ─────────────────────────────────────────────────────────────────────────────
// 5) 비민감 값 가드 — 경로/문장이 키·상태에 들어오는 것을 '조용히'가 아니라 예외로 막는다.
// ─────────────────────────────────────────────────────────────────────────────

/** 경로처럼 보이는가: 구분자 / 드라이브 문자 / 상위참조 / 홈 단축 / URL 스킴 / 파일 확장자. */
export function looksPathLike(v: string): boolean {
  if (v.includes('/') || v.includes('\\')) return true
  if (v.includes(':')) return true            // C: · file: · http:
  if (v.startsWith('~')) return true
  if (v.includes('..')) return true
  return /\.(wav|mp3|flac|ogg|m4a|json|txt|srt|py|ts|tsx)$/i.test(v)
}

/** 문장/전사문처럼 보이는가: 공백을 포함하거나 비 ASCII(한글·CJK 등)를 포함. */
export function looksTextLike(v: string): boolean {
  if (/\s/.test(v)) return true
  for (const ch of v) if ((ch.codePointAt(0) as number) > 0x7f) return true
  return false
}

/** 캐시 키 입력 · 상태 객체에 들어갈 수 있는 값인지 검사(위반 시 예외 — 조용한 통과 없음). */
export function assertSamplerSafeValue(field: string, v: string): void {
  if (looksPathLike(v)) throw new EmotionSamplerInputError('SAMPLER_PATH_LIKE_VALUE', field)
  if (looksTextLike(v)) throw new EmotionSamplerInputError('SAMPLER_TEXT_LIKE_VALUE', field)
}

const HEX64_RE = /^[0-9a-f]{64}$/
const ID_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const EMOTION_ID_RE = /^[a-z]{2,32}$/

// ⚠️ 목소리 입력의 권위는 **참조 라이브러리가 만든 콘텐츠 SHA-256** 하나뿐이다.
//    이 모듈은 그 값을 '주입받은 불투명 문자열'로만 소비한다 — 직접 해싱하지 않고, 대체 지문을 만들지 않는다.
//    main 의 audio:fingerprint-reference(`path|size|mtimeMs`)는 경로 기반이라 캐시 권위가 될 수 없다.
//    결과: 같은 내용의 파일은 경로가 달라져도 같은 키(캐시 재사용), 내용이 바뀌면 이름·크기가 같아도 다른 키.

// ─────────────────────────────────────────────────────────────────────────────
// 6) 캐시 키 — canonical 직렬화(TS/Python 바이트 동일) → sha256 hex 64자.
//
//    canonical 규칙(ttsGrammar D-7 과 동일): object key 알파벳 정렬 · 배열 순서 유지 · 공백 없음 ·
//    문자열 JSON escape · **정수만**(float 금지) · null 은 null.
//
//    직렬화 형태(줄바꿈/공백은 실제로는 없음. 아래는 가독성용):
//      {"config":{"pitch_centi":<int>,"speed_milli":<int>,"tail_fade_ms":<int>,
//                 "tail_mode":"<off|auto>","tail_padding_ms":<int>},
//       "engine_id":"<token>",
//       "expression":{"family":"<family>","kind":"<contract kind>","row_id":"<row>","strength":<0..100>},
//       "key_version":<int>,"model_id":"<token>","phrase_version":<int>,
//       "voice_content_sha256":"<64hex>"}
//    cache_key = sha256_hex(utf8(위 문자열))
// ─────────────────────────────────────────────────────────────────────────────

export interface EmotionSampleKeyInput {
  /**
   * 기본 참조 목소리 **파일 내용**의 SHA-256(64 hex, 소문자). 참조 라이브러리가 산출해 주입한다.
   * 경로·크기·mtime 은 입력이 아니다 — 파일을 옮겨도 키가 그대로여야 하고, 내용이 바뀌면 키가 달라져야 한다.
   */
  voiceContentSha256: string
  /** 엔진 식별자(예: 'qwen'). 슬래시·콜론·공백 불가. */
  engineId: string
  /** 모델 식별자(예: 'qwen3-omni-flash'). 슬래시·콜론·공백 불가 → 필요하면 통합 담당이 slug 화. */
  modelId: string
  /**
   * 표현 이벤트 축 — 계약 타임라인에서 뽑은 값(emotionSampleExpressionFromTimeline).
   * 감정·구두점·웃음이 모두 여기로 들어온다. 세기는 계약이 정한 0..100 정수다.
   */
  expression: EmotionSampleExpression
  config: EmotionSamplerSynthConfig
}

/** 음수 대칭 반올림(half away from zero). JS Math.round(-0.5)=−0 / Python banker's rounding 과 갈리지 않도록 직접 구현. */
function quantize(value: number, scale: number, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_CONFIG', field)
  }
  if (value < min || value > max) throw new EmotionSamplerInputError('SAMPLER_INVALID_CONFIG', field)
  const scaled = value * scale
  const sign = scaled < 0 ? -1 : 1
  const q = sign * Math.floor(Math.abs(scaled) + 0.5)
  return q === 0 ? 0 : q  // -0 정규화
}

function requireInt(value: number, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_CONFIG', field)
  }
  if (value < min || value > max) throw new EmotionSamplerInputError('SAMPLER_INVALID_CONFIG', field)
  return value
}

function validatedString(v: unknown, field: string, code: EmotionSamplerInputErrorCode): string {
  if (typeof v !== 'string' || v.length === 0) throw new EmotionSamplerInputError(code, field)
  assertSamplerSafeValue(field, v)
  return v
}

/** 감정 태그 id 검증. 배열/객체를 넘기면 여기서 즉시 실패한다(대량 생성 진입점이 생길 수 없다). */
export function assertEmotionSampleTag(emotionId: unknown): string {
  const s = validatedString(emotionId, 'emotionId', 'SAMPLER_INVALID_EMOTION_ID')
  if (!EMOTION_ID_RE.test(s)) throw new EmotionSamplerInputError('SAMPLER_INVALID_EMOTION_ID', 'emotionId')
  return s
}

/** 캐시 키 형식 검증(상태 객체에 들어가는 키). */
export function assertEmotionSampleCacheKey(cacheKey: unknown): string {
  if (typeof cacheKey !== 'string' || !HEX64_RE.test(cacheKey)) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_CACHE_KEY', 'cacheKey')
  }
  return cacheKey
}

/**
 * canonical 직렬화 문자열 산출(버전을 명시 지정 — 마이그레이션/테스트가 옛 버전 키를 재현할 수 있게).
 * 일반 호출은 canonicalEmotionSampleKeyPayload 를 쓴다.
 */
export function canonicalEmotionSampleKeyPayloadAt(
  input: EmotionSampleKeyInput,
  phraseVersion: number,
  keyVersion: number
): string {
  if (!input || typeof input !== 'object') throw new EmotionSamplerInputError('SAMPLER_INVALID_CONFIG', 'input')

  const voiceContentSha256 = validatedString(input.voiceContentSha256, 'voiceContentSha256', 'SAMPLER_INVALID_VOICE_CONTENT_SHA256')
  if (!HEX64_RE.test(voiceContentSha256)) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_VOICE_CONTENT_SHA256', 'voiceContentSha256')
  }
  const engineId = validatedString(input.engineId, 'engineId', 'SAMPLER_INVALID_ENGINE_ID')
  if (!ID_TOKEN_RE.test(engineId) || engineId.length > 64) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_ENGINE_ID', 'engineId')
  }
  const modelId = validatedString(input.modelId, 'modelId', 'SAMPLER_INVALID_MODEL_ID')
  if (!ID_TOKEN_RE.test(modelId) || modelId.length > 128) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_MODEL_ID', 'modelId')
  }
  const expr = input.expression
  if (!expr || typeof expr !== 'object') {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_EXPRESSION', 'expression')
  }
  const exprRowId = assertEmotionSampleRowId(expr.rowId)
  const exprFamily = validatedString(expr.family, 'expression.family', 'SAMPLER_INVALID_EXPRESSION')
  if (!(EMOTION_SAMPLE_FAMILIES as readonly string[]).includes(exprFamily)) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_EXPRESSION', 'expression.family')
  }
  const exprKind = validatedString(expr.kind, 'expression.kind', 'SAMPLER_INVALID_EXPRESSION')
  if (!/^[a-zA-Z][a-zA-Z_]{1,31}$/.test(exprKind)) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_EXPRESSION', 'expression.kind')
  }
  const exprStrength = expr.strength
  if (typeof exprStrength !== 'number' || !Number.isInteger(exprStrength)
      || exprStrength < 0 || exprStrength > 100) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_EXPRESSION', 'expression.strength')
  }

  const cfg = input.config
  if (!cfg || typeof cfg !== 'object') throw new EmotionSamplerInputError('SAMPLER_INVALID_CONFIG', 'config')
  if (cfg.tailMode !== 'off' && cfg.tailMode !== 'auto') {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_CONFIG', 'config.tailMode')
  }

  if (!Number.isInteger(phraseVersion) || phraseVersion < 0) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_CONFIG', 'phraseVersion')
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 0) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_CONFIG', 'keyVersion')
  }

  return canonicalize({
    config: {
      pitch_centi: quantize(cfg.pitch, 100, 'config.pitch', PITCH_MIN, PITCH_MAX),
      speed_milli: quantize(cfg.speed, 1000, 'config.speed', SPEED_MIN, SPEED_MAX),
      tail_fade_ms: requireInt(cfg.tailFadeMs, 'config.tailFadeMs', TAIL_FADE_MIN, TAIL_FADE_MAX),
      tail_mode: cfg.tailMode,
      tail_padding_ms: requireInt(cfg.tailPaddingMs, 'config.tailPaddingMs', TAIL_PADDING_MIN, TAIL_PADDING_MAX),
    },
    engine_id: engineId,
    expression: {
      family: exprFamily,
      kind: exprKind,
      row_id: exprRowId,
      strength: exprStrength,
    },
    key_version: keyVersion,
    model_id: modelId,
    phrase_version: phraseVersion,
    voice_content_sha256: voiceContentSha256,
  })
}

/** 현재 버전 상수로 canonical 직렬화 문자열 산출. */
export function canonicalEmotionSampleKeyPayload(input: EmotionSampleKeyInput): string {
  return canonicalEmotionSampleKeyPayloadAt(input, EMOTION_SAMPLER_PHRASE_VERSION, EMOTION_SAMPLER_KEY_VERSION)
}

/** 버전을 명시 지정한 캐시 키(마이그레이션/테스트용). */
export function buildEmotionSampleCacheKeyAt(
  input: EmotionSampleKeyInput,
  phraseVersion: number,
  keyVersion: number
): string {
  return samplerSha256Hex(canonicalEmotionSampleKeyPayloadAt(input, phraseVersion, keyVersion))
}

/**
 * 감정 **하나**에 대한 캐시 키(64 hex). 같은 키 → 반드시 재사용, 재생성 금지.
 * 감정 목록을 받지 않는다 — 대량 생성 진입점은 이 모듈 어디에도 없다(계약 1).
 */
export function buildEmotionSampleCacheKey(input: EmotionSampleKeyInput): string {
  return buildEmotionSampleCacheKeyAt(input, EMOTION_SAMPLER_PHRASE_VERSION, EMOTION_SAMPLER_KEY_VERSION)
}

// ── parity 고정 벡터: TS/Python 이 같은 입력에 바이트 동일한 payload · 동일 key 를 내는지 대조. ──
export const EMOTION_SAMPLER_PARITY_INPUT: Readonly<EmotionSampleKeyInput> = Object.freeze({
  voiceContentSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  engineId: 'qwen',
  modelId: 'qwen3-omni-flash',
  expression: Object.freeze({
    family: 'emotion' as EmotionSampleFamily,
    rowId: 'emotion_happy',
    kind: 'emotionTransition',
    strength: 100,
  }),
  config: Object.freeze({
    speed: 1.05,
    pitch: -0.5,
    tailMode: 'auto' as EmotionSamplerTailMode,
    tailPaddingMs: 120,
    tailFadeMs: 8,
  }),
})
export const EMOTION_SAMPLER_PARITY_PAYLOAD = '{"config":{"pitch_centi":-50,"speed_milli":1050,"tail_fade_ms":8,"tail_mode":"auto","tail_padding_ms":120},"engine_id":"qwen","expression":{"family":"emotion","kind":"emotionTransition","row_id":"emotion_happy","strength":100},"key_version":3,"model_id":"qwen3-omni-flash","phrase_version":2,"voice_content_sha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}'
export const EMOTION_SAMPLER_PARITY_KEY = 'd99546c21090dfde7f47416c60b87a51ec1beb4400c02814be7b809b1826d087'

// ─────────────────────────────────────────────────────────────────────────────
// 7) 상태 기계 — 자동 재시도 없음. 거부는 '이유 코드'로 드러난다(조용한 무시 금지).
// ─────────────────────────────────────────────────────────────────────────────

export interface EmotionSampleEntry {
  /** 샘플 행 id(감정·구두점·웃음 공통). 카탈로그 EMOTION_SAMPLE_ROWS 의 rowId. */
  rowId: string
  state: EmotionSampleState
  /** 실패/강등 사유. idle/generating/ready 는 항상 null. */
  reason: EmotionSampleReasonCode | null
  /** 이 항목이 대응하는 캐시 키(64 hex). 파일 경로는 담지 않는다 — 경로 해석은 셸의 몫. */
  cacheKey: string
}

export type EmotionSamplerEvent =
  | { type: 'GENERATE_REQUESTED' }
  | { type: 'GENERATE_SUCCEEDED'; degraded?: boolean }
  | { type: 'GENERATE_FAILED'; reason: EmotionSampleReasonCode }
  | { type: 'GENERATE_LIMIT_EXCEEDED' }
  | { type: 'CACHE_HIT'; degraded?: boolean }
  | { type: 'DELETED' }
  /** 목소리/엔진/모델/설정이 바뀌어 캐시 키가 달라졌다 → 미생성으로 복귀. */
  | { type: 'KEY_CHANGED'; cacheKey: string }

export const EMOTION_SAMPLER_REJECTION_CODES = [
  'ALREADY_GENERATING',    // 생성 중 재요청
  'CACHED_SAMPLE_EXISTS',  // 유효 캐시가 있어 재생성 불가(계약 2: 같은 키 → 재사용)
  'NO_SAMPLE_TO_DELETE',   // 지울 샘플이 없음
  'CAPABILITY_NOT_USABLE', // 엔진이 못 하거나(unsupported) 확인되지 않아(unverified) 생성 불가
  'INVALID_EVENT',         // 이 상태에서 정의되지 않은 이벤트
] as const
export type EmotionSamplerRejectionCode = typeof EMOTION_SAMPLER_REJECTION_CODES[number]

export interface EmotionSamplerTransition {
  entry: EmotionSampleEntry
  applied: boolean
  /** applied===false 일 때만 non-null (불변식: applied === (rejected === null)). */
  rejected: EmotionSamplerRejectionCode | null
}

export function initialEmotionSampleEntry(
  rowId: string,
  cacheKey: string,
  capability?: EmotionSampleCapability
): EmotionSampleEntry {
  const id = assertEmotionSampleRowId(rowId)
  const cap = capability ?? capabilityForRow(id)
  // 엔진이 못 하거나 확인되지 않은 행은 '미생성'으로 시작하지 않는다 — 그러면 '만들면 된다'는 거짓말이 된다.
  const state = stateForCapability(cap)
  return {
    rowId: id,
    state,
    reason: state === 'idle' ? null : cap.reason,
    cacheKey: assertEmotionSampleCacheKey(cacheKey),
  }
}

/** 재생 가능한 캐시 샘플이 존재하는 상태인가. */
export function hasCachedSample(state: EmotionSampleState): boolean {
  return state === 'ready' || state === 'degraded'
}

/** 미리듣기 가능한가(= 캐시 샘플 존재). limitExceeded 는 결과를 버렸으므로 재생 불가. */
export function isAuditionable(state: EmotionSampleState): boolean {
  return hasCachedSample(state)
}

/** (재)생성이 가능한 상태인가. 유효 캐시가 있으면 false — 같은 키는 절대 재생성하지 않는다. */
export function canRegenerateEmotionSample(state: EmotionSampleState): boolean {
  return state === 'idle' || state === 'failed' || state === 'limitExceeded'
}

/**
 * 지울 것이 있는가 — **생성 권한과 분리된 판정**.
 *
 * 엔진이 못 하는(unsupported)/확인 안 된(unverified) 행도 과거 판정이 달랐던 시절의 샘플
 * 파일이 디스크에 남아 있을 수 있다. 그 파일을 화면에서 지울 길이 없으면 고아가 된다.
 * 그래서 '만들 수 있다'와 '지울 수 있다'를 따로 판정한다.
 *
 * cachedFileExists 는 셸이 **키로** 확인한 존재 여부(boolean)만 받는다 — 경로·내용은 받지 않는다.
 * 이 값이 true 라도 상태·사유·톤은 변하지 않는다(캐시가 있다는 사실이 '지원됨'으로 보이면 안 된다).
 */
export function canDeleteCachedSample(
  state: EmotionSampleState,
  cachedFileExists = false
): boolean {
  return hasCachedSample(state) || cachedFileExists === true
}

/**
 * 생성 버튼이 비활성인 이유 문구. 회색으로만 죽이지 않고 반드시 이 문장을 함께 렌더한다.
 * 활성이면 null.
 */
export function regenerateBlockedNotice(state: EmotionSampleState): string | null {
  if (state === 'generating') return '샘플을 만드는 중입니다.'
  if (state === 'ready') {
    return '같은 목소리·엔진·설정에서는 결과가 같아 다시 만들 수 없습니다. 목소리나 설정을 바꾸면 새로 만들 수 있습니다.'
  }
  if (state === 'degraded') {
    return '이미 만들어진 샘플이 있어 다시 만들 수 없습니다(결과가 같습니다). 참조 전사를 채우거나 설정을 바꾸면 새로 만들 수 있습니다.'
  }
  if (state === 'unsupported') {
    return '지금 엔진이 이 표현을 만들지 못합니다. 설정을 바꿔도 만들어지지 않습니다.'
  }
  if (state === 'unverified') {
    return '엔진이 이 표현을 해낼 수 있는지 아직 확인되지 않아 만들지 않습니다.'
  }
  return null
}

function entryWith(
  entry: EmotionSampleEntry,
  state: EmotionSampleState,
  reason: EmotionSampleReasonCode | null,
  cacheKey?: string
): EmotionSampleEntry {
  return {
    rowId: entry.rowId,
    state,
    reason,
    cacheKey: cacheKey === undefined ? entry.cacheKey : assertEmotionSampleCacheKey(cacheKey),
  }
}

function ok(entry: EmotionSampleEntry): EmotionSamplerTransition {
  return { entry, applied: true, rejected: null }
}
function reject(entry: EmotionSampleEntry, code: EmotionSamplerRejectionCode): EmotionSamplerTransition {
  return { entry, applied: false, rejected: code }
}

/**
 * 상태 전이(순수). 자동 재시도 · 자동 폴백 없음 — 실패는 실패 상태로 남고 사용자가 다시 누른다.
 * 거부된 전이는 rejected 코드로 드러난다(조용히 삼키지 않는다).
 */
export function applyEmotionSamplerEvent(
  entry: EmotionSampleEntry,
  event: EmotionSamplerEvent
): EmotionSamplerTransition {
  switch (event.type) {
    case 'GENERATE_REQUESTED': {
      if (entry.state === 'generating') return reject(entry, 'ALREADY_GENERATING')
      if (hasCachedSample(entry.state)) return reject(entry, 'CACHED_SAMPLE_EXISTS')
      // 엔진이 못 하는/확인 안 된 행은 눌러도 시작하지 않는다(가짜 진행 금지).
      if (entry.state === 'unsupported' || entry.state === 'unverified') {
        return reject(entry, 'CAPABILITY_NOT_USABLE')
      }
      return ok(entryWith(entry, 'generating', null))
    }
    case 'GENERATE_SUCCEEDED': {
      if (entry.state !== 'generating') return reject(entry, 'INVALID_EVENT')
      return event.degraded === true
        ? ok(entryWith(entry, 'degraded', 'SAMPLER_XVECTOR_ONLY'))
        : ok(entryWith(entry, 'ready', null))
    }
    case 'GENERATE_FAILED': {
      if (entry.state !== 'generating') return reject(entry, 'INVALID_EVENT')
      const allowed = EMOTION_SAMPLE_STATE_REASONS.failed
      const reason = allowed.includes(event.reason) ? event.reason : 'SAMPLER_UNKNOWN'
      return ok(entryWith(entry, 'failed', reason))
    }
    case 'GENERATE_LIMIT_EXCEEDED': {
      if (entry.state !== 'generating') return reject(entry, 'INVALID_EVENT')
      return ok(entryWith(entry, 'limitExceeded', 'SAMPLER_GENERATION_LIMIT'))
    }
    case 'CACHE_HIT': {
      if (entry.state === 'generating') return reject(entry, 'ALREADY_GENERATING')
      // 엔진이 못 하는(unsupported)/확인 안 된(unverified) 행은 캐시가 있어도 '재생 가능'으로
      // 올리지 않는다. 오래된 캐시 항목이 capability 판정을 덮어써 LAUGH_NO_STRATEGY 같은
      // 사유 코드를 지우고 '됨'으로 보이게 하는 통로였다 — 가짜 지원 금지.
      if (entry.state === 'unsupported' || entry.state === 'unverified') {
        return reject(entry, 'CAPABILITY_NOT_USABLE')
      }
      return event.degraded === true
        ? ok(entryWith(entry, 'degraded', 'SAMPLER_XVECTOR_ONLY'))
        : ok(entryWith(entry, 'ready', null))
    }
    case 'DELETED': {
      if (!hasCachedSample(entry.state)) return reject(entry, 'NO_SAMPLE_TO_DELETE')
      return ok(entryWith(entry, 'idle', null))
    }
    case 'KEY_CHANGED': {
      // 설정이 바뀌어도 엔진 능력은 그대로다 — 못 하던 행을 '미생성'으로 되돌리지 않는다.
      if (entry.state === 'unsupported' || entry.state === 'unverified') {
        return ok(entryWith(entry, entry.state, entry.reason, event.cacheKey))
      }
      return ok(entryWith(entry, 'idle', null, event.cacheKey))
    }
    default:
      return reject(entry, 'INVALID_EVENT')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8) 캐시 조회 — hit 이면 재사용(생성 호출 없음).
// ─────────────────────────────────────────────────────────────────────────────

/** 캐시 색인: 캐시 키 → 비민감 메타. **경로를 담지 않는다** — 셸이 키로 파일을 찾는다. */
export interface EmotionSampleCacheMeta { degraded: boolean }
export type EmotionSamplerCacheIndex = Readonly<Record<string, EmotionSampleCacheMeta>>

export interface EmotionSampleRequestPlan {
  /**
   * 'reuse'    = 캐시 재사용(합성 호출 금지)
   * 'generate' = 이 행 하나만 새로 합성
   * 'blocked'  = 엔진 capability 가 못 한다/확인 안 됐다 — 합성 호출 금지, 상태로 드러난다
   */
  action: 'reuse' | 'generate' | 'blocked'
  entry: EmotionSampleEntry
}

/**
 * 감정 **하나**에 대한 요청 해석. capability 가 쓸 수 있는 행에 한해, cacheIndex 에 키가 있으면
 * 반드시 'reuse' 를 돌려준다(재생성 없음). unsupported/unverified 는 캐시가 있어도 'blocked' 이며
 * 생성·재생 가능 상태로 승격되지 않는다.
 * 감정 배열을 받지 않는다 — 시그니처 자체가 대량 생성을 불가능하게 한다(계약 1).
 *
 * ⚠️ 엔진 capability 가 캐시보다 먼저다. 못 하는/확인 안 된 행은 캐시에 키가 남아 있어도
 *    'blocked' 이며 사유 코드(LAUGH_NO_STRATEGY 등)를 그대로 들고 나간다. 어느 경로에서도
 *    재생성은 일어나지 않으므로 계약 2(같은 키 → 재합성 금지)는 그대로 유지된다.
 */
export function resolveEmotionSampleRequest(
  rowId: string,
  cacheKey: string,
  cacheIndex: EmotionSamplerCacheIndex,
  capability?: EmotionSampleCapability
): EmotionSampleRequestPlan {
  const base = initialEmotionSampleEntry(rowId, cacheKey, capability)
  // 엔진이 못 하는/확인 안 된 행은 캐시가 있어도 없어도 '생성'을 계획하지 않고,
  // 캐시가 capability 판정을 덮어쓰지도 못한다(가짜 '재생 가능' 금지).
  if (base.state === 'unsupported' || base.state === 'unverified') {
    return { action: 'blocked', entry: base }
  }
  const hit = cacheIndex ? cacheIndex[cacheKey] : undefined
  if (hit) {
    const t = applyEmotionSamplerEvent(base, { type: 'CACHE_HIT', degraded: hit.degraded === true })
    return { action: 'reuse', entry: t.entry }
  }
  return { action: 'generate', entry: base }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9) 표시용 파생(패널이 그대로 렌더). 상태별로 반드시 서로 다른 문구가 나온다.
// ─────────────────────────────────────────────────────────────────────────────

export type EmotionSampleTone = 'neutral' | 'busy' | 'ok' | 'warn' | 'error'

export interface EmotionSampleView {
  rowId: string
  state: EmotionSampleState
  stateLabel: string
  reason: EmotionSampleReasonCode | null
  reasonLabel: string | null
  tone: EmotionSampleTone
  auditionEnabled: boolean
  generateEnabled: boolean
  generateLabel: string
  /** 생성 버튼이 비활성일 때의 설명(회색 처리만 하지 않는다). 활성이면 null. */
  generateNotice: string | null
  deleteEnabled: boolean
}

const TONE_BY_STATE: Readonly<Record<EmotionSampleState, EmotionSampleTone>> = Object.freeze({
  idle: 'neutral',
  generating: 'busy',
  ready: 'ok',
  degraded: 'warn',
  limitExceeded: 'error',
  failed: 'error',
  unsupported: 'error',
  unverified: 'warn',
})

/**
 * 패널이 소비하는 단일 파생 함수(표시 로직 분산 금지). 순수 — DOM/React 비의존.
 *
 * cachedFileExists: 셸이 캐시 키로 확인한 **샘플 파일 존재 여부**(boolean). 기본 false.
 *   true 여도 state/stateLabel/reason/tone/generateEnabled/auditionEnabled 는 전혀 바뀌지 않고
 *   deleteEnabled 하나만 열린다 — 남은 파일을 지울 수 있게 하되, 파일이 있다는 사실이
 *   '이 표현이 된다'로 오인되지 않게 하기 위해서다. 경로·내용은 받지도 내보내지도 않는다.
 */
export function describeEmotionSample(
  entry: EmotionSampleEntry,
  cachedFileExists = false
): EmotionSampleView {
  const state = entry.state
  const reason = entry.reason
  const canGen = canRegenerateEmotionSample(state)
  return {
    rowId: entry.rowId,
    state,
    stateLabel: EMOTION_SAMPLE_STATE_LABEL[state],
    reason,
    reasonLabel: reason ? EMOTION_SAMPLE_REASON_LABEL[reason] : null,
    tone: TONE_BY_STATE[state],
    auditionEnabled: isAuditionable(state),
    generateEnabled: canGen,
    generateLabel:
      state === 'generating' ? '만드는 중…'
        : state === 'idle' ? '샘플 만들기'
          : state === 'unsupported' ? '만들 수 없음'
            : state === 'unverified' ? '확인 전'
              : '다시 만들기',
    generateNotice: regenerateBlockedNotice(state),
    deleteEnabled: canDeleteCachedSample(state, cachedFileExists),
  }
}

/** 펼쳤을 때 상단에 고정으로 렌더 — 샘플러가 감정 참조 등록이 아님을 화면에서 못 박는다. */
export const EMOTION_SAMPLER_DISCLAIMER =
  '샘플은 기본 목소리로 만든 미리듣기 전용입니다. 감정 참조로 등록되지 않으며 합성 결과에 쓰이지 않습니다.'

/**
 * 접이식 섹션 제목. '감정 참조 등록'과 어휘가 겹치지 않게 고른 이름이다.
 * (코드/모듈 이름은 emotionSampler = 감정 샘플러 그대로 두고, 화면에 보이는 이름은 이것 하나로 통일한다.)
 */
export const EMOTION_SAMPLER_SECTION_TITLE = '감정·표현 미리듣기'

// ── 접힘 상태 요약(progressive disclosure) — 접혀 있을 때는 아래 수치'만' 보여준다. ──
// 상태 6개가 정확히 한 버킷에만 들어간다(중복 집계 없음):
//   generated  <- ready
//   generating <- generating
//   attention  <- degraded(음색만 반영) · limitExceeded(폐기됨) · failed
//   idle 은 어느 버킷에도 넣지 않는다 — '아직 아무것도 안 함'은 셀 거리가 아니다.
export const EMOTION_SAMPLE_SUMMARY_BUCKETS = ['generated', 'generating', 'attention'] as const
export type EmotionSampleSummaryBucket = typeof EMOTION_SAMPLE_SUMMARY_BUCKETS[number]

export const EMOTION_SAMPLE_SUMMARY_LABEL: Readonly<Record<EmotionSampleSummaryBucket, string>> = Object.freeze({
  generated: '만들어짐',
  generating: '만드는 중',
  attention: '확인 필요',
})

/** 모든 버킷이 0 일 때 대신 보여주는 문장(빈 수치 나열 금지). */
export const EMOTION_SAMPLE_SUMMARY_EMPTY = '아직 만든 미리듣기가 없습니다'

const SUMMARY_BUCKET_BY_STATE: Readonly<Record<EmotionSampleState, EmotionSampleSummaryBucket | null>> =
  Object.freeze({
    idle: null,
    generating: 'generating' as EmotionSampleSummaryBucket,
    ready: 'generated' as EmotionSampleSummaryBucket,
    degraded: 'attention' as EmotionSampleSummaryBucket,
    limitExceeded: 'attention' as EmotionSampleSummaryBucket,
    failed: 'attention' as EmotionSampleSummaryBucket,
    // 못 하는/확인 안 된 행도 '확인 필요' 로 묶는다 — 버킷을 늘리면 접힘 한 줄이 길어진다.
    unsupported: 'attention' as EmotionSampleSummaryBucket,
    unverified: 'attention' as EmotionSampleSummaryBucket,
  })

export interface EmotionSampleSummary {
  generated: number
  generating: number
  attention: number
  /** 접힘 상태에 렌더할 한 줄. 0 인 버킷은 빼고, 전부 0 이면 EMOTION_SAMPLE_SUMMARY_EMPTY. */
  text: string
}

/** 접힘 상태 요약(순수). 항목이 아무리 많아도 '수치 3개 + 한 줄'로 고정된다. */
export function summarizeEmotionSamples(entries: readonly EmotionSampleEntry[]): EmotionSampleSummary {
  const counts: Record<EmotionSampleSummaryBucket, number> = { generated: 0, generating: 0, attention: 0 }
  for (const e of entries) {
    const bucket = SUMMARY_BUCKET_BY_STATE[e.state]
    if (bucket) counts[bucket] += 1
  }
  const parts: string[] = []
  for (const b of EMOTION_SAMPLE_SUMMARY_BUCKETS) {
    if (counts[b] > 0) parts.push(`${EMOTION_SAMPLE_SUMMARY_LABEL[b]} ${counts[b]}`)
  }
  return { ...counts, text: parts.length > 0 ? parts.join(' · ') : EMOTION_SAMPLE_SUMMARY_EMPTY }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11) 표현 언어 계약 소비 — 행 카탈로그 · 대본 조립 · 표현 이벤트 키 축
//
// 권위는 src/shared/expressiveTimeline.ts(= python/expressive_timeline.py) 하나다.
// 이 모듈은 그 계약을 **소비**한다: 이벤트 종류/웃음 스타일/세기/분류를 재구현하지 않는다.
//   · 아래 카탈로그는 "어떤 토큰을 어떤 순서로 놓을지"만 선언한다(= 대본 조립 지시).
//   · 그 토큰이 실제로 어떤 이벤트/세기가 되는지는 **계약 파서가** 정한다.
//     단위테스트가 실제 parseExpressiveTimeline 을 돌려 expectKind/세기를 대조하므로,
//     계약이 바뀌면 여기가 조용히 어긋나지 않고 테스트가 먼저 깨진다.
//   · 값 import 를 하지 않는 이유는 레포 규약(node --test 가 로더 없이 type-strip) 때문이다.
//     타입은 import type 으로 가져오므로(런타임에 지워짐) 계약 타입은 그대로 쓴다.
// ─────────────────────────────────────────────────────────────────────────────

/** 샘플 행 갈래. 계약의 node/event 축과 1:1로 대응한다. */
export const EMOTION_SAMPLE_FAMILIES = ['emotion', 'emotionTransition', 'punctuation', 'laugh'] as const
export type EmotionSampleFamily = typeof EMOTION_SAMPLE_FAMILIES[number]

/** 대본 조립 지시 한 조각. 계약 토큰을 '어디에 놓을지'만 말한다. */
export type EmotionSampleScriptPart =
  /** 감정 태그 `[label]`. label 은 계약의 감정표에 있어야 한다(테스트가 대조). */
  | { part: 'emotionTag'; label: string }
  /** baseline 문구(EMOTION_SAMPLER_PHRASES) 전체를 한 줄로. */
  | { part: 'baselinePhrase' }
  /** baseline 문구 중 index 하나만. */
  | { part: 'baselinePhraseAt'; index: number }
  /** 구두점/웃음 행의 호스트 문구. */
  | { part: 'host' }
  /** 운율 토큰(계약이 분류한다). token 은 계약의 run 문자 집합에 속해야 한다(테스트가 대조). */
  | { part: 'prosodyToken'; token: string }
  /** 웃음 태그 `[ㅋㅋ]`. inner 는 계약의 웃음 style 패턴에 맞아야 한다(테스트가 대조). */
  | { part: 'laughTag'; inner: string }
  /** 공백 하나. */
  | { part: 'space' }

export interface EmotionSampleRowSpec {
  /** 행 식별자(안전 토큰). 캐시 키 · 상태 객체 · 콜백 인자로 흐르는 유일한 id. */
  rowId: string
  family: EmotionSampleFamily
  /** 화면 표시용 한글 이름. */
  label: string
  /** 대본 조립 지시. */
  parts: readonly EmotionSampleScriptPart[]
  /**
   * 계약 파서가 내야 하는 이벤트 종류.
   *   emotion/emotionTransition → 'emotionTransition'
   *   punctuation              → LocalProsodyKind ('emphasis'|'question_rise'|'shock_rise'|'fade_end'|'vowel_extend')
   *   laugh                    → LaughStyle ('chuckle'|'breathy'|'bashful'|'open'|'high_giggle')
   * ⚠️ 여기 적힌 문자열은 계약의 enum 값이다. 테스트가 계약 소스의 enum 집합과 대조해 드리프트를 막는다.
   */
  expectKind: string
}

/**
 * 샘플 행 카탈로그(v2). 사용자가 이 중에서 **하나씩** 골라 생성한다 — 일괄 생성 경로는 없다.
 *
 * 감정 4행 + 감정 전환 예시 1행은 **기존 baseline 그대로**를 만든다(비교 기준선 보존).
 * 구두점 5행 · 웃음 6행이 v2 에서 새로 붙는다.
 *
 * ⚠️ 감정 이름은 계약 감정표(EXPRESSIVE_EMOTION_LABEL_TO_ID)에 있는 것만 쓸 수 있다.
 *    요청받은 '분노'/'차분'은 그 표에 없어 각각 '화남'(angry)/'진지'(serious)로 잡았다.
 *    표에 없는 이름을 새로 만들면 감정 어휘가 tts_worker 와 어긋난다.
 */
export const EMOTION_SAMPLE_ROWS: readonly EmotionSampleRowSpec[] = Object.freeze<readonly EmotionSampleRowSpec[]>([
  // ── 감정 baseline(출력 문구 불변) ──
  { rowId: 'emotion_happy', family: 'emotion', label: '기쁨', expectKind: 'emotionTransition',
    parts: [{ part: 'emotionTag', label: '기쁨' }, { part: 'space' }, { part: 'baselinePhrase' }] },
  { rowId: 'emotion_sad', family: 'emotion', label: '슬픔', expectKind: 'emotionTransition',
    parts: [{ part: 'emotionTag', label: '슬픔' }, { part: 'space' }, { part: 'baselinePhrase' }] },
  { rowId: 'emotion_angry', family: 'emotion', label: '화남', expectKind: 'emotionTransition',
    parts: [{ part: 'emotionTag', label: '화남' }, { part: 'space' }, { part: 'baselinePhrase' }] },
  { rowId: 'emotion_serious', family: 'emotion', label: '진지', expectKind: 'emotionTransition',
    parts: [{ part: 'emotionTag', label: '진지' }, { part: 'space' }, { part: 'baselinePhrase' }] },

  // ── 감정 전환 예시: 한 사람이 말하는 도중 감정이 바뀐다(새 WAV 가 아니다) ──
  { rowId: 'emotion_transition_happy_sad', family: 'emotionTransition', label: '기쁨→슬픔 전환',
    expectKind: 'emotionTransition',
    parts: [
      { part: 'emotionTag', label: '기쁨' }, { part: 'space' }, { part: 'baselinePhraseAt', index: 0 },
      { part: 'space' }, { part: 'emotionTag', label: '슬픔' }, { part: 'space' },
      { part: 'baselinePhraseAt', index: 1 },
    ] },

  // ── 구두점(국소 운율) ──
  { rowId: 'punct_emphasis', family: 'punctuation', label: '! 강조', expectKind: 'emphasis',
    parts: [{ part: 'host' }, { part: 'prosodyToken', token: '!' }] },
  { rowId: 'punct_question_rise', family: 'punctuation', label: '? 올림', expectKind: 'question_rise',
    parts: [{ part: 'host' }, { part: 'prosodyToken', token: '?' }] },
  { rowId: 'punct_shock_rise', family: 'punctuation', label: '!? 놀람', expectKind: 'shock_rise',
    parts: [{ part: 'host' }, { part: 'prosodyToken', token: '!?' }] },
  { rowId: 'punct_fade_end', family: 'punctuation', label: '... 흐림', expectKind: 'fade_end',
    parts: [{ part: 'host' }, { part: 'prosodyToken', token: '...' }] },
  { rowId: 'punct_vowel_extend', family: 'punctuation', label: '~ 늘임', expectKind: 'vowel_extend',
    parts: [{ part: 'host' }, { part: 'prosodyToken', token: '~' }] },

  // ── 비언어 웃음 ──
  // 요청받은 이름은 6개인데 계약의 style 은 5개다. '밝은 웃음'은 새 style 이 아니라
  // **같은 chuckle 의 반복 수(밝기) 변형**으로 잡는다 — 계약에 없는 style 을 만들지 않기 위해서다.
  { rowId: 'laugh_chuckle', family: 'laugh', label: '피식 웃음', expectKind: 'chuckle',
    parts: [{ part: 'host' }, { part: 'space' }, { part: 'laughTag', inner: 'ㅋ' }] },
  { rowId: 'laugh_bright', family: 'laugh', label: '밝은 웃음', expectKind: 'chuckle',
    parts: [{ part: 'host' }, { part: 'space' }, { part: 'laughTag', inner: 'ㅋㅋㅋㅋㅋ' }] },
  { rowId: 'laugh_breathy', family: 'laugh', label: '숨 섞인 웃음', expectKind: 'breathy',
    parts: [{ part: 'host' }, { part: 'space' }, { part: 'laughTag', inner: 'ㅎㅎ' }] },
  { rowId: 'laugh_bashful', family: 'laugh', label: '수줍은 웃음', expectKind: 'bashful',
    parts: [{ part: 'host' }, { part: 'space' }, { part: 'laughTag', inner: '헤헤' }] },
  { rowId: 'laugh_open', family: 'laugh', label: '열린 웃음', expectKind: 'open',
    parts: [{ part: 'host' }, { part: 'space' }, { part: 'laughTag', inner: '호호' }] },
  { rowId: 'laugh_high_giggle', family: 'laugh', label: '장난스러운 웃음', expectKind: 'high_giggle',
    parts: [{ part: 'host' }, { part: 'space' }, { part: 'laughTag', inner: '히히' }] },
])

const ROW_BY_ID: ReadonlyMap<string, EmotionSampleRowSpec> =
  new Map(EMOTION_SAMPLE_ROWS.map((r) => [r.rowId, r]))

const ROW_ID_RE = /^[a-z][a-z0-9_]{1,47}$/

/** 행 id 검증. 배열/객체를 넘기면 즉시 실패한다(일괄 생성 진입점이 생길 수 없다). */
export function assertEmotionSampleRowId(rowId: unknown): string {
  const v = validatedString(rowId, 'rowId', 'SAMPLER_INVALID_ROW_ID')
  if (!ROW_ID_RE.test(v) || !ROW_BY_ID.has(v)) {
    throw new EmotionSamplerInputError('SAMPLER_INVALID_ROW_ID', 'rowId')
  }
  return v
}

export function emotionSampleRow(rowId: string): EmotionSampleRowSpec {
  return ROW_BY_ID.get(assertEmotionSampleRowId(rowId)) as EmotionSampleRowSpec
}

/**
 * 행 하나의 합성 대본을 **계약 토큰으로 조립**해서 돌려준다.
 *
 * ⚠️ 시그니처 변경: 이전 v1 은 buildEmotionSampleScript(emotionTagText: string) 로 '[감정]' 문자열을
 *    호출부에서 받아 단순 결합했다. 이제는 행 id 만 받고, 무엇을 어떻게 놓을지는 카탈로그가 정한다.
 *    (호출부가 태그 문자열을 만들 필요가 없어졌다.)
 * ⚠️ 반환값은 '프롬프트'다 — 상태 객체·캐시 키·화면·로그 어디에도 넣지 않는다(계약 6). 합성 인자 전용.
 * ⚠️ 이 문자열의 '의미'는 계약 파서가 정한다. 호출부는 parseExpressiveTimeline(script, {mode:'expressive_v3'})
 *    로 파싱해 타임라인을 얻고, 그 타임라인에서 캐시 키의 expression 축을 뽑는다.
 */
export function buildEmotionSampleScript(rowId: string): string {
  const row = emotionSampleRow(rowId)
  let out = ''
  for (const p of row.parts) {
    switch (p.part) {
      case 'emotionTag': out += `[${p.label}]`; break
      case 'baselinePhrase': out += emotionSamplerPhraseScript(); break
      case 'baselinePhraseAt': out += EMOTION_SAMPLER_PHRASES[p.index] ?? ''; break
      case 'host': out += EMOTION_SAMPLER_EXPRESSION_HOST; break
      case 'prosodyToken': out += p.token; break
      case 'laughTag': out += `[${p.inner}]`; break
      case 'space': out += ' '; break
      default: break
    }
  }
  return out
}

// ── 캐시 키의 표현 축 ────────────────────────────────────────────────────────

/** 캐시 키에 들어가는 표현 이벤트 축. 계약 타임라인에서 뽑아낸다(직접 분류하지 않는다). */
export interface EmotionSampleExpression {
  family: EmotionSampleFamily
  /** 행 id. 같은 kind/strength 를 쓰는 행들을 구분한다(예: emotion_happy vs emotion_sad). */
  rowId: string
  /** 계약이 낸 이벤트 종류(LocalProsodyKind | LaughStyle | 'emotionTransition'). */
  kind: string
  /** 계약이 낸 세기 0..100 정수(운율 strength / 웃음 intensity / 감정 transitionStrength). */
  strength: number
}

/**
 * 계약 타임라인에서 이 행의 표현 축을 뽑는다(순수, 타입만 의존).
 * 세기의 권위는 전적으로 계약이다 — 여기서 계산하지 않는다.
 * 이벤트가 여러 개면 **마지막 것**을 쓴다(감정 전환 행처럼 2개인 경우 결정적으로 하나만 고르기 위해).
 */
export function emotionSampleExpressionFromTimeline(
  rowId: string,
  timeline: ExpressiveTimelineLike
): EmotionSampleExpression {
  const row = emotionSampleRow(rowId)
  if (row.family === 'emotion' || row.family === 'emotionTransition') {
    const evs = timeline.emotionTransitions ?? []
    const last = evs[evs.length - 1]
    if (!last) throw new EmotionSamplerInputError('SAMPLER_EXPRESSION_MISSING', 'timeline')
    return { family: row.family, rowId: row.rowId, kind: 'emotionTransition', strength: last.transitionStrength }
  }
  if (row.family === 'punctuation') {
    const evs = timeline.localProsody ?? []
    const last = evs[evs.length - 1]
    if (!last) throw new EmotionSamplerInputError('SAMPLER_EXPRESSION_MISSING', 'timeline')
    return { family: row.family, rowId: row.rowId, kind: last.kind, strength: last.strength }
  }
  const evs = timeline.laughs ?? []
  const last = evs[evs.length - 1]
  if (!last) throw new EmotionSamplerInputError('SAMPLER_EXPRESSION_MISSING', 'timeline')
  return { family: row.family, rowId: row.rowId, kind: last.style, strength: last.intensity }
}

/** 계약 타임라인 중 이 모듈이 실제로 읽는 부분만(구조적 타이핑 — 계약 값 import 없이 소비). */
export interface ExpressiveTimelineLike {
  emotionTransitions?: readonly { transitionStrength: number }[]
  localProsody?: readonly { kind: string; strength: number }[]
  laughs?: readonly { style: string; intensity: number }[]
}

// ── 엔진 capability ──────────────────────────────────────────────────────────
//
// ⚠️ 권위는 엔진 capability 모듈(python/expressive_capability.py + expressive_planner.py)이다.
//    그 모듈은 이제 이 트리에 병합되어 있고, 어휘 드리프트는 test/fixtures/sampler-engine-parity.json
//    을 유일 권위로 삼는 양방향 parity 스위트(samplerEngineParity.test.ts / test_sampler_engine_parity.py)
//    가 고정한다. 아래 표는 여전히 그 계약의 '선언'을 옮겨 둔 기본값이며 프로브로 확인된 값이 아니다 —
//    실제 판정은 엔진 capability 를 override 로 주입해 얻어야 한다.
// ⚠️ capability 규칙(그 모듈의 규칙 1): 선언만으로는 절대 supported 가 되지 않는다.
//    프로브 증거가 없으면 'unknown' 이고, 'unknown' 은 성공이 아니다. usable 은 'supported' 뿐이다.

export const EMOTION_SAMPLER_CAPABILITY_STATES = ['supported', 'degraded', 'unsupported', 'unknown'] as const
export type EmotionSamplerCapabilityState = typeof EMOTION_SAMPLER_CAPABILITY_STATES[number]

export interface EmotionSampleCapability {
  state: EmotionSamplerCapabilityState
  /** unsupported/unknown 일 때의 엔진 코드. supported 면 null. */
  reason: EmotionSampleReasonCode | null
}

const CAP_OK: EmotionSampleCapability = Object.freeze({ state: 'supported' as const, reason: null })
const CAP_LAUGH: EmotionSampleCapability =
  Object.freeze({ state: 'unsupported' as const, reason: 'LAUGH_NO_STRATEGY' as const })
const CAP_UNVERIFIED: EmotionSampleCapability =
  Object.freeze({ state: 'unknown' as const, reason: 'CAPABILITY_UNVERIFIED' as const })

/**
 * 행별 기본 capability(엔진 선언 기준, 프로브 아님).
 *   · 웃음 6행 → unsupported / LAUGH_NO_STRATEGY (전략 A~D 전부 불가)
 *   · '~' 늘임 → 호스트 최종음이 open_vowel 이면 supported 후보지만, 엔진의
 *     vowel_extend_sustainable_final 기능은 프로브가 없어 unknown 이다. 받침이 붙는 순간
 *     VOWEL_EXTEND_NOT_REALIZABLE(unsupported)이 된다 — capabilityForVowelExtend() 참고.
 *   · 그 밖(감정/전환/구두점) → supported(기존 동작 보존)
 */
export const EMOTION_SAMPLE_DECLARED_CAPABILITY: Readonly<Record<string, EmotionSampleCapability>> =
  Object.freeze(Object.fromEntries(EMOTION_SAMPLE_ROWS.map((r) => {
    if (r.family === 'laugh') return [r.rowId, CAP_LAUGH]
    if (r.expectKind === 'vowel_extend') return [r.rowId, CAP_UNVERIFIED]
    return [r.rowId, CAP_OK]
  })))

/**
 * 계약의 '~' 최종음 분류 → capability 판정. 분류는 계약이, 판정은 엔진 규칙이 한다.
 *   open_vowel            → unknown(프로브 없음). 늘일 대상은 있으나 엔진이 해낸다는 증거가 없다.
 *   sustainable_final     → unknown(vowel_extend_sustainable_final 프로브 없음)
 *   non_sustainable_final → unsupported / VOWEL_EXTEND_NOT_REALIZABLE (자음 반복 금지 → 실현 경로 없음)
 *   undeterminable        → unknown
 * ⚠️ 어느 경우에도 'supported' 가 나오지 않는다 — 프로브 전까지 '됨'이라고 말하지 않는다.
 */
export function capabilityForVowelExtend(classification: string): EmotionSampleCapability {
  if (classification === 'non_sustainable_final') {
    return { state: 'unsupported', reason: 'VOWEL_EXTEND_NOT_REALIZABLE' }
  }
  return { state: 'unknown', reason: 'CAPABILITY_UNVERIFIED' }
}

/** 이 capability 로 실제 생성을 시도해도 되는가. 'supported' 만 true(unknown 은 성공이 아니다). */
export function isCapabilityUsable(state: EmotionSamplerCapabilityState): boolean {
  return state === 'supported'
}

/** capability → 초기 상태. 못 하거나 확인 안 된 것은 '미생성'이 아니라 각자의 이름 있는 상태로 시작한다. */
export function stateForCapability(cap: EmotionSampleCapability): EmotionSampleState {
  if (cap.state === 'supported') return 'idle'
  if (cap.state === 'unsupported') return 'unsupported'
  return 'unverified'
}

/** 행의 capability(주입 override 우선). override 는 엔진 capability 모듈이 병합되면 통합 담당이 넣는다. */
export function capabilityForRow(
  rowId: string,
  override?: Readonly<Record<string, EmotionSampleCapability>>
): EmotionSampleCapability {
  const id = assertEmotionSampleRowId(rowId)
  const o = override ? override[id] : undefined
  if (o) return o
  return EMOTION_SAMPLE_DECLARED_CAPABILITY[id]
}

// ─────────────────────────────────────────────────────────────────────────────
// 10) canonical 직렬화 + sha256 (ttsGrammar.ts 와 동일 알고리즘의 자립 사본).
//     ⚠️ 값 import 금지 규약 때문에 복사한다. 드리프트는 단위테스트가
//        ttsGrammar.sha256HexOfString 과 대조해 막는다.
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

/** 문자열 → sha256 hex(64자). 순수 JS(브라우저·node 동일, 의존성 없음). */
export function samplerSha256Hex(s: string): string {
  const input = utf8Bytes(s)
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
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])

  const l = input.length
  const bitLen = l * 8
  const withOne = l + 1
  const k = (56 - (withOne % 64) + 64) % 64
  const total = withOne + k + 8
  const msg = new Uint8Array(total)
  msg.set(input, 0)
  msg[l] = 0x80
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
