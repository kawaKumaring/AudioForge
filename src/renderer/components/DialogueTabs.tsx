/**
 * `한 명 | 여러 명` — 합성 화면 **전체를 전환하는 탭**. 합성 메뉴 바로 아래, 전체 폭(분할 화면의
 * `타임스탬프 입력 | 자동 감지` 와 같은 위치·계층). 대사 편집기의 옵션이 아니다.
 *
 * 탭을 누르는 것은 원문을 쓰지 않는다. 변환도 정규화도 확인창도 없다. 여러 명 화면으로 표현할 수
 * 없는 대본이면 그 탭 안에서 원문 편집기를 그대로 보여 주고 이유만 말한다.
 */
import type { CSSProperties } from 'react'

import { DIALOGUE_TABS, DIALOGUE_TAB_LABEL } from './DialogueTabs.logic'
import type { DialogueTab } from './DialogueTabs.logic'
export type { DialogueTab } from './DialogueTabs.logic'

const HINT: Record<DialogueTab, string> = {
  single: '목소리 하나로 대사 전체를 만듭니다',
  multi: '인물마다 목소리를 정하고 대사를 카드로 나눕니다',
}

export default function DialogueTabs(props: {
  tab: DialogueTab
  onTab: (tab: DialogueTab) => void
  disabled?: boolean
}) {
  const { tab, onTab, disabled = false } = props
  const seg = (active: boolean): CSSProperties => ({
    flex: '1 1 0', minWidth: 0, padding: '10px 12px', border: 'none', fontFamily: 'inherit',
    fontSize: 13, fontWeight: active ? 700 : 600, cursor: disabled ? 'not-allowed' : 'pointer',
    background: active ? 'var(--bg-elevated)' : 'transparent',
    color: active ? 'var(--cyan)' : 'var(--text-secondary)',
    borderBottom: active ? '2px solid var(--cyan)' : '2px solid transparent',
    opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  })
  return (
    <div role="tablist" aria-label="생성 방식" data-testid="dialogue-tabs"
      style={{ display: 'flex', width: '100%', borderRadius: 10, overflow: 'hidden',
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      {DIALOGUE_TABS.map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t}
          data-tab={t} disabled={disabled} title={HINT[t]}
          onClick={() => { if (!disabled) onTab(t) }}   /* 원문 쓰기 없음 — 상태만 바뀐다 */
          style={seg(tab === t)}>
          {DIALOGUE_TAB_LABEL[t]}
        </button>
      ))}
    </div>
  )
}
