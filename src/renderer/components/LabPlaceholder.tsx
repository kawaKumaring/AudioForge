// 테스트개발 — **아직 아무것도 없는 자리**.
//
// 예전 작업실은 '합성 > 일반' 으로 옮겼다. 이 탭은 다음에 시험해 볼 것을 놓을 자리로 남겨 둔다.
// ★없는 기능을 채워 넣거나 일정을 약속하지 않는다. 옮겨 간 자리로 가는 길만 하나 둔다.
// ★작업실 화면을 여기 한 번 더 그리지 않는다 — 같은 작업이 두 자리에 있으면 어느 쪽이 진짜인지
//   알 수 없게 된다.
import { useAppStore } from '@/stores/app.store'

export default function LabPlaceholder() {
  const setMode = useAppStore((s) => s.setMode)
  const setSynthesisTab = useAppStore((s) => s.setSynthesisTab)

  return (
    <div data-testid="lab-placeholder" style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10,
      padding: '36px 24px', borderRadius: 12,
      background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
    }}>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" />
      </svg>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>아이디어 준비 중</div>
      <div style={{ fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)', textAlign: 'center' }}>
        새로운 기능을 준비하면 이곳에서 먼저 사용해 볼 수 있습니다.<br />
        기존 작업실은 ‘합성 &gt; 일반’으로 이동했습니다.
      </div>
      <button data-testid="lab-goto-basic"
        onClick={() => { setSynthesisTab('basic'); setMode('tts') }}
        style={{
          marginTop: 4, padding: '8px 16px', borderRadius: 8, border: 'none',
          fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer',
          background: 'var(--accent)', color: '#fff',
        }}>
        일반 합성 열기
      </button>
    </div>
  )
}
