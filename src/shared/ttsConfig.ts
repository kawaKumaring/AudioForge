// TTS 1단계 전달용 설정 — separate.py로 넘길 TTS 필드의 단일 소스.
// 목적: 필드 누락(예: ttsEmotionRefs 미전달)을 컴파일 단계에서 잡는다.

// ── pitch 후처리 capability 계약(§6) — UI(음높이 슬라이더)가 소비. ──
// pitch 경로는 ffmpeg rubberband 단일(pitch_shift.py). rubberband 미지원 ffmpeg에서 pitch!=0을
// 요청하면 PITCH_UNAVAILABLE로 실패하므로, 지원 여부를 미리 UI에 알려 예방한다.
//   supported : pitch 후처리 사용 가능(rubberband 존재)
//   method    : 'rubberband' | 'none' | 'unknown'
//   probed    : 실제 ffmpeg probe가 수행됐는지(false=미배선 기본값 — 통합 담당이 실제 probe 연결)
//   reason    : 미지원/불명 사유(진단 표시용)
export interface PitchCapability {
  supported: boolean
  method: 'rubberband' | 'none' | 'unknown'
  probed: boolean
  reason?: string
}

// Python pitch_shift.pitch_available()의 (available, reason) → UI 계약으로 정규화(순수·mock 가능).
// raw 미지정/available null → 미probe(unknown). 실제 probe 결과 주입은 통합 담당이 배선한다.
export function normalizePitchCapability(raw?: { available?: boolean | null; reason?: string } | null): PitchCapability {
  if (!raw || raw.available == null) {
    return { supported: false, method: 'unknown', probed: false, reason: raw?.reason || 'probe 미수행' }
  }
  if (raw.available) return { supported: true, method: 'rubberband', probed: true, reason: raw.reason }
  return { supported: false, method: 'none', probed: true, reason: raw.reason || 'rubberband-unsupported' }
}

// ── 생성 안전장치 metadata(계약 A/B) — Python 필드명 그대로. result GUI가 소비. ──
export type TerminationReason = 'completed_before_limit' | 'generation_limit'
export interface GenerationChunk {
  original_segment_index: number
  chunk_index: number
  chunk_count: number
  production_tokens: number | null
  generation_limit: number | null
  generated_iterations: number | null
  termination_reason: TerminationReason
  emotion_id?: string | null
  // 진단 추가(가산) — 값이 없거나 검증에서 거절되면 null(= 'unavailable'). 절대 0으로 위조하지 않는다.
  // frames 는 Python 쪽에서 원래부터 조건부(concat layout 길이 일치 시에만 첨부)이므로 구 session이
  // 아닌 현행 버전 실행에서도 부재할 수 있다 — 그래서 이 자리는 항상 null 가능이다.
  frames: number | null
  output_sample_rate: number | null
}
export interface GenerationSummary {
  limit: number | null
  iters: number | null
  termination: TerminationReason | null
  chunks: GenerationChunk[]
}

// ── telemetry 값 검증기 — 'unavailable' = null 규약의 단일 소스. 분석 계층(generationTelemetry.ts)이
//    같은 규칙을 재사용하므로 파싱과 분석이 절대 어긋나지 않는다. 어떤 입력에도 throw하지 않는다
//    (세션 복원 중 나쁜 값 하나가 복원 전체를 깨뜨리면 안 된다).
// finiteNumber: NaN/Infinity/-Infinity/비수치 → null
export function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
// sampleRateOrNull: 0과 음수도 거절. 0을 통과시키면 duration이 Infinity가 되고, 결측을 0으로
// 위조하면 duration이 0초로 보인다 — 둘 다 조용히 틀린 분석이 된다.
export function sampleRateOrNull(v: unknown): number | null {
  const n = finiteNumber(v)
  return n != null && n > 0 ? n : null
}
// framesOrNull: 음수 거절. 0 프레임은 '빈 chunk'라는 실재 관측치이므로 유효값으로 통과시킨다
// (길이 0의 chunk는 production에서 _finalize_wav가 막지만, 복원된 구 데이터에는 있을 수 있다).
export function framesOrNull(v: unknown): number | null {
  const n = finiteNumber(v)
  return n != null && n >= 0 ? n : null
}

