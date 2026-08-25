import { useEffect, useState, useCallback } from 'react'
import { runtimeStatusView, type RuntimeStatusReport, type RuntimeStatusView } from '../../shared/runtimeStatus'

// 독립 실행(standalone) 런타임 상태 패널(R4).
// 앱은 ComfyUI를 전제하지 않는다 — 시작 화면에서 "런타임이 구성됐는지"를 사용자에게 보여주고,
// 미구성이면 파이썬 실행기를 직접 지정하도록 안내한다. 설치/다운로드는 하지 않는다(PROVISION 단계 소관).
// main의 settings:get은 전체 경로를 주지 않으므로(basename·소유권·reasonCode만) 여기서도 경로를 다루지 않는다.

const TONE: Record<RuntimeStatusView['tone'], { fg: string; bg: string; border: string; dot: string }> = {
  ready:      { fg: 'var(--text-primary)', bg: 'rgba(52, 211, 153, 0.08)',  border: 'rgba(52, 211, 153, 0.35)',  dot: '#34d399' },
  action:     { fg: 'var(--text-primary)', bg: 'var(--accent-glow)',        border: 'var(--border-accent)',      dot: 'var(--accent-light)' },
  incomplete: { fg: 'var(--text-primary)', bg: 'rgba(251, 191, 36, 0.08)',  border: 'rgba(251, 191, 36, 0.35)',  dot: '#fbbf24' },
}

export default function RuntimeStatus() {
  const [report, setReport] = useState<RuntimeStatusReport | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const r = await window.api.settings.get()
      setReport(r)
    } catch {
      // settings:get 자체 실패도 "미구성"으로 안전하게 표시(앱은 계속 살아있어야 함).
      setReport({ resolved: false, interpreterBasename: null, ownership: null, reasonCode: null })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const selectInterpreter = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.settings.selectPythonPath()
    } finally {
      setBusy(false)
      void refresh()
    }
  }, [refresh])

  // 아직 상태를 못 받았으면 아무것도 그리지 않는다(초기 화면 깜빡임 방지).
  if (!report) return null

  const view = runtimeStatusView(report)
  const tone = TONE[view.tone]

  return (
    <div
      data-testid="runtime-status"
      data-tone={view.tone}
      data-resolved={report.resolved ? '1' : '0'}
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginTop: 16, padding: '12px 14px', borderRadius: 12,
        background: tone.bg, border: `1px solid ${tone.border}`, color: tone.fg,
      }}
    >
      <span style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
        background: tone.dot, boxShadow: `0 0 8px ${tone.dot}`,
      }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{view.title}</div>
        <div style={{ marginTop: 2, fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {view.detail}
        </div>
      </div>
      {view.canSelectInterpreter && (
        <button
          data-testid="runtime-select-interpreter"
          onClick={selectInterpreter}
          disabled={busy}
          style={{
            flexShrink: 0, padding: '7px 12px', borderRadius: 8,
            border: '1px solid var(--border-subtle)', cursor: busy ? 'default' : 'pointer',
            fontFamily: 'inherit', fontSize: 11, fontWeight: 500,
            background: 'var(--bg-elevated)', color: 'var(--text-primary)',
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? '선택 중…' : '파이썬 실행기 선택'}
        </button>
      )}
    </div>
  )
}
