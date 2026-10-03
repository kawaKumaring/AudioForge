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

/**
 * 음성 합성 안의 **버전 전환 탭** — [개발 중] / [옛 버전].
 *
 * ★왜 탭인가 (2026-09-27 사용자 제안)
 *   '이전 작업' 단추는 한쪽으로 빠져나가는 문이라 **두 버전을 견주기 어려웠다.**
 *   같은 자리에서 번갈아 보이면 비교가 쉽다. 사이드바의 음성 합성은 하나 그대로다.
 *
 * ★임시 구성이다. 카드로 기능과 기존 작업을 안전하게 옮긴 뒤 옛 버전을 뺀다.
 *   **지금 지우지 않는다** — 옮길 수 있음을 확인하기 전에 문을 닫지 않는다.
 *
 * 전환은 **보여 주는 것만 바꾼다.** 각 버전의 대사·목소리·설정·생성본은 서로 다른 자리에
 * 살아 있으므로(생성 카드는 synthesisCards, 옛 버전은 lab/app store) 오가도 그대로다.
 * 전환이 작업을 베끼거나 덮어쓰지 않는다 — 옮기는 일은 따로 만든다.
 */
const VERSION_HINT = {
  cards: '지금 만들고 있는 생성 카드 화면입니다. 카드 하나가 목소리·대사·설정·생성본을 함께 가집니다.',
  legacy: '예전 문장별 제작과 대본·배역 편집 화면입니다. 비교와 확인을 위해 당분간 함께 둡니다.',
} as const

export default function SynthesisTabs() {
  const view = useSynthesisCards(s => s.view)
  const setView = useSynthesisCards(s => s.setView)
  const status = useAppStore(s => s.status)
  const childAlive = useAppStore(s => s.errorInfo?.childAlive)
  // 생성 중에는 옮기지 않는다 — 기존 전환 제한을 그대로 둔다.
  const busy = status === 'processing' || isCancelCleanupBusy(status) || !!childAlive

  const versionButtons = useRef<Partial<Record<'cards' | 'legacy', HTMLButtonElement | null>>>({})
  const moveVersion = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    if (busy) return
    const next = e.key === 'Home' ? 'cards' : e.key === 'End' ? 'legacy' : view === 'cards' ? 'legacy' : 'cards'
    setView(next)
    versionButtons.current[next]?.focus()
  }
  const seg = (active: boolean): React.CSSProperties => ({
    padding: '9px 16px', border: 'none', borderRadius: 0, fontFamily: 'inherit',
    fontSize: 12.5, fontWeight: active ? 700 : 600,
    background: 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-muted)',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    cursor: busy ? 'not-allowed' : 'pointer', opacity: busy && !active ? .5 : 1,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div role="tablist" aria-label="합성 화면 버전" data-testid="synthesis-version-tabs"
        style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)' }}>
        <button type="button" role="tab" aria-selected={view === 'cards'}
          id="synthesis-version-cards" aria-controls="synthesis-version-panel-cards" tabIndex={view === 'cards' ? 0 : -1}
          ref={el => { versionButtons.current.cards = el }} onKeyDown={moveVersion}
          data-testid="back-to-generation-cards" disabled={busy && view !== 'cards'}
          title={VERSION_HINT.cards} onClick={() => { if (!busy) setView('cards') }}
          style={seg(view === 'cards')}>개발 중</button>
        <button type="button" role="tab" aria-selected={view === 'legacy'}
          id="synthesis-version-legacy" aria-controls="synthesis-version-panel-legacy" tabIndex={view === 'legacy' ? 0 : -1}
          ref={el => { versionButtons.current.legacy = el }} onKeyDown={moveVersion}
          data-testid="open-legacy-synthesis" disabled={busy && view !== 'legacy'}
          title={VERSION_HINT.legacy} onClick={() => { if (!busy) setView('legacy') }}
          style={seg(view === 'legacy')}>옛 버전</button>
      </div>
      <div role="tabpanel" id={`synthesis-version-panel-${view}`} aria-labelledby={`synthesis-version-${view}`} style={{ minWidth: 0 }}>
        {view === 'cards' ? <SynthesisCardWorkspace /> : <LegacySynthesisTabs />}
      </div>
    </div>
  )
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
