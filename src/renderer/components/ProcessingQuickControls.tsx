import { useAppStore } from '@/stores/app.store'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import type { CSSProperties } from 'react'
import {
  DEMUCS_LABELS, WHISPER_LANG_LABELS, labelOf, isQuickChoice,
} from '../../shared/processingLabels'

/** 빠른 설정이 직접 고르는 것. 나머지는 이름을 붙여 알린다(선택지를 줄이지 않는다). */
const QUICK_DEMUCS = ['roformer', 'htdemucs'] as const

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const choice: CSSProperties = { font: 'inherit', fontSize: 12, padding: '10px 13px', borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-secondary)', cursor: 'pointer' }
/** Existing settings only. No new processing policy or implicit model fallback. */
export default function ProcessingQuickControls() {
  const s = useAppStore()
  const disabled = s.status === 'processing' || isCancelCleanupBusy(s.status) || !!s.errorInfo?.childAlive
  const pill = (label: string, selected: boolean, act: () => void, title: string) => <button type="button" key={label} aria-pressed={selected} disabled={disabled} title={title} onClick={act} style={{ ...choice, borderColor: selected ? 'var(--border-accent)' : 'var(--border-subtle)', background: selected ? 'var(--accent-glow)' : 'var(--bg-base)', color: selected ? 'var(--accent-light)' : 'var(--text-secondary)' }}>{label}</button>
  return <section aria-label="빠른 작업 설정" style={{ padding: 16, borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 12 }}>
    {s.mode === 'music' && <>
      <div style={{ fontSize: 12, fontWeight: 600 }}>분리할 소리</div>
      <div style={row}>
        {pill('보컬 · 반주', s.demucsModel === 'roformer', () => s.setDemucsModel('roformer'), 'BS-RoFormer로 보컬과 반주를 분리합니다')}
        {pill('악기별 4트랙', s.demucsModel === 'htdemucs', () => s.setDemucsModel('htdemucs'), '기본 Demucs로 보컬·드럼·베이스·나머지를 분리합니다')}
        {/* ★빠른 설정에 없는 모델이면 **이름을 말한다**(2026-09-27 지시 6).
            "세부 설정 사용 중" 만으로는 무엇이 걸려 있는지 알 수 없다. 선택지는 줄이지 않았다. */}
        {!isQuickChoice(QUICK_DEMUCS, s.demucsModel) && (
          <span data-testid="quick-demucs-current" style={{ fontSize: 11, color: 'var(--text-muted)' }}
            title="세부 옵션에서 고른 모델입니다. 바꾸려면 세부 옵션을 여세요.">
            {labelOf(DEMUCS_LABELS, s.demucsModel)} 사용 중
          </span>
        )}
      </div>
    </>}
    {s.mode === 'conversation' && <>
      <div style={{ fontSize: 12, fontWeight: 600 }}>대화 인원</div>
      <div role="group" aria-label="대화 인원" style={row}>{[2, 3, 4, 5].map(n => pill(`${n}명`, s.nSpeakers === n, () => s.setNSpeakers(n), `화자 ${n}명을 기준으로 분리합니다`))}</div>
    </>}
    {s.mode === 'transcribe' && <div style={row}>
      <label style={{ ...row, fontSize: 12 }}>음성 언어<select aria-label="빠른 음성 언어" disabled={disabled} value={s.whisperLang} onChange={e => s.setWhisperLang(e.target.value)} style={choice}>
        {Object.keys(WHISPER_LANG_LABELS).map((v)=><option key={v} value={v}>{labelOf(WHISPER_LANG_LABELS, v)}</option>)}
      </select></label>
      {pill('SRT 자막 함께 저장', s.exportSrt, () => s.setExportSrt(!s.exportSrt), '받아쓰기와 함께 시간 정보가 있는 자막 파일을 만듭니다')}
    </div>}
  </section>
}
