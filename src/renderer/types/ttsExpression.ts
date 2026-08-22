// 표현 사이클 컴포넌트 props 계약 (S1 scaffold — 타입만). 빈/가짜 React 컴포넌트는 만들지 않는다.
// 실제 컴포넌트 구현은 소유 에이전트(A: EmotionScriptEditor / C: 나머지) 단계. smooth/formant/brightness/
// breathiness/falsetto 타입은 추가하지 않는다(미지원·미노출). 미구현 축은 capability=false로 표현.
import type { ParsedPlan, ParsedEmotionSegment, TtsGrammarError } from '../../shared/ttsGrammar'
import type { TtsEmotionRegion } from '../../shared/ttsConfig'

// 지원 여부를 데이터로 표현(가짜 슬라이더 방지). false면 UI는 비활성/미노출.
export interface ExpressionCapabilities {
  pitch: boolean            // 지원
  speed: boolean            // 지원
  sentenceGap: boolean      // 문장 간격 — 지원(문장 경계 silence_gap)
  emotionTransitionGap: boolean  // 감정 전환 간격 — B 구현 전 false
  tailTrim: boolean         // 말끝 다듬기 — B 구현 전 false
  tailPadding: boolean      // 끝 여백 — B 구현 전 false
  // smooth/formant/가성 등은 필드 자체를 두지 않는다(미지원·연구 항목).
}

// 감정 전환 모드(1차 immediate|pause만; smooth 없음).
export type EmotionTransitionMode = 'immediate' | 'pause'

// A 소유. 대사 편집기 + 감정/쉼 삽입 + 색 범위 preview. 실제 입력은 내부 textarea가 담당.
export interface EmotionScriptEditorProps {
  value: string
  /** Python 합성 권위와 parity를 이루는 renderer preview 파싱 결과(색 범위·경고 표시용). null=미파싱. */
  parsedPreview: ParsedPlan | null
  /** 파싱 오류(UNKNOWN_TTS_TAG/INVALID_PAUSE_TAG/EMPTY_EMOTION_SEGMENT 등) — inline warning + 합성 차단 표시용. */
  parseErrors: TtsGrammarError[]
  /** 대사 문자열 변경(태그 삽입/편집 결과 포함). caret/selection 복원은 구현이 담당. */
  onChange: (nextValue: string) => void
  /** 감정 태그 삽입 요청(현재 caret/선택 기준, 대사 무손실). id = emotions.ts emotionId. */
  onInsertEmotion: (emotionId: string) => void
  /** 명시적 쉼 삽입 요청(정확 caret, ms 정수). 범위 밖은 상위에서 INVALID_PAUSE_TAG 처리. */
  onInsertPause: (pauseMs: number) => void
  disabled?: boolean
}

// C 소유. 감정 참조 요약 배지 + 관리(등록/삭제/미리듣기/변경).
export interface EmotionReferenceManagerProps {
  refs: Array<{
    emotionId: string
    registered: boolean
    ready: boolean
    /** 참조 길이(초). 표시용. */
    durationSec?: number
    region?: TtsEmotionRegion
  }>
  onRegister: (emotionId: string, source: string) => void
  onRemove: (emotionId: string) => void
  onPreview: (emotionId: string) => void
  onChangeRegion: (emotionId: string, region: TtsEmotionRegion) => void
}

// C 소유. 후처리 축 컨트롤(생성축과 분리). 미지원 축은 capabilities로 비활성.
export interface ExpressionControlsProps {
  capabilities: ExpressionCapabilities
  presetId: string
  fineTuneEnabled: boolean           // '세부 조절 사용'(펼치기/접기와 별개)
  /** 지원 축 현재값(미지원 축은 UI 비활성이므로 여기 포함하지 않거나 무시). */
  values: {
    pitchSemitones: number
    speed: number
    sentenceGapMs: number
    // emotionTransitionGapMs / tail* 는 capability=true가 될 때만 노출
    emotionTransitionGapMs?: number
    tailPaddingMs?: number
    tailFadeMs?: number
    emotionBoundaryMode?: EmotionTransitionMode
  }
  onPreset: (presetId: string) => void
  onToggleFineTune: (enabled: boolean) => void
  onChange: (patch: Partial<ExpressionControlsProps['values']>) => void
}

// C 소유. '목소리' 섹션(기본 참조/전사/구간 등 상위 배선). 세부 타입은 구현 단계에서 확장.
export interface TtsVoiceSectionProps {
  referenceReady: boolean
  referenceMessage?: string
  showSettingHelp: boolean
  onToggleSettingHelp: (show: boolean) => void
}

// 4-flow 셸이 패널에 넘길 공통 selection(구현 단계 확장 여지). 재-export 편의.
export type { ParsedEmotionSegment }
