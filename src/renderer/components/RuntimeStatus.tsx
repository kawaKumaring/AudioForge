import { useCallback, useEffect, useState } from 'react'
import {
  runtimeScreenView,
  runtimeProblemSummary,
  type RuntimeStatusReport,
  type RuntimeScreenView,
} from '../../shared/runtimeStatus'
import RuntimeManagerModal from './RuntimeManagerModal'

// 메인 화면의 음성 엔진 상태 — **한 줄 + 기본 버튼 하나**만 그린다.
// 상태 권위는 shared/runtimeStatus의 5개 상태(checking/ready/setup-required/invalid/installing)뿐이며,
// ready에 설치 불가 경고를 함께 표시하지 않는다(모순 금지). 설치 위치·Python·설치 계획·다시 검사·
// 진단 상세는 전부 관리 모달 안으로 이동했다. 여기서는 경로·ownership·fingerprint를 다루지 않는다.

const DOT: Record<RuntimeScreenView['state'], string> = {
  checking: 'var(--text-muted)',
  ready: '#34d399',
  'setup-required': 'var(--accent-light)',
  invalid: '#fbbf24',
  installing: 'var(--accent-light)',
}

export default function RuntimeStatus() {
  const [report, setReport] = useState<RuntimeStatusReport | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [manager, setManager] = useState<null | 'manage' | 'setup' | 'troubleshoot'>(null)

  const refresh = useCallback(async () => {
    try {
      setReport(await window.api.settings.get())
    } catch {
      // settings:get 자체 실패도 "설정 필요"로 안전하게 표시(앱은 계속 살아있어야 함).
      setReport({ resolved: false, interpreterBasename: null, ownership: null, reasonCode: null })
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // 첫 조회 전에는 아무것도 그리지 않는다(초기 화면 깜빡임 방지). 조회 후에는 항상 한 줄이 있다.
  const view = runtimeScreenView(loaded ? report : null)
  if (!loaded) return null

  return (
    <>
      <div
        data-testid="runtime-status"
        data-state={view.state}
        data-resolved={report?.resolved ? '1' : '0'}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          marginTop: 16, padding: '10px 14px', borderRadius: 12,
          background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
          color: 'var(--text-primary)',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: DOT[view.state], boxShadow: `0 0 8px ${DOT[view.state]}`,
          }}
        />
        <span
          data-testid="runtime-status-line"
          style={{ minWidth: 0, flex: '1 1 200px', fontSize: 12, fontWeight: 500, overflowWrap: 'anywhere' }}
        >
          {view.headline}
          {view.suffix && (
            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {view.suffix}</span>
          )}
        </span>
        {view.action && (
          <button
            data-testid="runtime-primary-action"
            data-action={view.action}
            className="btn btn-primary"
            style={{ flexShrink: 0, fontSize: 12, padding: '6px 14px' }}
            onClick={() => setManager(view.action)}
          >
            {view.actionLabel}
          </button>
        )}
      </div>

      {manager && (
        <RuntimeManagerModal
          intent={manager}
          report={report}
          problemSummary={runtimeProblemSummary(report)}
          onClose={() => { setManager(null); void refresh() }}
        />
      )}
    </>
  )
}
