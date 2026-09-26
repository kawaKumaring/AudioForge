// 합성은 문장별 생성본을 고르는 작업과 대본·배역을 한 번에 만드는 작업을 제공한다.
// 탭 전환은 작업을 보존한다. 대본 복사는 각 화면의 명시적인 '이어 쓰기'로만 수행한다.
import { useRef, type KeyboardEvent } from 'react'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import { useAppStore } from '@/stores/app.store'
import type { SynthesisTab } from '@/stores/app.store'
import LabWorkspace from '@/components/LabWorkspace'
import TTSEditor from '@/components/TTSEditor'
import SynthesisCardWorkspace from './SynthesisCardWorkspace'
import { useSynthesisCards } from '../stores/synthesisCards.store'


const LABEL: Record<SynthesisTab, string> = { basic: '문장별 제작', advanced: '대본·배역 편집' }
const HINT: Record<SynthesisTab, string> = {
  basic: '한 목소리로 문장마다 만들고, 생성본을 골라 이어 붙입니다.',
  advanced: '대본 전체의 배역·감정·쉼을 정하고 한 번에 만듭니다.',
}

export default function SynthesisTabs() {
  const view = useSynthesisCards(s => s.view)
  const status = useAppStore(s => s.status)
  const childAlive = useAppStore(s => s.errorInfo?.childAlive)
  const busy = status === 'processing' || isCancelCleanupBusy(status) || !!childAlive
  if (view === 'cards') return <SynthesisCardWorkspace />
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <button type="button" data-testid="back-to-generation-cards" disabled={busy} onClick={() => useSynthesisCards.getState().setView('cards')}
      style={{ alignSelf: 'flex-start', padding: '7px 10px', border: '1px solid var(--border-subtle)', borderRadius: 7, background: 'transparent', color: 'var(--text-secondary)', font: 'inherit', fontSize: 12, cursor: 'pointer' }}>← 생성 카드</button>
    <LegacySynthesisTabs />
  </div>
}

function LegacySynthesisTabs() {
  const tab = useAppStore((s) => s.synthesisTab)
  const setTab = useAppStore((s) => s.setSynthesisTab)
  const status = useAppStore((s) => s.status)
  const childAlive = useAppStore((s) => s.errorInfo?.childAlive === true)
  const disabled = status === 'processing' || isCancelCleanupBusy(status) || childAlive
  const tabButtons = useRef<Partial<Record<SynthesisTab, HTMLButtonElement | null>>>({})
  const moveTab = (e: KeyboardEvent<HTMLButtonElement>, current: SynthesisTab) => {
    if (disabled || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const next: SynthesisTab = e.key === 'Home' ? 'basic' : e.key === 'End' ? 'advanced'
      : current === 'basic' ? 'advanced' : 'basic'
    setTab(next)
    tabButtons.current[next]?.focus()
  }
  const seg = (active: boolean) => ({
    flex: '0 1 auto', minWidth: 0, padding: '14px 18px', border: 'none', fontFamily: 'inherit',
    fontSize: 13, fontWeight: active ? 700 : 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    opacity: disabled ? 0.5 : 1,
  })

  return (
    <div className="synthesis-workbench" data-testid="synthesis-workbench" style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--border-subtle)', borderRadius: 12, background: 'var(--bg-card)', boxShadow: '0 12px 36px rgba(0,0,0,.12)' }}>
      <div role="tablist" aria-label="합성 방식" data-testid="synthesis-tabs"
        style={{
          display: 'flex', width: '100%', padding: '0 12px',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
        {(['basic', 'advanced'] as SynthesisTab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            id={`synthesis-tab-${t}`} aria-controls={`synthesis-panel-${t}`}
            tabIndex={tab === t ? 0 : -1} ref={(el) => { tabButtons.current[t] = el }}
            onKeyDown={(e) => moveTab(e, t)}
            data-testid={`synthesis-tab-${t}`} disabled={disabled} title={HINT[t]}
            onClick={() => { if (!disabled) setTab(t) }}
            style={seg(tab === t)}>
            <span style={{ display: 'block' }}>{LABEL[t]}</span>

          </button>
        ))}
      </div>

      <div role="tabpanel" id={`synthesis-panel-${tab}`} aria-labelledby={`synthesis-tab-${tab}`}
        style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {tab === 'basic' ? <LabWorkspace /> : <TTSEditor />}
      </div>
    </div>
  )
}
