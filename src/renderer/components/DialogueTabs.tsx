/**
 * `〈 한 명 / 여러 명 〉` — 고급 합성의 **인원 전환**. 두 개뿐인 자리라 좌우 화살표로 옮긴다.
 *
 * ★화살표는 **인원만** 바꾼다. 일반/고급은 위 탭으로만 바꾼다 — 한 조작이 두 가지를 바꾸면
 *   "어디로 가는지" 를 누르기 전에 알 수 없다.
 * ★끝에서 반대편으로 **돌지 않는다.** 한 명에서 왼쪽, 여러 명에서 오른쪽은 꺼져 있다.
 *   돌아가면 두 번 눌렀을 때 제자리로 와서 지금 어디인지 헷갈린다.
 *
 * 누르는 것은 원문을 쓰지 않는다. 변환도 정규화도 확인창도 없다 — 인물 배정·목소리는 그대로다.
 */
import type { CSSProperties } from 'react'

import { DIALOGUE_TAB_LABEL } from './DialogueTabs.logic'
import type { DialogueTab } from './DialogueTabs.logic'
export type { DialogueTab } from './DialogueTabs.logic'

const HINT: Record<DialogueTab, string> = {
  single: '목소리 하나로 대사 전체를 만듭니다',
  multi: '인물마다 목소리를 정하고 대사를 카드로 나눕니다',
}

/** 화살표가 데려갈 자리. 없으면 그 방향은 꺼진다. */
const NEXT: Record<DialogueTab, { left: DialogueTab | null; right: DialogueTab | null }> = {
  single: { left: null, right: 'multi' },
  multi: { left: 'single', right: null },
}

export default function DialogueTabs(props: {
  tab: DialogueTab
  onTab: (tab: DialogueTab) => void
  disabled?: boolean
}) {
  const { tab, onTab, disabled = false } = props
  const go = NEXT[tab]

  const arrow = (off: boolean): CSSProperties => ({
    padding: '8px 14px', border: 'none', background: 'transparent', fontFamily: 'inherit',
    fontSize: 15, lineHeight: 1, borderRadius: 8,
    color: off ? 'var(--text-muted)' : 'var(--cyan)',
    cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.35 : 1,
  })

  const side = (dir: 'left' | 'right') => {
    const to = go[dir]
    const off = disabled || !to
    return (
      <button type="button" data-testid={`dialogue-${dir}`} data-to={to || ''}
        // 이 화살표가 **데려가는 자리**를 표식으로 남긴다 — 예전 탭을 가리키던 자동 검사가
        // 같은 선택자로 같은 전환을 그대로 할 수 있다(동작이 같으므로 표식도 같게 둔다).
        data-tab={to || undefined}
        disabled={off} onClick={() => { if (to && !disabled) onTab(to) }}
        title={to ? `${DIALOGUE_TAB_LABEL[to]}(으)로 바꿉니다 — ${HINT[to]}` : '더 갈 곳이 없습니다'}
        aria-label={to ? `${DIALOGUE_TAB_LABEL[to]}(으)로 바꾸기` : '더 갈 곳이 없습니다'}
        style={arrow(off)}>
        {dir === 'left' ? '‹' : '›'}
      </button>
    )
  }

  return (
    <div data-testid="dialogue-tabs" aria-label="생성 방식"
      style={{ display: 'flex', alignItems: 'center', width: '100%', borderRadius: 10,
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      {side('left')}
      <span data-testid="dialogue-current" role="status" aria-live="polite" title={HINT[tab]}
        style={{
          flex: 1, textAlign: 'center', padding: '10px 8px', fontSize: 13, fontWeight: 700,
          color: 'var(--cyan)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
        {DIALOGUE_TAB_LABEL[tab]}
      </span>
      {side('right')}
    </div>
  )
}
