// TTS 1단계 전달용 설정 — separate.py로 넘길 TTS 필드의 단일 소스.
// 목적: 필드 누락(예: ttsEmotionRefs 미전달)을 컴파일 단계에서 잡는다.

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
    ttsReferenceOverride: o?.ttsReferenceOverride ?? ''
  }
}
