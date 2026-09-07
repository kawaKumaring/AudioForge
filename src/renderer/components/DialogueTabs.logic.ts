/**
 * 탭 상수 — 의존성 없이 둔다. `.tsx` 는 `node --test` 가 직접 읽을 수 없으므로(JSX 미지원)
 * 이름과 라벨만 여기 떼어 놓는다. 다른 모듈을 값으로 import 하지 않는다.
 */
export const DIALOGUE_TABS = ['single', 'multi'] as const
export type DialogueTab = typeof DIALOGUE_TABS[number]

export const DIALOGUE_TAB_LABEL: Record<DialogueTab, string> = {
  single: '한 명',
  multi: '여러 명',
}
