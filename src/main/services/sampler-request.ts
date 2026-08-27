// 감정 샘플 요청 해석 — renderer 의 논리 ID 를 실제 합성 입력으로 바꾸는 유일한 자리.
//
// renderer 가 주는 것: referenceId 와 sampler row id 뿐이다.
// 경로·ref_text·cacheKey 는 renderer 가 만들지 않는다. 전부 여기서(main 안에서) 해석한다.
//
// 순서: referenceId → durable clip 경로 + clip_sha256 → 검증된 ref_text →
//       capability 확인 → 대본 조립 → 타임라인 파싱 → expression → cacheKey(key version 3)
//
// voice_content_sha256 은 clip_sha256 이다(source_sha256 이 아니다).
// 같은 원본이라도 구간이 다르면 다른 바이트이고 다른 목소리 조건이므로 캐시도 갈라져야 한다.
//
// 전사 부재·손상·해시 불일치는 구조화 오류로 막는다 —
// x-vector 자동 강등도, 기본 전사 대체도, 다른 참조의 전사 사용도 하지 않는다.
//
// ⚠️ 값 import 를 하지 않는다(타입만). node --test 가 이 파일을 직접 로드한다.
import type {
  EmotionSampleCapability, EmotionSampleExpression, EmotionSampleKeyInput,
} from '../../shared/emotionSampler'
import type { ReferenceStore } from './reference-store'

/** 캐시 키에 들어가는 합성 설정. renderer 가 아니라 셸이 정한다. */
export interface SamplerConfigInput {
  engineId: string
  modelId: string
  config: EmotionSampleKeyInput['config']
}

export interface SamplerRequestDeps {
  referenceStore: ReferenceStore
  /** 행 하나의 합성 대본. 프롬프트이므로 결과에 담되 로그·상태에는 넣지 않는다. */
  buildEmotionSampleScript: (rowId: string) => string
  /** 대본 → 표현 타임라인. 계약 파서를 그대로 쓴다. */
  parseExpressiveTimeline: (script: string, opts?: { mode?: string }) => unknown
  emotionSampleExpressionFromTimeline: (rowId: string, timeline: never) => EmotionSampleExpression
  buildEmotionSampleCacheKey: (input: EmotionSampleKeyInput) => string
  capabilityForRow: (rowId: string) => EmotionSampleCapability
  /** capability 자체의 상태(supported/unsupported/unverified)를 판정한다. */
  isCapabilityUsable: (capabilityState: EmotionSampleCapability['state']) => boolean
}

export type SamplerRequestFailure =
  | 'NO_REFERENCE_SELECTED'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_NOT_READY'        // 파일 없음·체크섬 불일치·링크 등
  | 'TRANSCRIPT_MISSING'
  | 'TRANSCRIPT_CORRUPT'
  | 'TRANSCRIPT_HASH_MISMATCH'
  | 'CAPABILITY_NOT_USABLE'      // unsupported/unverified 행
  | 'INVALID_ROW'
  | 'EXPRESSION_FAILED'          // 대본이 계약 타임라인으로 풀리지 않음

/** 성공 결과. filePath 와 refText 는 main 안에서만 쓰인다 — renderer 로 내보내지 않는다. */
export interface SamplerRequestResolved {
  ok: true
  cacheKey: string
  /** durable clip 절대 경로(main 전용). */
  filePath: string
  /** 검증된 참조 전사(main 전용). ICL 입력으로만 쓴다. */
  refText: string
  language: string
  /** 합성 대본(프롬프트). 상태·로그·화면에 넣지 않는다. */
  script: string
  expression: EmotionSampleExpression
  /** 캐시 키 권위 = 저장된 클립 바이트의 해시. */
  voiceContentSha256: string
}

export type SamplerRequestOutcome =
  | SamplerRequestResolved
  | { ok: false; reason: SamplerRequestFailure }

