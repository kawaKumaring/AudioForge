import { useAppStore } from '@/stores/app.store'
import type { SeparationMode } from '../../../shared/types'

const modes: { id: SeparationMode; label: string; short: string; icon: JSX.Element }[] = [
  {
    id: 'music', label: '음악 분리', short: '음악',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
  },
  {
    id: 'conversation', label: '대화 분리', short: '대화',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
  },
  {
    id: 'transcribe', label: '텍스트 추출', short: '텍스트',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /></svg>
  },
  {
    id: 'split', label: '트랙 분할', short: '분할',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
  },
  {
    id: 'tts', label: '음성 합성', short: '합성',
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /></svg>
  }
]

const MODE_COLORS: Record<string, string> = {
  music: 'var(--accent)',
  conversation: 'var(--cyan)',
  transcribe: 'var(--emerald)',
  split: 'var(--amber)',
  tts: 'var(--rose)'
}

export default function ModeSelector() {
  const { mode, setMode, status } = useAppStore()
  const disabled = status === 'processing'

  return (
    <div style={{
      display: 'flex', borderRadius: 12, overflow: 'hidden',
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)'
    }}>
      {modes.map((m) => {
        const active = mode === m.id
        const color = MODE_COLORS[m.id]
        return (
          <button
            key={m.id}
            onClick={() => !disabled && setMode(m.id)}
            disabled={disabled}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
              padding: '8px 0', border: 'none', outline: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit', fontSize: 10, fontWeight: active ? 600 : 500,
              background: active ? `${color}18` : 'transparent',
              color: active ? color : 'var(--text-muted)',
              borderBottom: active ? `2px solid ${color}` : '2px solid transparent',
              opacity: disabled ? 0.5 : 1,
              transition: 'all 0.15s ease'
            }}
          >
            {m.icon}
            {m.short}
          </button>
        )
      })}
    </div>
  )
}
