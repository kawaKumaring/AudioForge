/**
 * 카드가 **무엇으로 말하는가** — 목소리 종류를 한 곳에서 정한다.
 *
 * ★두 가지가 있다 (2026-09-27)
 *   · 참조 음원: 사용자가 고른 소리·영상 파일의 목소리를 따라 만든다.
 *   · 기본 목소리: 설치된 로컬 모델로 **참조 없이** 읽는다.
 *
 * ★빈 파일 경로를 가짜 참조로 쓰지 않는다. 종류를 명시적으로 나눈다 —
 *   '경로가 비었으니 기본 목소리겠지' 같은 추측은 나중에 반드시 틀린다.
 *
 * ★기존 저장본은 `source` 만 가지고 있다. 그것은 참조 음원으로 읽는다(호환).
 *
 * 이 파일은 판단만 한다 — 파이썬을 부르지도, 파일을 만들지도 않는다.
 */

/** 참조로 쓰는 원본 파일. */
export interface CardSourceLike {
  path: string
  name: string
  duration: number
}

/** 설치된 기본 목소리 하나. 화면이 고른 뒤 카드에 그대로 붙는다. */
export interface BuiltinVoiceRef {
  engineId: string
  modelId: string
  /** 사람이 읽을 이름. */
  label: string
  language: string
  /** 모델 파일 자리. 생성 요청에 실어 보낸다. */
  path: string
  sampleRate: number
  speakerId?: string
  /** 목소리 설명(모델 카드를 옮김) — 고르기 칩에 작게 보인다. */
  note?: string
  /** 한국어 원어민 목소리인가. false 면 외국어 억양이 있다(받아 적기로는 알아듣게 읽는 것만 싣는다). */
  native?: boolean
  /** 감정 지시를 받을 수 있는가 — Qwen 지정 목소리 + 1.7B 를 받아 두었을 때(2026-10-01). */
  emotion?: boolean
}

/**
 * 카드에서 고를 수 있는 감정 — Qwen 지정 목소리의 감정 지시(파이썬 QWEN_EMOTION_INSTRUCTS)로 옮기는 것만.
 * 이름은 대사 감정 태그([기쁨] 등)와 같은 한국어 이름이다. 성적인 감정 태그는 지시로 옮기지 않아 싣지 않는다.
 */
export const CARD_EMOTIONS: readonly string[] = [
  '기쁨', '슬픔', '화남', '놀람', '속삭임', '진지', '명랑', '걱정', '피곤', '공손', '냉소', '긴장', '부끄러움', '자신감',
  '위로', '흥분', '공포', '짜증', '나레이션', '그리움', '질투', '감동', '허탈', '비꼼', '애교', '냉정', '다정', '울먹',
  '한숨', '비장', '장난', '경멸', '동경', '초조', '체념', '호기심', '지루함', '당황', '득의', '설렘', '달콤', '은밀', '애틋', '매력',
]
export const CARD_EMOTION_NONE = '자연스럽게'

/**
 * 카드 감정을 대사에 싣는다 — **감정 태그가 없는 줄마다** `[감정] ` 을 붙인다(태그는 그 줄에만 걸린다 — tts_grammar 실측).
 * 사용자가 줄에 직접 쓴 태그는 그대로 둔다(그 줄은 그 감정). 감정이 없거나 이 목소리가 받지 않으면 대사 그대로.
 */
