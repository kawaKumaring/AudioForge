// 목소리 단계의 배역 구성 선택. 한 명·여러 명을 동시에 보여 준다.
// 보기 변경은 대본·목소리 지정과 합성 방식을 변경하지 않는다.
import { DIALOGUE_TAB_LABEL } from './DialogueTabs.logic'
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
  return (
    <div data-testid="dialogue-tabs" role="group" aria-label="읽을 목소리 구성"
      style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>

      {(['single', 'multi'] as DialogueTab[]).map(t => <button key={t} type="button"
        data-testid={t === 'single' ? 'dialogue-left' : 'dialogue-right'} data-tab={t}
        aria-pressed={tab === t} disabled={disabled} title={HINT[t]}
        onClick={() => { if (tab !== t) onTab(t) }} style={{ padding: '5px 9px', borderRadius: 7, font: 'inherit', fontSize: 12,
          border: tab === t ? '1px solid var(--border-accent)' : '1px solid var(--border-subtle)',
          background: tab === t ? 'var(--accent-glow)' : 'transparent',
          color: tab === t ? 'var(--accent-light)' : 'var(--text-secondary)', cursor: disabled || tab === t ? 'default' : 'pointer' }}>
        <span data-testid={tab === t ? 'dialogue-current' : undefined}>{DIALOGUE_TAB_LABEL[t]}</span>
      </button>)}
    </div>
  )
}
