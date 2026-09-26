// 테스트개발 — **아직 아무것도 없는 자리**.
//
// 예전 작업실은 '합성 > 일반' 으로 옮겼다. 이 탭은 다음에 시험해 볼 것을 놓을 자리로 남겨 둔다.
// ★없는 기능을 채워 넣거나 일정을 약속하지 않는다. 옮겨 간 자리로 가는 길만 하나 둔다.
// ★작업실 화면을 여기 한 번 더 그리지 않는다 — 같은 작업이 두 자리에 있으면 어느 쪽이 진짜인지
//   알 수 없게 된다.
//
// ── 이 자리를 쓰는 규칙 (2026-09-20, doc/dev-rules.md 8장) ────────────────────
// 새 기능은 **처음부터 제 자리에서** 만든다. 여기서 만들었다가 옮기지 않는다.
//
//   1. 만드는 동안: 그 새 기능이 이 자리의 **이름표와 아이콘('테스트개발')을 빌린다.**
//      이 안내 화면은 그동안 숨긴다. 자리는 하나이므로 **한 번에 하나만** 만든다.
//   2. 완성되면: **이름표와 아이콘만** 진짜 것으로 바꾼다(ModeSelector 의 그 줄).
//      코드는 한 줄도 옮기지 않는다.
//   3. 그 뒤: 이 안내 자리를 다시 켜고, 여기에 **방금 완성한 기능으로 가는 링크**를 더한다.
//      이 자리는 "여기서 나온 것들" 의 목록이 된다.
//
// ★**내부 이름은 첫 줄부터 최종 것을 쓴다.** 모드 열쇠·저장 열쇠·파생 클립 자리(clipKey)는
//   화면 이름표와 무관하게 처음부터 최종 이름이어야 한다. 임시인 것은 **보이는 글자뿐**이다.
//
// 왜 이렇게 하는가 — 값을 치렀다. 합성(일반) 작업실을 이 자리에서 만든 뒤 합성 안으로 **옮겼고**,
// 그때 시제품 시절의 클립 자리('default')가 그대로 따라왔다. 따로 들어가는 탭일 때는 보이지 않던
// 것이 첫 화면이 되자 **아무것도 하지 않아도 고급의 목소리를 지웠다**(2026-09-16 실사용 결함).
// 옮긴 뒤 이 빈 자리가 잔재로 남았고, 검사 셋은 아직도 사라진 화면을 찾는다.
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
