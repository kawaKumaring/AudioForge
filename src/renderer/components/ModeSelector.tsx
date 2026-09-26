import type { ReactNode } from 'react'
import { useAppStore } from '@/stores/app.store'
import { isCancelCleanupBusy } from '../../shared/cancelContract'
import type { SeparationMode } from '../../shared/types'

type WorkspaceInfo = { label: string; description: string; group: string; icon: ReactNode }
const icon = (paths: ReactNode) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>

export const WORKSPACES: Record<SeparationMode, WorkspaceInfo> = {
  'dialogue-rebuild': { label: '대화 구간 편집', group: '파일에서 시작', description: '수정한 대화 구간을 저장합니다.', icon: icon(<path d="M4 6h16M4 12h16M4 18h10"/>) },
  music: { label: '음악 분리', group: '파일에서 시작', description: '보컬과 악기를 나누고, 필요한 소리를 골라 저장하세요.', icon: icon(<><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></>) },
  conversation: { label: '대화 분리', group: '파일에서 시작', description: '대화 속 목소리를 나누고, 화자별 구간을 확인하세요.', icon: icon(<><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a5 5 0 0 1 10 0v3M17 4a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 4v3"/></>) },
  transcribe: { label: '텍스트 추출', group: '파일에서 시작', description: '음성을 글로 옮긴 뒤, 내용을 다듬고 번역하세요.', icon: icon(<><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6"/></>) },
  split: { label: '트랙 분할', group: '파일에서 시작', description: '파형을 들으며 구간을 나누고, 각각의 파일로 저장하세요.', icon: icon(<><path d="M12 3v18M3 8h5M3 12h5M3 16h5M16 8h5M16 12h5M16 16h5"/></>) },
  tts: { label: '음성 합성', group: '새 콘텐츠 만들기', description: '목소리를 고르고 대본을 작성해, 원하는 음성으로 완성하세요.', icon: icon(<><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>) },
  dub: { label: '노래 변환', group: '새 콘텐츠 만들기', description: '원곡의 목소리 변환 · 번역 가창은 후속 개발. 현재 화면의 더빙 경로와 노래 변환 코드 연결을 정리하는 중입니다.', icon: icon(<><path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/></>) },
  lab: { label: '실험실', group: '새 콘텐츠 만들기', description: '개발 중인 기능을 확인하세요.', icon: icon(<><path d="M9 3h6M10 3v6L5 19h14L14 9V3"/></>) }
}

const groups: { label: string; modes: SeparationMode[] }[] = [
  { label: '파일에서 시작', modes: ['music', 'conversation', 'transcribe', 'split'] },
  { label: '새 콘텐츠 만들기', modes: ['tts', 'dub'] }
]

export default function ModeSelector() {
  const { mode, setMode, status, errorInfo } = useAppStore()
  const disabled = status === 'processing' || isCancelCleanupBusy(status) || !!errorInfo?.childAlive
  return <nav aria-label="작업 선택" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
    {groups.map(group => <div key={group.label}>
      <div style={{ padding: '0 12px', marginBottom: 9, fontSize: 11, fontWeight: 500, color: 'var(--text-muted)' }}>{group.label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {group.modes.map(id => {
          const item = WORKSPACES[id]
          const active = mode === id
          return <button key={id} type="button" data-testid={`mode-${id}`} aria-current={active ? 'page' : undefined}
            onClick={() => setMode(id)} disabled={disabled}
            className="workspace-nav-item" title={disabled ? '진행 중인 작업이 끝나면 이동할 수 있습니다.' : item.description}
            style={{ display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '12px', borderRadius: 9,
              border: `1px solid ${active ? 'var(--border-accent)' : 'transparent'}`,
              background: active ? 'var(--accent-glow)' : 'transparent', color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontFamily: 'inherit', fontSize: 13, fontWeight: active ? 600 : 400, textAlign: 'left', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled && !active ? 0.45 : 1 }}>
            <span style={{ display: 'flex', color: active ? 'var(--accent-light)' : 'inherit' }}>{item.icon}</span>
            <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{item.label}</span>
            {id === 'dub' && <span style={{ fontSize: 9, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>개발 중</span>}
          </button>
        })}
      </div>
    </div>)}
  </nav>
}
