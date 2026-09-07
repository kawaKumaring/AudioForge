/**
 * 후보 목록의 순수 문구 — 의존성 없이 둔다.
 *
 * `.tsx` 는 `node --test` 가 직접 읽을 수 없으므로(JSX 미지원) 문구 규칙만 여기 떼어
 * 놓는다. 이 파일은 다른 모듈을 값으로 import 하지 않는다.
 */

/**
 * 후보 수에 따른 머리말.
 *
 * 하나뿐일 때 비교를 말하지 않는다 — "추천 / 최적 / 정확도" 는 고를 여지가 있을 때만
 * 뜻이 있는 말이다.
 */
export function candidateCountText(count: number): string {
  if (count === 0) return '이 인물에게 등록된 목소리가 없습니다'
  if (count === 1) return '이 인물의 참조가 하나뿐입니다 — 비교할 후보가 없습니다'
  return `후보 ${count}개`
}
