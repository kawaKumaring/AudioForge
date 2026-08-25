import { useCallback, useEffect, useRef, useState } from 'react'
import { runtimeStatusView, type RuntimeStatusReport } from '../../shared/runtimeStatus'
import RuntimeProvisionPanel from './RuntimeProvisionPanel'

// 음성 엔진 관리 모달 — 메인 화면에서 걷어낸 개발자용 기능을 전부 여기에 모은다.
//   독립 환경 설치 · 기존 환경 사용 · 설치 위치 변경 · 다시 검사 · 설치 계획 보기 · 진단 상세
// 메인 화면은 상태 한 줄 + 기본 버튼 하나만 유지한다(모순 문구 0).
//
// intent는 어느 버튼으로 들어왔는지다: manage(준비됨) / setup(설정 필요) / troubleshoot(오류).
// 어떤 intent든 같은 기능에 도달할 수 있고, 처음 펼쳐지는 섹션만 다르다.

export type RuntimeManagerIntent = 'manage' | 'setup' | 'troubleshoot'

const TITLE: Record<RuntimeManagerIntent, string> = {
  manage: '음성 엔진 관리',
  setup: '음성 엔진 설정',
  troubleshoot: '음성 엔진 문제 해결',
}

const sectionStyle: React.CSSProperties = {
  padding: '12px 14px', borderRadius: 12,
  background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
}

const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }
const helpStyle: React.CSSProperties = {
  marginTop: 4, fontSize: 11, lineHeight: 1.5, color: 'var(--text-muted)', overflowWrap: 'anywhere',
}

export default function RuntimeManagerModal({
  intent,
  report,
  problemSummary,
  onClose,
}: {
  intent: RuntimeManagerIntent
  report: RuntimeStatusReport | null
  problemSummary: string
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const firstRef = useRef<HTMLButtonElement | null>(null)
  const openerRef = useRef<Element | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // 독립 설치 섹션은 setup/troubleshoot에서만 처음부터 펼친다(준비된 환경은 조용히 접어 둔다).
  const [showInstall, setShowInstall] = useState(intent !== 'manage')

  useEffect(() => {
    openerRef.current = document.activeElement
    firstRef.current?.focus()
    return () => { (openerRef.current as HTMLElement | null)?.focus?.() }
  }, [])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return }
    if (e.key !== 'Tab') return
    // 단순 포커스 순환 — 모달 밖으로 탭이 새지 않게 한다.
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
    )
    if (!nodes || nodes.length === 0) return
    const list = [...nodes]
    const first = list[0], last = list[list.length - 1]
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
  }, [onClose])

  // 기존 환경 사용 — 사용자가 이미 가진 파이썬을 읽기 전용으로 지정한다(외부 환경 무수정).
  const useExisting = useCallback(async () => {
    setBusy(true); setNotice(null)
    try {
      const picked = await window.api.settings.selectPythonPath()
      setNotice(picked ? '기존 환경을 사용하도록 지정했습니다.' : '선택이 취소되었습니다.')
    } catch {
      setNotice('기존 환경을 지정하지 못했습니다.')
    } finally { setBusy(false) }
  }, [])

  const view = report ? runtimeStatusView(report) : null

  return (
    <div
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        background: 'rgba(4, 4, 8, 0.72)',
      }}
    >
      <div
        ref={dialogRef}
        data-testid="runtime-manager-modal"
        data-intent={intent}
        role="dialog"
        aria-modal="true"
        aria-labelledby="runtime-manager-title"
        style={{
          width: '100%', maxWidth: 560, maxHeight: '100%', overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 12,
          padding: 16, borderRadius: 16,
          background: 'var(--bg-primary)', border: '1px solid var(--border-default)',
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.55)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h2 id="runtime-manager-title" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{TITLE[intent]}</h2>
          <button
            ref={firstRef}
            data-testid="runtime-manager-close"
            className="btn btn-ghost"
            onClick={onClose}
            aria-label="닫기"
            style={{ fontSize: 12, padding: '6px 12px' }}
          >
            닫기
          </button>
        </div>

        {intent === 'troubleshoot' && (
          <div data-testid="runtime-problem-summary" style={{ ...sectionStyle, background: 'rgba(251, 191, 36, 0.08)', border: '1px solid rgba(251, 191, 36, 0.35)' }}>
            <div style={labelStyle}>확인된 원인</div>
            <div style={{ ...helpStyle, color: 'var(--text-secondary)' }}>{problemSummary}</div>
          </div>
        )}

        {/* ── 기존 환경 사용 ── */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <div style={labelStyle}>기존 환경 사용</div>
              <div style={helpStyle}>
                이미 설치된 파이썬 환경을 <b>읽기 전용</b>으로 빌려 씁니다. 그 환경에는 아무것도 설치·변경·삭제하지 않습니다.
              </div>
            </div>
            <button
              data-testid="runtime-use-existing"
              className="btn btn-ghost"
              onClick={useExisting}
              disabled={busy}
              style={{ flexShrink: 0, fontSize: 12, padding: '6px 12px' }}
            >
              {busy ? '선택 중…' : '기존 환경 선택'}
            </button>
          </div>
        </div>

        {/* ── 독립 환경 설치 ── */}
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <div style={labelStyle}>독립 환경 설치</div>
              <div style={helpStyle}>
                기존 환경이 없는 PC에서 AudioForge 전용 환경을 따로 설치합니다. 설치 위치는 직접 고릅니다.
              </div>
            </div>
            <button
              data-testid="runtime-toggle-install"
              className="btn btn-ghost"
              aria-expanded={showInstall}
              onClick={() => setShowInstall((v) => !v)}
              style={{ flexShrink: 0, fontSize: 12, padding: '6px 12px' }}
            >
              {showInstall ? '접기' : '설치 관리 열기'}
            </button>
          </div>
          {showInstall && <RuntimeProvisionPanel />}
        </div>

        {notice && (
          <div data-testid="runtime-manager-notice" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{notice}</div>
        )}

        {/* ── 진단 상세(기본 접힘) ── */}
        <details data-testid="runtime-diagnostics" open={intent === 'troubleshoot'} style={sectionStyle}>
          <summary style={{ ...labelStyle, cursor: 'pointer' }}>진단 상세</summary>
          <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', fontSize: 11 }}>
            <dt style={{ color: 'var(--text-muted)' }}>상태</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{view ? view.title : '확인 중'}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>설명</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{view ? view.detail : '—'}</dd>
            <dt style={{ color: 'var(--text-muted)' }}>사유 코드</dt>
            <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{report?.reasonCode ?? '없음'}</dd>
          </dl>
        </details>
      </div>
    </div>
  )
}
