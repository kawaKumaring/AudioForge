// 감정 샘플 '진단용' 미리듣기 타임라인 — 순수 모듈(DOM·타이머·파일 접근 없음).
//
// 왜 앞뒤에 정적을 두는가: 표현 샘플은 짧다. 재생 시작과 첫 음절이 겹치면 웃음이 실제로 났는지,
// 늘임이 끝까지 유지됐는지 귀로 가르기 어렵고, 끝 부분이 잘렸는지도 알기 어렵다. 앞뒤에 정적을
// 두면 경계가 분명해져 '들어서 판정'이 가능해진다.
//
// ⚠️ 이것은 **듣고 판정하기 위한 진단 장치**이지 합성 결과물이 아니다. 그래서:
//    · 합성 텍스트·모델 입력·요청 페이로드에 들어가지 않는다.
//    · 원본 WAV 를 건드리지 않는다 — 덮어쓰기도, 파생 파일 생성도 없다.
//      무음은 파일에 붙이는 것이 아니라 **재생 타임라인에서 기다리는 것**이다.
//    · 감정 샘플 캐시 키(buildEmotionSampleCacheKey / build_cache_key)에 들어가지 않는다.
//      → 같은 샘플의 캐시 키와 내용 SHA-256 은 진단 무음이 있든 없든 동일하다.
//    · production 최종 합성 경로(tts worker · audio finishing)는 이 모듈을 import 하지 않는다.
//      꼬리 패딩(tail_padding_ms)은 합성 결과물의 일부라 캐시 키에 들어가는 별개의 값이다 —
//      이 진단 무음과 절대 섞지 않는다.

/** 감정 샘플 앞뒤에 두는 진단용 정적 길이(ms). 재생할 때만 쓰인다. */
export const EMOTION_PREVIEW_SILENCE_MS = 500

/**
 * 재생 단계.
 *   idle    — 재생 중이 아님
 *   leadIn  — 앞 정적(아직 소리 없음)
 *   sample  — 원본 샘플 재생 중
 *   tailOut — 뒤 정적(원본은 이미 끝났다)
 *   done    — 타임라인 종료
 */
export type EmotionPreviewStage = 'idle' | 'leadIn' | 'sample' | 'tailOut' | 'done'

export interface EmotionPreviewTimeline {
  /** 앞 정적 길이(ms). */
  readonly leadInMs: number
  /** 원본이 소리를 내기 시작하는 시각(ms) = leadInMs. */
  readonly sampleStartMs: number
  /** 원본 길이(ms). 호출자가 잰 값 그대로 — 이 모듈이 원본을 자르거나 늘이지 않는다. */
  readonly sampleDurationMs: number
  /** 원본이 끝나는 시각(ms). */
  readonly sampleEndMs: number
  /** 뒤 정적 길이(ms). */
  readonly tailOutMs: number
  /** 진단 재생 전체 길이(ms) = 500 + 원본 + 500. */
  readonly totalMs: number
}

/**
 * 원본 길이(ms)로 진단 재생 타임라인을 만든다. 원본을 변형하지 않는다 — 구간 좌표만 계산한다.
 * 길이를 모르는 채로도 재생할 수 있다(플레이어는 미디어의 ended 로 뒤 정적에 들어간다).
 * 이 함수는 길이를 아는 경우의 검증·표시용이다.
 */
export function buildEmotionPreviewTimeline(sampleDurationMs: number): EmotionPreviewTimeline {
  if (!Number.isFinite(sampleDurationMs) || sampleDurationMs < 0) {
    throw new RangeError('sampleDurationMs must be a finite number >= 0')
  }
  const pad = EMOTION_PREVIEW_SILENCE_MS
  return Object.freeze({
    leadInMs: pad,
    sampleStartMs: pad,
    sampleDurationMs,
    sampleEndMs: pad + sampleDurationMs,
    tailOutMs: pad,
    totalMs: pad + sampleDurationMs + pad,
  })
}

/**
 * 진단 재생 시작 이후 elapsedMs 시점의 단계. 경계는 '다음 단계가 시작된 시각'으로 본다
 * (elapsed === leadInMs 면 이미 sample).
 */
export function emotionPreviewStageAt(
  timeline: EmotionPreviewTimeline,
  elapsedMs: number
): EmotionPreviewStage {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'idle'
  if (elapsedMs < timeline.sampleStartMs) return 'leadIn'
  if (elapsedMs < timeline.sampleEndMs) return 'sample'
  if (elapsedMs < timeline.totalMs) return 'tailOut'
  return 'done'
}

/**
 * 이 단계에서 소리가 나야 하는가. leadIn·tailOut 은 반드시 무음이다 —
 * 진단 정적 구간에 원본이 새어 나오면 경계 판정이 무의미해진다.
 */
export function emotionPreviewIsSilent(stage: EmotionPreviewStage): boolean {
  return stage !== 'sample'
}
