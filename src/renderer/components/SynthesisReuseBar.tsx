import type { ReactNode } from 'react'

/** 탭 전환과 복사를 분리한다. 펼쳐서 읽고 누른 대본만 현재 작업 끝에 추가한다. */
export default function SynthesisReuseBar({ id, source, available, disabled, detail, onAppend, children }: {
  id: 'lab' | 'tts'
  source: string
  available: boolean
  disabled: boolean
  detail: string
  onAppend: () => void
  children?: ReactNode
}) {
  return (
    <details title={detail} style={{ position: 'relative', marginLeft: 'auto', fontSize: 11, flexShrink: 0 }}>
      <summary data-testid={id + '-reuse-draft-toggle'} style={{ cursor: 'pointer', color: 'var(--text-muted)', padding: '6px 8px', borderRadius: 6 }}>
        대본 가져오기
      </summary>
      <div style={{ position: 'absolute', right: 0, top: '100%', zIndex: 20, padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-elevated)', boxShadow: '0 8px 24px #0005', width: 'max-content', maxWidth: 'min(300px, 65vw)' }}>
        <button type="button" data-testid={id === 'lab' ? 'lab-append-advanced-script' : 'tts-append-sentence-script'}
          disabled={disabled || !available} onClick={onAppend} title={detail}
          style={{ padding: '7px 11px', borderRadius: 7, border: '1px solid var(--border-accent)',
            background: 'var(--accent-glow)', color: 'var(--accent-light)', font: 'inherit',
            cursor: disabled || !available ? 'default' : 'pointer', opacity: disabled || !available ? 0.5 : 1 }}>
          {source} 대본 추가
        </button>
        {children}
      </div>
    </details>
  )
}