// result metadata에서 생성 안전장치 요약을 안전 추출. 비정상 배열 항목은 crash 없이 무시/정규화하고,
// 문장·전사·전체경로는 애초에 담기지 않는다(스키마상 없음). 기술 필드가 전혀 없으면(구 session) null.
export function parseGenerationSummary(metadata: Record<string, unknown> | null | undefined): GenerationSummary | null {
  if (!metadata || typeof metadata !== 'object') return null
  const limit = finiteNumber(metadata.generation_limit)
  const iters = finiteNumber(metadata.generated_iterations)
  const tr = metadata.termination_reason
  const termination: TerminationReason | null =
    (tr === 'completed_before_limit' || tr === 'generation_limit') ? tr : null
  const chunks: GenerationChunk[] = []
  const raw = metadata.generation_chunks
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue
      const o = c as Record<string, unknown>
      const osi = finiteNumber(o.original_segment_index)
      const ci = finiteNumber(o.chunk_index)
      const cc = finiteNumber(o.chunk_count)
      const t = o.termination_reason
      if (osi == null || ci == null || cc == null) continue                 // 필수 index/count 없으면 무시
      if (t !== 'completed_before_limit' && t !== 'generation_limit') continue
      chunks.push({
        original_segment_index: osi, chunk_index: ci, chunk_count: cc,
        production_tokens: finiteNumber(o.production_tokens),
        generation_limit: finiteNumber(o.generation_limit),
        generated_iterations: finiteNumber(o.generated_iterations),
        termination_reason: t,
        emotion_id: typeof o.emotion_id === 'string' ? o.emotion_id : null,
        frames: framesOrNull(o.frames),
        output_sample_rate: sampleRateOrNull(o.output_sample_rate),
      })
    }
  }
  if (limit == null && iters == null && termination == null && chunks.length === 0) return null
  return { limit, iters, termination, chunks }
}

// 참조별 사용자 프롬프트 항목(UI/스토어에서 camelCase로 관리).
// 식별자('default' 또는 emotionId) → 이 항목.
export type TtsReferenceMode = 'auto' | 'manual' | 'ref_free'

// 감정별 참조 구간(초). source에서 effective를 만든 구간 — 재현/기록용(계약 §1.2/§4).
export interface TtsEmotionRegion {
  start: number
  duration: number
}

export interface TtsReferenceEntry {
  manualText?: string        // 사용자가 직접 입력/수정한 전사문
  promptLang?: string        // 사용자가 선택한 프롬프트 언어
  mode?: TtsReferenceMode     // 'auto' | 'manual' | 'ref_free'
  // 자동 전사 미리보기 캐시(UI 표시용 — Python 전달에는 쓰이지 않음)
  autoStatus?: string
  autoText?: string
  autoLang?: string
  autoError?: string
  // 이 전사가 만들어진 참조 source의 지문(path|size|mtimeMs). 합성 경계에서 현재 source 지문과
  // 비교해 불일치면 stale로 판정·폐기(불변식 4). 미기록이면 지문 비교는 건너뛴다(source 존재만 검사).
  sourceFingerprint?: string
}

// 렌더러(ProcessButton)가 IPC로 넘기는 TTS 입력 옵션(모두 선택적).
export interface TtsInputOptions {
  ttsText?: string
  ttsSpeed?: number
  ttsSilenceGap?: number
  // 결과 WAV 음높이 보정(반음). 범위 -2.0~+2.0, 0.5 단위(정규화 권위는 Python pitch_shift.clamp_quantize).
  // 후처리 축: 모델 재합성 없이 최종 WAV에 적용. 0이면 무후처리(계약 §1.1/§6).
  ttsPitch?: number
  // 합성에 실제 사용할 감정별 effective 경로(파생 3~10초 클립, 또는 유효 ≤10초 원본). 사용∩등록∩준비만.
  ttsEmotionRefs?: Record<string, string>
  // 사용자가 등록한 감정별 원본 경로(영속). 재현·Python 등록판정 기준. effective와 역할이 다름(계약 §1.2).
  ttsEmotionRefSources?: Record<string, string>
  // source에서 effective를 만든 구간(초). 재현/기록용(합성 입력 무영향).
  ttsEmotionRefRegions?: Record<string, TtsEmotionRegion>
  ttsEngine?: string
  ttsReferencePrompts?: Record<string, TtsReferenceEntry>
  // 10초 초과 원본에서 사용자가 확정한 3~10초 파생 참조 클립(mono/24k). 설정 시 기본 참조로 이것을 쓴다.
  // 원본은 절대 참조로 직접 전달하지 않는다(전체 파일 참조 금지).
  ttsReferenceOverride?: string

