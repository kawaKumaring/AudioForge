// TTS 1단계 전달용 설정 — separate.py로 넘길 TTS 필드의 단일 소스.
// 목적: 필드 누락(예: ttsEmotionRefs 미전달)을 컴파일 단계에서 잡는다.

// 렌더러(ProcessButton)가 IPC로 넘기는 TTS 입력 옵션(모두 선택적).
export interface TtsInputOptions {
  ttsText?: string
  ttsSpeed?: number
  ttsSilenceGap?: number
  ttsEmotionRefs?: Record<string, string>
  ttsEngine?: string
}

// Python separate.py가 JSON config에서 읽는 TTS 필드의 직렬화 형태.
// 여기에 필드를 추가하면 buildTtsConfig 반환 리터럴에서 누락 시 컴파일 에러가 난다.
export interface TtsConfig {
  ttsText: string
  ttsSpeed: number
  ttsSilenceGap: number
  ttsEmotionRefs: Record<string, string>
  ttsEngine: string
}

// 입력은 타입 있는 TtsInputOptions로 받는다(IPC 경계에서 명시적으로 변환해 전달).
// 숫자 기본값은 반드시 ?? 로 — 사용자가 지정한 0(예: ttsSilenceGap=0)이
// || 때문에 기본값으로 변질되는 것을 막는다. (문자열/객체 기본값도 동일 규칙)
export function buildTtsConfig(o?: TtsInputOptions): TtsConfig {
  return {
    ttsText: o?.ttsText ?? '',
    ttsSpeed: o?.ttsSpeed ?? 1.0,
    ttsSilenceGap: o?.ttsSilenceGap ?? 0.5,
    ttsEmotionRefs: o?.ttsEmotionRefs ?? {},
    ttsEngine: o?.ttsEngine ?? 'auto'
  }
}
