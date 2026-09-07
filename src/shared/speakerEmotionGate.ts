/**
 * 인물별 `감정별 목소리 사용` 게이트 — 순수 함수, 의존성 없음.
 *
 * 기본 여러 명 모드에서는 각 인물 카드의 기본 목소리(ttsSpeakerRefs)만 생성에 쓴다. 적용된
 * 목소리 구성이 내려 준 `(화자, 감정) → 음원` 과 감정 후보 선택은 사용자가 **그 인물에 대해**
 * 이 작업에서 직접 켠 경우에만 생성 입력으로 나간다. 접힌 목소리 구성이 활성화됐다는 이유만으로
 * 기본 목소리를 조용히 덮지 않는다. 저장된 구성·후보는 삭제하지 않는다 — 보내지 않을 뿐이다.
 *
 * 키 형식은 `speakerEmotionKey` 와 같다: `<speakerId><US><emotionId>` (US = U+001F).
 */
const SEP = String.fromCharCode(31)

export function speakerOfKey(key: string): string {
  const i = key.indexOf(SEP)
  return i < 0 ? key : key.slice(0, i)
}

export function emotionOfKey(key: string): string {
  const i = key.indexOf(SEP)
  return i < 0 ? 'default' : key.slice(i + 1)
}

/** 켜진 인물의 항목만 남긴다. 값의 형태는 묻지 않는다(경로든 선택 토큰이든). */
export function gateSpeakerEmotionRefs<T>(
  refs: Readonly<Record<string, T>>, enabled: Readonly<Record<string, boolean>>
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, v] of Object.entries(refs)) {
    if (enabled[speakerOfKey(k)] === true) out[k] = v
  }
  return out
}

/** 이 인물에 대해 구성이 가진 감정 id 목록(켜짐 여부와 무관 — 화면이 "있음(꺼짐)" 을 말할 때 쓴다). */
export function emotionIdsForSpeaker(
  refs: Readonly<Record<string, unknown>>, speakerId: string
): string[] {
  return Object.entries(refs)
    .filter(([k, v]) => !!v && speakerOfKey(k) === speakerId)
    .map(([k]) => emotionOfKey(k))
}