  // ── 표현 사이클 S1 scaffold(타입 계약만) ──
  // ⚠️ 아래 필드는 '타입 선언'일 뿐이며 이번 S1에서 buildTtsConfig 반환값에 자동 추가되지 않는다.
  //    Python 전달·session 직렬화·metadata·기본값 적용 없음 → runtime 동작 변화 0. 실제 배선은 후속 승인 단계.
  ttsParserVersion?: 2                                        // 신규 문법 버전(legacy=암묵적 v1)
  ttsParsedPlanSha256?: string                               // renderer 파싱 결과 full sha256(Python parity 비교용; metadata엔 sha8만)
  ttsTailMode?: 'off' | 'auto'                               // 말끝 다듬기(legacy=off, new=auto). 미배선
  ttsTailPaddingMs?: number                                  // 끝 여백(new 기본 120, 허용 0~300). 미배선
  ttsTailFadeMs?: number                                     // 말끝 fade(new 기본 8, 허용 0~20). 미배선
  ttsEmotionBoundaryMode?: 'immediate' | 'pause'             // 감정 전환 경계(기본 pause). 미배선
  ttsEmotionBoundaryPauseMs?: number                         // 감정 전환 간격(기본 200, 허용 0~1000). 미배선
  ttsExpressionFineTuneEnabled?: boolean                     // 세부 조절 사용 스위치(펼치기/접기와 별개). 미배선
  ttsExpressionPresetId?: string                             // 프리셋 id(원본/낮고차분/중성/밝고가벼움). 미배선
  ttsShowSettingHelp?: boolean                               // 전역 설정 설명 표시. 미배선
}

// Python(separate.py/tts_worker)이 읽는 참조 override의 직렬화 형태(snake_case).
export interface TtsReferencePromptConfig {
  manual_text: string
  prompt_lang: string
  mode: string
}

// Python separate.py가 JSON config에서 읽는 TTS 필드의 직렬화 형태.
// 여기에 필드를 추가하면 buildTtsConfig 반환 리터럴에서 누락 시 컴파일 에러가 난다.
export interface TtsConfig {
  ttsText: string
  ttsSpeed: number
  ttsSilenceGap: number
  ttsPitch: number
  ttsEmotionRefs: Record<string, string>
  ttsEmotionRefSources: Record<string, string>
  ttsEmotionRefRegions: Record<string, TtsEmotionRegion>
  ttsEngine: string
  ttsReferencePrompts: Record<string, TtsReferencePromptConfig>
  ttsReferenceOverride: string
  // 공용 마감 I1: renderer 파싱(parser_version=2) full sha256 — Python이 재파싱해 parity 대조(불일치→PARSER_PARITY_MISMATCH).
  // metadata엔 sha8만; 여기(config)엔 full. 미제공('')이면 Python은 파싱 유효성만 검사하고 parity는 강제하지 않는다.
  ttsParsedPlanSha256: string
  ttsParserVersion: number
  // 공용 마감 I3: 말끝 finishing + 감정 전환 경계(계약 §2·추가3·추가4). 기본값은 backward-compat(off/현행).
  // new 세션의 auto 기본은 렌더러 스토어가 정한다(정정8: 부재=현행 동작, 자동 마이그레이션 없음).
  ttsTailMode: 'off' | 'auto'
  ttsTailPaddingMs: number
  ttsTailFadeMs: number
  ttsEmotionBoundaryMode: 'immediate' | 'pause'
  ttsEmotionBoundaryPauseMs: number
}

// ── stale 전사 방지 불변식(§4) — 합성 경계에서 전사↔음성 결합의 정합을 강제한다. ──
// sourceFingerprints = 현재 실제 참조 source의 지문 맵(id → 'path|size|mtimeMs'). 'default' 포함.
// 규칙(과도 폐기 방지):
//   1) 지문 맵이 없으면(undefined) 검사 생략 — 전부 보존(순수 렌더러 단위테스트 호환).
//   2) id가 지문 맵에 없다(=현재 살아있는 source 없음) → orphan 전사 → 폐기.
//   3) entry.sourceFingerprint가 기록됐고 현재 지문과 다르다 → stale(원본 교체/내용 변경) → 폐기.
//   4) 그 외(살아있는 source + 지문 미기록/일치) → 보존.
export function pruneStaleReferencePrompts(
  prompts?: Record<string, TtsReferenceEntry>,
  sourceFingerprints?: Record<string, string>
): Record<string, TtsReferenceEntry> {
  const out: Record<string, TtsReferenceEntry> = {}
  if (!prompts) return out
  if (!sourceFingerprints) return { ...prompts }  // (1) 검사 생략
  for (const [id, e] of Object.entries(prompts)) {
    const current = sourceFingerprints[id]
    if (current === undefined) continue                       // (2) orphan → 폐기
    if (e?.sourceFingerprint && e.sourceFingerprint !== current) continue  // (3) stale → 폐기
    out[id] = e                                               // (4) 보존
  }
  return out
}