/**
 * 논리 ID 한 쌍(referenceId, rowId)을 합성 가능한 요청으로 바꾼다.
 * 어느 단계에서 막히든 사유를 그대로 돌려주고 대체 경로로 우회하지 않는다.
 */
export function resolveSamplerRequest(
  deps: SamplerRequestDeps,
  input: { referenceId: string | null; rowId: string; settings: SamplerConfigInput },
): SamplerRequestOutcome {
  const referenceId = String(input?.referenceId ?? '').trim().toLowerCase()
  if (!referenceId) return { ok: false, reason: 'NO_REFERENCE_SELECTED' }

  // 1) 참조 실체 — 경로와 저장된 바이트의 해시를 main 이 직접 얻는다.
  const clip = deps.referenceStore.resolveClipFile(referenceId)
  if (!clip.ok) {
    return { ok: false, reason: clip.reason === 'NOT_FOUND' ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_NOT_READY' }
  }

  // 2) 참조 전사 — ICL 은 ref_text 를 실제로 요구한다. 없거나 어긋나면 여기서 멈춘다.
  const transcript = deps.referenceStore.resolveTranscript(referenceId)
  if (!transcript.ok) {
    const reason: SamplerRequestFailure =
      transcript.reason === 'TRANSCRIPT_HASH_MISMATCH' ? 'TRANSCRIPT_HASH_MISMATCH'
        : transcript.reason === 'TRANSCRIPT_CORRUPT' ? 'TRANSCRIPT_CORRUPT'
          : transcript.reason === 'MANIFEST_CORRUPT' ? 'REFERENCE_NOT_READY'
            : transcript.reason === 'NOT_FOUND' ? 'REFERENCE_NOT_FOUND'
              : 'TRANSCRIPT_MISSING'
    return { ok: false, reason }
  }

  // 3) capability — 엔진이 못 하는 행은 요청 자체를 만들지 않는다.
  let capability: EmotionSampleCapability
  try {
    capability = deps.capabilityForRow(input.rowId)
  } catch {
    return { ok: false, reason: 'INVALID_ROW' }
  }
  // isCapabilityUsable 은 capability 자체의 상태(supported/unsupported/unverified)를 받는다.
  // stateForCapability 가 주는 것은 샘플 행의 표시 상태(idle 등)라 여기 판정에 쓰지 않는다.
  if (!deps.isCapabilityUsable(capability.state)) {
    return { ok: false, reason: 'CAPABILITY_NOT_USABLE' }
  }

  // 4) 대본 → 타임라인 → 표현. 감정 문자열을 손으로 조립하지 않는다(카탈로그가 정한다).
  let script: string
  let expression: EmotionSampleExpression
  try {
    script = deps.buildEmotionSampleScript(input.rowId)
    const timeline = deps.parseExpressiveTimeline(script, { mode: 'expressive_v3' })
    const parsed = (timeline as { ok?: boolean; timeline?: unknown })
    const usable = parsed && parsed.ok === false ? null : (parsed?.timeline ?? timeline)
    if (!usable) return { ok: false, reason: 'EXPRESSION_FAILED' }
    expression = deps.emotionSampleExpressionFromTimeline(input.rowId, usable as never)
  } catch {
    return { ok: false, reason: 'EXPRESSION_FAILED' }
  }

  // 5) 캐시 키 — 목소리 신원은 저장된 클립 바이트의 해시다.
  const voiceContentSha256 = clip.clipSha256
  let cacheKey: string
  try {
    cacheKey = deps.buildEmotionSampleCacheKey({
      voiceContentSha256,
      engineId: input.settings.engineId,
      modelId: input.settings.modelId,
      expression,
      config: input.settings.config,
    })
  } catch {
    return { ok: false, reason: 'INVALID_ROW' }
  }

  return {
    ok: true,
    cacheKey,
    filePath: clip.filePath,
    refText: transcript.sidecar.text,
    language: transcript.sidecar.language,
    script,
    expression,
    voiceContentSha256,
  }
}
