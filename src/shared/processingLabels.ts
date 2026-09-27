/**
 * 처리 설정의 **이름표 한 벌** — 빠른 설정과 세부 옵션이 같은 것을 보게 한다.
 *
 * ★왜 생겼나 (2026-09-27)
 *   같은 모델을 두 화면이 각자 적어 두고 있었다. 빠른 설정은 자기가 아는 둘만 알고,
 *   나머지를 쓰는 중이면 **"세부 설정 사용 중"** 이라고만 했다 —
 *   사용자는 **무엇이 걸려 있는지 알 수 없었다.**
 *   이름을 한곳에 두면 빠른 설정이 모르는 모델도 **이름으로** 말할 수 있다.
 *
 * ★선택지를 줄이지 않는다. 이 파일은 **이름만** 안다. 무엇을 보여 줄지는 화면이 정한다.
 */

/** 음악 분리 모델. 세부 옵션이 고를 수 있는 전부다(줄이지 않는다). */
export const DEMUCS_LABELS: Record<string, string> = {
  htdemucs: '기본 4트랙',
  htdemucs_ft: '고품질 4트랙',
  roformer: '보컬 2트랙',
  roformer_melband: '보컬 Mel-Band',
  roformer_ensemble: '보컬 앙상블',
}

/** 받아쓰기 언어. */
export const WHISPER_LANG_LABELS: Record<string, string> = {
  auto: '자동 감지',
  ko: '한국어',
  en: '영어',
  ja: '일본어',
  zh: '중국어',
}

/** 번역 모델. */
export const TRANSLATE_LABELS: Record<string, string> = {
  '600m': '600M',
  '1.3b': '1.3B',
  '3.3b': '3.3B',
}

/**
 * 지금 걸려 있는 것의 **짧은 이름**. 모르는 값이면 값 자체를 돌려준다
 * (빈 이름으로 만들어 '아무것도 아닌 것' 처럼 보이게 하지 않는다).
 */
export function labelOf(table: Record<string, string>, value: string): string {
  const v = String(value || '')
  return table[v] || v || ''
}

/**
 * 빠른 설정이 **직접 고를 수 있는 것**인가.
 * 아니면 화면은 "…사용 중" 으로 **이름을 붙여** 알린다.
 */
export function isQuickChoice(quick: readonly string[], value: string): boolean {
  return quick.includes(String(value || ''))
}
