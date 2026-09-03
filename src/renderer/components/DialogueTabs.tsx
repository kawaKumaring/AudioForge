/**
 * `한 명 | 여러 명` — **보기 전환일 뿐이다.** 탭을 누르는 것은 원문을 쓰지 않는다.
 *
 * 변환도 정규화도 확인창도 없다. 여러 명 화면으로 표현할 수 없는 대본이면 그 탭 안에서
 * 원문 편집기를 그대로 보여 주고 이유만 말한다.
 */
import type { CSSProperties } from 'react'

import { DIALOGUE_TABS, DIALOGUE_TAB_LABEL } from './DialogueTabs.logic'
import type { DialogueTab } from './DialogueTabs.logic'
export type { DialogueTab } from './DialogueTabs.logic'

export default function DialogueTabs(props: {
  tab: DialogueTab
  onTab: (tab: DialogueTab) => void
  disabled?: boolean
}) {
  const { tab, onTab, disabled = false } = props
  const btn = (active: boolean): CSSProperties => ({
    padding: '4px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
    cursor: disabled ? 'not-allowed' : 'pointer', border: 'none',
    background: active ? 'var(--cyan)' : 'var(--bg-elevated)',
    color: active ? 'var(--bg-primary, #0b0f14)' : 'var(--text-secondary)',
    opacity: disabled ? 0.5 : 1,
  })
  return (
    <div role="tablist" aria-label="대사 입력 방식" data-testid="dialogue-tabs"
      style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {DIALOGUE_TABS.map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t}
          data-tab={t} disabled={disabled}
          onClick={() => { if (!disabled) onTab(t) }}   /* 원문 쓰기 없음 — 상태만 바뀐다 */
          style={btn(tab === t)}>
          {DIALOGUE_TAB_LABEL[t]}
        </button>
      ))}
    </div>
  )
}