// 참조 항목의 실효 모드 파생(UI 배지 + store mode 전환에 공용). 우선순위: ref_free > manual > auto.
// 수동문을 완전히 비우면 auto로 복귀(ref_free가 아닐 때).
export function deriveRefMode(e?: TtsReferenceEntry): TtsReferenceMode {
  if (e?.mode === 'ref_free') return 'ref_free'
  return (e?.manualText ?? '').trim() ? 'manual' : 'auto'
}

// UI 항목(camelCase) → Python 전달용(snake_case). 빈 override(수동 없음 + auto + 언어 미지정)는
// 자동 경로와 동일하므로 제외한다(빈 수동 입력을 자동 성공으로 오인하지 않기 위해 manual_text는 trim).
export function buildReferencePrompts(
  refs?: Record<string, TtsReferenceEntry>
): Record<string, TtsReferencePromptConfig> {
  const out: Record<string, TtsReferencePromptConfig> = {}
  if (!refs) return out
  for (const [id, e] of Object.entries(refs)) {
    const lang = e?.promptLang ?? ''
    // 우선순위: 명시적 ref_free > manual(비어있지 않음) > auto.
    if (e?.mode === 'ref_free') {
      // ref-free에서는 남아 있는 manualText를 전달에서 제거(백엔드가 무시하지만 방어적으로 비움).
      out[id] = { manual_text: '', prompt_lang: lang, mode: 'ref_free' }
      continue
    }
    const manual = (e?.manualText ?? '').trim()
    if (!manual && !lang) continue  // 순수 auto(수동 없음·언어 미지정, autoText만 있어도) → 전달 불필요
    // manual 존재 여부로 모드를 파생 — autoText만 있고 수동 편집이 없으면 manual이 되지 않는다.
    out[id] = { manual_text: manual, prompt_lang: lang, mode: manual ? 'manual' : 'auto' }
  }
  return out
}

// 입력은 타입 있는 TtsInputOptions로 받는다(IPC 경계에서 명시적으로 변환해 전달).
// 숫자 기본값은 반드시 ?? 로 — 사용자가 지정한 0(예: ttsSilenceGap=0)이
// || 때문에 기본값으로 변질되는 것을 막는다. (문자열/객체 기본값도 동일 규칙)
// sourceFingerprints(선택) = 현재 실제 참조 source 지문 맵. 지정 시 합성 경계에서 stale 전사를
// 먼저 폐기(§4)한 뒤 직렬화 — 렌더러가 stale 전사를 되살려 보내도 Python엔 정합 전사만 전달된다.
export function buildTtsConfig(o?: TtsInputOptions, sourceFingerprints?: Record<string, string>): TtsConfig {
  const prompts = pruneStaleReferencePrompts(o?.ttsReferencePrompts, sourceFingerprints)
  return {
    ttsText: o?.ttsText ?? '',
    ttsSpeed: o?.ttsSpeed ?? 1.0,
    ttsSilenceGap: o?.ttsSilenceGap ?? 0.5,
    ttsPitch: o?.ttsPitch ?? 0.0,
    ttsEmotionRefs: o?.ttsEmotionRefs ?? {},
    ttsEmotionRefSources: o?.ttsEmotionRefSources ?? {},
    ttsEmotionRefRegions: o?.ttsEmotionRefRegions ?? {},
    ttsEngine: o?.ttsEngine ?? 'auto',
    ttsReferencePrompts: buildReferencePrompts(prompts),
    ttsReferenceOverride: o?.ttsReferenceOverride ?? '',
    ttsParsedPlanSha256: o?.ttsParsedPlanSha256 ?? '',
    // 기본값 2 = ttsGrammar.TTS_PARSER_VERSION(권위). 여기선 런타임 cross-module import를 피하려 상수 미러(=2).
    // 드리프트 방지는 ttsGrammar/tts_grammar parity fixture + parser_version 계약이 담당.
    ttsParserVersion: o?.ttsParserVersion ?? 2,
    // I3: 옵션 부재 시 backward-compat(off/현행 동작 보존 — 정정8 "신규 설정 부재 = 현행 동작").
    // new 세션의 auto는 렌더러 스토어 초기값이 명시 전달한다. 숫자 기본은 계약 추가4(120/8/200).
    ttsTailMode: o?.ttsTailMode ?? 'off',
    ttsTailPaddingMs: o?.ttsTailPaddingMs ?? 120,
    ttsTailFadeMs: o?.ttsTailFadeMs ?? 8,
    ttsEmotionBoundaryMode: o?.ttsEmotionBoundaryMode ?? 'pause',
    ttsEmotionBoundaryPauseMs: o?.ttsEmotionBoundaryPauseMs ?? 200
  }
}
