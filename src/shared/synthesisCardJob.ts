/**
 * 생성 카드 한 장이 **엔진에 무엇을 보낼 수 있는가.**
 *
 * ★왜 이 파일이 따로 있는가
 *   화면이 가진 손잡이와 엔진이 실제로 받는 값은 같지 않다. 그 차이를 화면 안에 두면
 *   "보내는 척" 이 생긴다 — 슬라이더는 +4 인데 엔진은 +2 로 깎아 쓰고, 화면은 +4 라고
 *   적어 둔다. 그러면 사용자는 자기가 듣는 소리를 설명할 수 없게 된다.
 *   여기서 **보낼 수 있는 것과 없는 것을 이름 붙여 돌려준다.** 화면은 그대로 보여 준다.
 *
 * 실측 근거(2026-09-26, 코드에서 확인)
 *   · 음높이: `python/pitch_shift.py` `clamp_quantize()` 가 **[-2.0, +2.0] 로 자르고 0.5 단위로**
 *     반올림한다. 범위 밖 값은 조용히 깎인다.
 *   · 말하기 속도: 네 엔진(F5·Kokoro·piper·그 외)이 모두 받아 쓴다. 워커에 자르는 자리는 없다.
 *   · 감정: 엔진에 **스칼라 감정 입력이 없다.** 감정은 `ttsEmotionRefs`(감정별 참조 클립)로만
 *     동작하고, 등록이 없으면 `separate.py`/`tts_worker.py` 가 **기본 참조로 폴백한다**
 *     (`python/tts_worker.py`: "미등록 → 기본 참조 폴백(정상)"). 즉 참조 없이 고른 감정은
 *     소리를 바꾸지 않는다. 그래서 이 파일은 감정을 **보내지 않고, 안 보낸다고 말한다.**
 *
 * 이 파일은 판단만 한다 — 파이썬을 부르지도, 파일을 만들지도 않는다.
 */

/** 엔진이 실제로 받는 음높이 범위. `python/pitch_shift.py` 를 그대로 옮긴 값이다. */
export const CARD_PITCH_MIN = -2
export const CARD_PITCH_MAX = 2
export const CARD_PITCH_STEP = 0.5

/** 카드 설정 중 엔진에 보낼 수 있는 것만. */
export interface CardEngineSettings {
  speed: number
  pitch: number
  emotion: string
  reference: 'auto' | 'manual'
  start: number
  end: number
}

/** 보내지 못했거나 깎인 값 하나. **화면이 이 문장을 그대로 띄운다.** */
export interface CardSettingNote {
  field: 'pitch' | 'emotion' | 'speed'
  /** 사람이 읽을 사유. */
  reason: string
}

/** 실제로 엔진에 간 값. 생성본에 이것을 붙인다 — 요청값이 아니라 **적용값**이다. */
export interface CardApplied {
  speed: number
  pitch: number
  notes: CardSettingNote[]
}

const round2 = (v: number) => Math.round(v * 100) / 100

/**
 * 엔진에 보낼 값을 정한다. **깎았으면 깎았다고 말한다.**
 *
 * 조용히 자르지 않는 것이 이 함수의 전부다 — 자르는 것 자체는 파이썬이 어차피 한다.
 * 여기서 미리 자르는 이유는 **깎였다는 사실을 화면과 생성본에 남기기 위해서**다.
 */
export function cardApplied(s: CardEngineSettings): CardApplied {
  const notes: CardSettingNote[] = []

  const raw = Number.isFinite(s.pitch) ? s.pitch : 0
  let pitch = Math.min(CARD_PITCH_MAX, Math.max(CARD_PITCH_MIN, raw))
  pitch = round2(Math.round(pitch / CARD_PITCH_STEP) * CARD_PITCH_STEP)
  if (round2(raw) !== pitch) {
    notes.push({
      field: 'pitch',
      reason: `음높이 ${raw > 0 ? '+' : ''}${round2(raw)} 은 엔진 범위 밖입니다 — ${pitch > 0 ? '+' : ''}${pitch} 로 적용됩니다 (${CARD_PITCH_MIN} ~ +${CARD_PITCH_MAX}, ${CARD_PITCH_STEP} 단위)`,
    })
  }

  // ★감정은 보내지 않는다. 보내도 참조가 없으면 소리가 바뀌지 않는데,
  //   화면에는 적용된 것처럼 남는다. 그것이 가장 나쁜 결과다.
  if (s.emotion && s.emotion !== '자연스럽게') {
    notes.push({
      field: 'emotion',
      reason: `감정 '${s.emotion}' 은 이번 생성에 반영되지 않습니다 — 감정은 그 감정용 참조 소리를 따로 등록해야 동작합니다`,
    })
  }

  const speed = Number.isFinite(s.speed) && s.speed > 0 ? round2(s.speed) : 1
  return { speed, pitch, notes }
}

/** 이 카드의 파생 클립이 사는 자리. 카드마다 폴더가 따로다. */
export const CARD_CLIP_PREFIX = 'card:'
export function cardClipKey(cardId: string): string {
  return CARD_CLIP_PREFIX + cardId
}
export function isCardClipKey(key: string): boolean {
  return key.startsWith(CARD_CLIP_PREFIX)
}

/** 참조 구간이 쓸 만한가. 직접 지정일 때만 따진다. */
export function cardRegionFault(s: CardEngineSettings, duration: number): string {
  if (s.reference !== 'manual') return ''
  if (!(duration > 0)) return '파일 길이를 알 수 없습니다'
  if (!(s.start >= 0)) return '시작은 0 이상이어야 합니다'
  if (!(s.end > s.start)) return '끝은 시작보다 뒤여야 합니다'
  if (s.end > duration + 1e-6) return '끝이 파일 길이를 넘습니다'
  return ''
}

/** 지금 생성할 수 있는가. 못 하면 **그 이유**를 돌려준다(빈 문자열이면 할 수 있다). */
export function cardGenerateFault(a: {
  hasSource: boolean
  text: string
  refReady: boolean
  refMessage: string
  busy: boolean
}): string {
  if (a.busy) return '다른 작업이 끝난 뒤에 만들 수 있습니다'
  if (!a.hasSource) return '먼저 목소리로 쓸 음원을 고르세요'
  if (!a.text.trim()) return '대사를 입력하세요'
  if (!a.refReady) return a.refMessage || '목소리를 준비하는 중입니다'
  return ''
}

/** 생성본에 붙일 그때의 모습. **현재 카드를 덮어 보여 주지 않기 위한 것**이다. */
export interface CardTakeSnapshot {
  text: string
  sourcePath: string
  settings: CardEngineSettings
  applied: CardApplied
}

/**
 * 이 생성본이 **지금 카드와 다른가**(= '수정 전' 인가).
 *
 * 대사·원본·설정 중 하나라도 달라지면 다르다. 화면은 이 값으로 '수정 전' 을 표시한다.
 */
export function takeIsStale(snap: CardTakeSnapshot, now: {
  text: string; sourcePath: string; settings: CardEngineSettings
}): boolean {
  if (snap.text !== now.text) return true
  if (snap.sourcePath !== now.sourcePath) return true
  const a = snap.settings, b = now.settings
  return a.speed !== b.speed || a.pitch !== b.pitch || a.emotion !== b.emotion
    || a.reference !== b.reference || a.start !== b.start || a.end !== b.end
}
