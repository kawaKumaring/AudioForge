import { useAppStore } from '@/stores/app.store'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from './kit'
import { DEMUCS_LABELS, WHISPER_LANG_LABELS, labelOf, isQuickChoice } from '../../shared/processingLabels'

const QUICK_DEMUCS = ['roformer', 'htdemucs'] as const
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 12 }

/** 큰 카드는 설명 대신 작업의 모양을 보여 준다. 기존 설정과 엔진 연결은 유지한다. */
export default function ProcessingQuickControls() {
  const s = useAppStore()
  const disabled = s.status === 'processing' || isCancelCleanupBusy(s.status) || !!s.errorInfo?.childAlive
  const color = 'var(--accent-light)'
  const card = (label: string, selected: boolean, act: () => void, title: string, art: ReactNode) => <button type="button" key={label}
    aria-label={label} aria-pressed={selected} disabled={disabled} title={title} onClick={act}
    style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 20, minWidth: 0, padding: '18px 20px', borderRadius: 12,
      border: `1px solid ${selected ? color : 'transparent'}`, background: selected ? 'var(--accent-glow)' : 'var(--bg-base)',
      color: selected ? color : 'var(--text-muted)', font: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? .5 : 1, textAlign: 'left' }}>
    <span aria-hidden="true" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>{art}</span>
    <span style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
      {label}<span aria-hidden="true" style={{ width: 19, height: 19, flexShrink: 0, border: `1px solid ${selected ? color : 'var(--border-subtle)'}`, borderRadius: '50%', display: 'grid', placeItems: 'center', color }}>{selected && <Icon name="check" size={12}/>}</span>
    </span>
  </button>
  const layers = (count: number) => <svg width="68" height="32" viewBox="0 0 68 32" fill="none" aria-hidden="true">
    {Array.from({ length: count }, (_,i) => <g key={i} opacity={1 - i * .14}><rect x="1" y={i * (30 / count) + 1} width="65" height={24 / count} rx="2" fill="currentColor" opacity=".13"/><path d={`M7 ${i * (30 / count) + 1 + 12 / count}h${42 - i * 6}`} stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></g>)}
  </svg>
  const heading = s.mode === 'music' ? '어떤 소리를 나눌까요?' : s.mode === 'conversation' ? '몇 명의 대화인가요?' : '어떻게 받아쓸까요?'
  return <section aria-label="빠른 작업 설정" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: '-.025em' }}>{heading}</div>
    {s.mode === 'music' && <>
      <div style={grid}>
        {card('보컬 · 반주', s.demucsModel === 'roformer', () => s.setDemucsModel('roformer'), 'BS-RoFormer로 보컬과 반주를 분리합니다', layers(2))}
        {card('악기별 4트랙', s.demucsModel === 'htdemucs', () => s.setDemucsModel('htdemucs'), '기본 Demucs로 보컬·드럼·베이스·나머지를 분리합니다', layers(4))}
      </div>
      {!isQuickChoice(QUICK_DEMUCS, s.demucsModel) && <span data-testid="quick-demucs-current" style={{ fontSize: 12, color }} title="세부 옵션에서 고른 모델입니다">{labelOf(DEMUCS_LABELS, s.demucsModel)} 사용 중</span>}
    </>}
    {s.mode === 'conversation' && <div role="group" aria-label="대화 인원" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 175px), 1fr))', gap: 10 }}>
      {[2, 3, 4, 5].map(n => card(`${n}명`, s.nSpeakers === n, () => s.setNSpeakers(n), `화자 ${n}명을 기준으로 분리합니다`,
        <span style={{ display: 'flex', gap: 2 }}>{Array.from({ length: n }, (_, i) => <svg key={i} width="14" height="23" viewBox="0 0 14 23" aria-hidden="true"><circle cx="7" cy="5" r="3" fill="currentColor"/><path d="M2 20v-6a5 5 0 0 1 10 0v6" fill="currentColor" opacity=".35"/></svg>)}</span>))}
    </div>}
    {s.mode === 'transcribe' && <div style={grid}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '18px 20px', borderRadius: 12, border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', minWidth: 0 }}>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', color, fontSize: 12 }}><Icon name="voice"/>음성 언어</span>
        <select aria-label="빠른 음성 언어" disabled={disabled} value={s.whisperLang} onChange={e => s.setWhisperLang(e.target.value)}
          style={{ font: 'inherit', fontSize: 14, minWidth: 0, padding: '5px 0', border: 'none', background: 'var(--bg-base)', color: 'var(--text-primary)', cursor: 'pointer' }}>
          {Object.keys(WHISPER_LANG_LABELS).map(v => <option key={v} value={v}>{labelOf(WHISPER_LANG_LABELS, v)}</option>)}
        </select>
      </label>
      {card('SRT 자막 함께 저장', s.exportSrt, () => s.setExportSrt(!s.exportSrt), '받아쓰기와 함께 시간 정보가 있는 자막 파일을 만듭니다', <Icon name="text" size={26}/>)}
    </div>}
  </section>
}
