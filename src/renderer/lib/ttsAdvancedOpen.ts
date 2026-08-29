// 고급 설정의 특정 자리를 화면 다른 곳에서 열어 달라고 부탁하는 얇은 등록소.
//
// 왜 필요한가: 결과 오류 카드(TrackList)의 '참조 전사 확인'은 지금까지
// document.getElementById('tts-reference-transcript') 로 곧장 스크롤했다. PHASE B 에서 참조 전사는
// 기본 화면을 떠나 '고급 설정 > 음성' 안으로 들어갔고, 접혀 있으면 그 요소가 DOM 에 없다 —
// 버튼이 아무 일도 하지 않는 막다른 길이 된다. 그래서 '열어 달라'는 요청만 전달하고,
// 실제로 무엇을 여는지는 TTSEditor 셸이 정한다(상태 권위는 셸 하나).
//
// store 에 새 축을 만들지 않는다 — 이것은 저장·재현되는 설정이 아니라 일회성 UI 요청이다.
// (TTSEditor 의 setReferencePreviewErrorSink 와 같은 패턴.)

export type TtsAdvancedTarget = 'referenceTranscript'

type Opener = (target: TtsAdvancedTarget) => void

let _opener: Opener | null = null

/** TTSEditor 셸이 마운트되는 동안 자기 열기 함수를 등록한다. 해제는 null. */
export function setTtsAdvancedOpener(fn: Opener | null): void {
  _opener = fn
}

/** 고급 설정의 target 자리를 연다. 셸이 없으면(다른 모드 등) false — 호출부가 조용히 넘어갈 수 있다. */
export function openTtsAdvanced(target: TtsAdvancedTarget): boolean {
  if (!_opener) return false
  _opener(target)
  return true
}
