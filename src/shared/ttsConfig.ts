// TTS 1단계 전달용 설정 — separate.py로 넘길 TTS 필드의 단일 소스.
// 목적: 필드 누락(예: ttsEmotionRefs 미전달)을 컴파일 단계에서 잡는다.

// 참조별 사용자 프롬프트 항목(UI/스토어에서 camelCase로 관리).
// 식별자('default' 또는 emotionId) → 이 항목.
export type TtsReferenceMode = 'auto' | 'manual' | 'ref_free'

export interface TtsReferenceEntry {
  manualText?: string        // 사용자가 직접 입력/수정한 전사문
  promptLang?: string        // 사용자가 선택한 프롬프트 언어
  mode?: TtsReferenceMode     // 'auto' | 'manual' | 'ref_free'
  // 자동 전사 미리보기 캐시(UI 표시용 — Python 전달에는 쓰이지 않음)
  autoStatus?: string
  autoText?: string
  autoLang?: string
  autoError?: string
}

// 렌더러(ProcessButton)가 IPC로 넘기는 TTS 입력 옵션(모두 선택적).
export interface TtsInputOptions {
  ttsText?: string
  ttsSpeed?: number
  ttsSilenceGap?: number
  ttsEmotionRefs?: Record<string, string>
  ttsEngine?: string
  ttsReferencePrompts?: Record<string, TtsReferenceEntry>
  // 10초 초과 원본에서 사용자가 확정한 3~10초 파생 참조 클립(mono/24k). 설정 시 기본 참조로 이것을 쓴다.
  // 원본은 절대 참조로 직접 전달하지 않는다(전체 파일 참조 금지).
  ttsReferenceOverride?: string
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
  ttsEmotionRefs: Record<string, string>
  ttsEngine: string
  ttsReferencePrompts: Record<string, TtsReferencePromptConfig>
  ttsReferenceOverride: string
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
export function buildTtsConfig(o?: TtsInputOptions): TtsConfig {
  return {
    ttsText: o?.ttsText ?? '',
    ttsSpeed: o?.ttsSpeed ?? 1.0,
    ttsSilenceGap: o?.ttsSilenceGap ?? 0.5,
    ttsEmotionRefs: o?.ttsEmotionRefs ?? {},
    ttsEngine: o?.ttsEngine ?? 'auto',
    ttsReferencePrompts: buildReferencePrompts(o?.ttsReferencePrompts),
    ttsReferenceOverride: o?.ttsReferenceOverride ?? ''
  }
}