export function cardScriptWithEmotion(text: string, emotion: string, v: CardVoice): string {
  if (!emotion || emotion === CARD_EMOTION_NONE || !CARD_EMOTIONS.includes(emotion)) return text
  if (!voiceSupports(v).emotion) return text
  return text.split('\n').map((line) => (!line.trim() || /^\s*\[/.test(line)) ? line : `[${emotion}] ${line.replace(/^\s+/, '')}`).join('\n')
}

export type CardVoice =
  | { kind: 'reference'; source: CardSourceLike }
  | { kind: 'builtin'; voice: BuiltinVoiceRef }
  | { kind: 'none' }

/** 카드가 가진 것에서 목소리 종류를 읽는다. **판정의 단 하나의 출처.** */
export function cardVoiceOf(card: {
  source?: CardSourceLike | null
  builtin?: BuiltinVoiceRef | null
}): CardVoice {
  if (card.builtin && card.builtin.path) return { kind: 'builtin', voice: card.builtin }
  if (card.source && card.source.path) return { kind: 'reference', source: card.source }
  return { kind: 'none' }
}

/** 화면에 보일 목소리 이름. */
export function cardVoiceLabel(v: CardVoice): string {
  if (v.kind === 'builtin') return v.voice.label
  if (v.kind === 'reference') return v.source.name
  return ''
}

/** 이 목소리가 **참조 준비(분석·구간 자르기)를 거치는가.** */
export function needsReferencePrep(v: CardVoice): boolean {
  return v.kind === 'reference'
}

/**
 * 이 목소리에서 **쓸 수 있는 설정**만.
 *
 * ★기본 목소리는 참조가 없으니 참조 구간·참조 감정을 보이지 않는다.
 *   엔진이 받지 않는 손잡이를 그려 두면 적용된 것처럼 남는다.
 */
export function voiceSupports(v: CardVoice): { speed: boolean; pitch: boolean; region: boolean; emotion: boolean } {
  // ★감정은 Qwen 지정 목소리 + 1.7B 일 때만(2026-10-01). 참조 목소리의 감정은 예전 실험에서 인물 동일성과 함께 통과한 길이 없어 열지 않는다.
  if (v.kind === 'builtin') return { speed: true, pitch: true, region: false, emotion: v.voice.engineId === 'qwen-custom' && v.voice.emotion === true }
  return { speed: true, pitch: true, region: true, emotion: false }
}

/**
 * 지금 만들 수 있는가. 못 하면 **그 이유**를 돌려준다(빈 문자열이면 할 수 있다).
 *
 * ★기본 목소리는 파일이 없다는 이유로 막히지 않는다 — 대사와 모델만 보면 된다.
 */
export function voiceGenerateFault(a: {
  voice: CardVoice
  text: string
  /** 참조 목소리일 때의 준비 상태. */
  refReady: boolean
  refMessage: string
  busy: boolean
  /**
   * **다른 카드**가 지금 참조를 준비하고 있는가.
   *
   * ★왜 필요한가 (2026-09-28 실측)
   *   참조 목소리 카드를 여럿 만들면 준비(구간 트림)가 동시에 돈다. 그런데 본체는
   *   파이썬을 한 번에 하나만 돌리므로, 그 사이 생성을 누르면
   *   "참조 구간 트림 중에는 합성을 시작할 수 없습니다" 로 **거절한다.**
   *   화면이 이것을 모르면 단추가 열려 있고, 눌러야 비로소 거절을 본다 —
   *   다섯 명으로 만들어 보니 **넷이 그렇게 튕겼다.**
   *   막을 것을 미리 알면 **누르기 전에** 말해 줄 수 있다.
   */
  othersPreparing?: boolean
  /** 기본 목소리 모델이 지금도 쓸 수 있는가. */
  builtinUsable: boolean
  builtinWhy: string
}): string {
  if (a.busy) return '다른 작업이 끝난 뒤에 만들 수 있습니다'
  if (a.voice.kind === 'none') return '먼저 목소리를 고르세요'
  if (!a.text.trim()) return '대사를 입력하세요'
  // ★내 준비가 끝났어도 **남의 준비가 돌고 있으면** 본체가 거절한다.
  //   목소리·대사 문제보다 뒤에 둔다 — 고칠 수 있는 것을 먼저 말해야 한다.
  if (a.othersPreparing) return '다른 카드의 목소리를 준비하는 중입니다 — 끝나면 만들 수 있습니다'
  if (a.voice.kind === 'builtin') {
    return a.builtinUsable ? '' : (a.builtinWhy || '이 기본 목소리를 쓸 수 없습니다')
  }
  if (!a.refReady) return a.refMessage || '목소리를 준비하는 중입니다'
  return ''
}

/** 생성 요청에 실을 기본 목소리 값. 참조 목소리면 아무것도 싣지 않는다. */
export function builtinRequestFields(v: CardVoice): Record<string, string> {
  if (v.kind !== 'builtin') return {}
  return {
    ttsEngine: v.voice.engineId,
    ttsBuiltinModel: v.voice.path,
    ttsBuiltinModelId: v.voice.modelId,
    ttsBuiltinLabel: v.voice.label,
    ttsBuiltinLanguage: v.voice.language,
    ...(v.voice.speakerId ? { ttsBuiltinSpeaker: v.voice.speakerId } : {}),
  }
}

/**
 * 생성본에 남길 **그때의 목소리**. 나중에 "무엇으로 만든 소리인가" 를 답할 수 있어야 한다.
 */
export interface VoiceSnapshot {
  kind: 'reference' | 'builtin' | 'none'
  label: string
  /** 참조일 때의 파일 경로. */
  sourcePath?: string
  /** 기본 목소리일 때의 식별자들. */
  engineId?: string
  modelId?: string
  language?: string
  speakerId?: string
}

export function voiceSnapshot(v: CardVoice): VoiceSnapshot {
  if (v.kind === 'builtin') {
    return {
      kind: 'builtin', label: v.voice.label, engineId: v.voice.engineId,
      modelId: v.voice.modelId, language: v.voice.language,
      ...(v.voice.speakerId ? { speakerId: v.voice.speakerId } : {}),
    }
  }
  if (v.kind === 'reference') {
    return { kind: 'reference', label: v.source.name, sourcePath: v.source.path }
  }
  return { kind: 'none', label: '' }
}

/** 두 목소리가 같은가 — '수정 전' 판정에 쓴다. */
export function sameVoice(a: VoiceSnapshot, b: VoiceSnapshot): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'builtin') {
    return a.engineId === b.engineId && a.modelId === b.modelId && a.speakerId === b.speakerId
  }
  if (a.kind === 'reference') return a.sourcePath === b.sourcePath
  return true
}
