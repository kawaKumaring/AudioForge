// TTS 표현(말끝 finishing / 감정 전환 경계) 범위·기본값·capability 단일 권위(TS).
// ⚠️ 값은 3 권위와 반드시 일치: D 계약 §추가4(tts-expression-contract.md) · buildTtsConfig 기본값(ttsConfig.ts) ·
//    python/audio_finishing.py parse_tail_config 범위. 드리프트는 단위테스트(ttsExpressionCapabilities.test.ts)와
//    config/Python 경계 테스트로 고정한다. 여러 컴포넌트에 true/범위를 흩뿌리지 말고 여기서만 소비(I5-c 계약).
// capability는 런타임 pitch rubberband probe와 '별개'인 빌드 capability다 — 통합 빌드는 I2/I3로 tail·감정경계가
// backend에 구현되어 지원됨. 구버전/미탑재 신호가 있을 때만 false + 사유(가짜 활성화 금지).

export interface NumRange { readonly min: number; readonly max: number; readonly def: number }

// 끝 여백(ms). 기본 120, 0~300.
export const TTS_TAIL_PADDING_MS: NumRange = { min: 0, max: 300, def: 120 }
// 말끝 페이드(ms). 기본 8, 0~20.
export const TTS_TAIL_FADE_MS: NumRange = { min: 0, max: 20, def: 8 }
// 감정 전환 간격(ms). 기본 200, 0~1000. pause 모드일 때만 유효.
export const TTS_EMOTION_PAUSE_MS: NumRange = { min: 0, max: 1000, def: 200 }

export const TTS_TAIL_MODES = ['off', 'auto'] as const
export const TTS_EMOTION_MODES = ['immediate', 'pause'] as const
export type TtsTailMode = typeof TTS_TAIL_MODES[number]
export type TtsEmotionMode = typeof TTS_EMOTION_MODES[number]

export const TTS_TAIL_MODE_NEW_DEFAULT: TtsTailMode = 'auto'
export const TTS_TAIL_MODE_LEGACY_DEFAULT: TtsTailMode = 'off'
export const TTS_EMOTION_MODE_DEFAULT: TtsEmotionMode = 'pause'

// [min,max] 정수 유한값인지(브라우저 range의 조용한 clamp에 의존하지 않기 위해 명시 검증).
export function inRange(v: unknown, r: NumRange): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max
}
export function isTailMode(v: unknown): v is TtsTailMode {
  return v === 'off' || v === 'auto'
}
export function isEmotionMode(v: unknown): v is TtsEmotionMode {
  return v === 'immediate' || v === 'pause'
}

export interface TtsExpressionCapability { tail: boolean; emotionBoundary: boolean; reason?: string }

// 표현(말끝/감정경계) capability 단일 selector. backendSupported=false(구버전/미탑재)면 비활성 + 사유.
// 통합 빌드는 항상 지원(I2/I3). pitch capability와 별개.
export function resolveExpressionCapability(backendSupported = true, reason?: string): TtsExpressionCapability {
  if (!backendSupported) {
    return { tail: false, emotionBoundary: false, reason: reason || '이 빌드에서는 말끝/감정 전환 처리를 사용할 수 없습니다.' }
  }
  return { tail: true, emotionBoundary: true }
}
