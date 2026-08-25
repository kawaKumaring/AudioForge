import { useCallback, useEffect, useState } from 'react'
import {
  estimateInstallBytes,
  displayComponentLabel,
  planIsApplicable,
  type PlanResult,
  type VerifyResult,
} from '../../shared/provisionContract'
import type { ReasonCode } from '../../shared/runtimeContract'
import type { ManagedRootSelectionStatus, ProvisionApprovalContext } from '../../shared/provisionIpc'

// managed provisioner 패널(R-provision) — 설치 계획 보기 / 외부 런타임 선택 / 다시 검사.
// 실제 설치 버튼은 항상 비활성(승인 전, apply 차단). 자동 다운로드·자동 복구 0.
// 표시는 displayLabel·레이아웃 상대경로·용량 요약만 — 전체 절대경로는 main이 애초에 주지 않는다(§11).
// inline style(Electron에서 Tailwind 레이아웃 유틸 미동작) + CSS 변수. E2E용 data-testid 부여.

// reasonCode → 사용자용 안내(자유 문자열 금지 — 코드 매핑 단일 소스). 미매핑 코드는 기본 문구.
const REASON_MESSAGE: Partial<Record<ReasonCode, string>> = {
  BOOTSTRAP_PYTHON_UNRESOLVED: 'provisioner를 실행할 파이썬이 지정되지 않았습니다. 외부 런타임을 선택하세요.',
  UNRESOLVED_COMPONENT: '일부 구성요소의 출처·체크섬·라이선스가 아직 확정되지 않아 설치할 수 없습니다.',
  APPLY_DISABLED: '실제 설치는 아직 비활성입니다(승인 전).',
  PLAN_FINGERPRINT_MISMATCH: '설치 계획이 변경되어 이전 승인이 무효화되었습니다. 계획을 다시 확인하세요.',
  PREFLIGHT_FAILED: 'provisioner 실행에 실패했습니다. 지정한 파이썬을 확인하세요.',
  PATH_OUTSIDE_ROOT: '구성요소 경로가 허용된 위치를 벗어났습니다.',
}

function reasonText(code: ReasonCode | null | undefined): string {
  if (!code) return '설치할 수 없습니다.'
  return REASON_MESSAGE[code] ?? `설치할 수 없습니다 (${code}).`
}

function formatSize(plan: PlanResult): string {
  const { bytes, hasUnknown } = estimateInstallBytes(plan)
  if (bytes === 0 && hasUnknown) return '용량 미정(승인 전)'
  const mb = bytes / (1024 * 1024)
  const label = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`
  return hasUnknown ? `${label} 이상(일부 미정)` : label
}

const btnStyle = (disabled: boolean): React.CSSProperties => ({
  flexShrink: 0, padding: '7px 12px', borderRadius: 8,
  border: '1px solid var(--border-subtle)', cursor: disabled ? 'default' : 'pointer',
  fontFamily: 'inherit', fontSize: 11, fontWeight: 500,
  background: 'var(--bg-elevated)', color: 'var(--text-primary)',
  opacity: disabled ? 0.5 : 1,
})

export default function RuntimeProvisionPanel() {
  const [plan, setPlan] = useState<PlanResult | null>(null)
  const [verify, setVerify] = useState<VerifyResult | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [root, setRoot] = useState<ManagedRootSelectionStatus | null>(null)
  const [approval, setApproval] = useState<ProvisionApprovalContext | null>(null)

  useEffect(() => {
    void window.api.provision.getManagedRoot().then(setRoot).catch(() => setRoot(null))
  }, [])

  const runPlan = useCallback(async () => {
    setBusy(true); setStatus(null)
    try {
      const r = await window.api.provision.plan()
      if (r.ok) { setPlan(r.plan); setApproval(r.approval); setRoot(r.approval.root); setVerify(null); setStatus(null) }
      else { setPlan(null); setApproval(null); setStatus(reasonText(r.reasonCode)) }
    } catch {
      setStatus('설치 계획을 불러오지 못했습니다.')
    } finally { setBusy(false) }
  }, [])

  const runVerify = useCallback(async () => {
    setBusy(true); setStatus(null)
    try {
      const r = await window.api.provision.verify()
      if (r.ok) { setVerify(r.verify); setStatus(null) }
      else { setVerify(null); setStatus(reasonText(r.reasonCode)) }
    } catch {
      setStatus('상태 검사에 실패했습니다.')
    } finally { setBusy(false) }
  }, [])

  const selectRuntime = useCallback(async () => {
    setBusy(true)
    try {
      await window.api.settings.selectPythonPath()  // 외부 런타임(borrowed) 지정 — 기존 선택 흐름 재사용
    } finally { setBusy(false) }
  }, [])

  const selectManagedRoot = useCallback(async () => {
    setBusy(true); setStatus(null)
    try {
      const r = await window.api.provision.selectManagedRoot()
      setRoot(r.root)
      setPlan(null)
      setApproval(null) // 설치 대상이 바뀌면 이전 계획 기반 승인은 즉시 무효.
      if (r.ok) setStatus('관리형 설치 위치를 선택했습니다. 설치 계획을 다시 확인하세요.')
      else if (!r.cancelled) setStatus(reasonText(r.reasonCode))
    } catch {
      setStatus('관리형 설치 위치를 선택하지 못했습니다.')
    } finally { setBusy(false) }
  }, [])

  const applicable = plan ? planIsApplicable(plan) : { ok: false, reasonCode: null as ReasonCode | null }
  const applyDisabled = true  // 이번 단계 apply 항상 차단(승인 전)

  return (
    <div
      data-testid="runtime-provision-panel"
      style={{
        marginTop: 12, padding: '12px 14px', borderRadius: 12,
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>런타임 설치 관리</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button data-testid="provision-select-managed-root" onClick={selectManagedRoot} disabled={busy} style={btnStyle(busy)}>
            설치 위치 선택
          </button>
          <button data-testid="provision-select-runtime" onClick={selectRuntime} disabled={busy} style={btnStyle(busy)}>
            외부 Python 선택(읽기 전용)
          </button>
          <button data-testid="provision-plan-btn" onClick={runPlan} disabled={busy} style={btnStyle(busy)}>
            {busy ? '확인 중…' : '설치 계획 보기'}
          </button>
          <button data-testid="provision-verify-btn" onClick={runVerify} disabled={busy} style={btnStyle(busy)}>
            다시 검사
          </button>
        </div>
      </div>

      <div data-testid="provision-managed-root-status" style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        설치 위치: {root?.displayLabel ?? '확인 중…'}
        {root?.configured ? ' · 선택됨' : ' · 설치 승인 준비 불가'}
      </div>

      {status && (
        <div data-testid="provision-status" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
          {status}
        </div>
      )}

      {plan && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              구성요소 {plan.components.length}개 · 예상 용량 {formatSize(plan)}
            </span>
            <span data-testid="provision-plan-fingerprint" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              계획 {plan.planFingerprint.slice(0, 8)}
            </span>
          </div>
          <div data-testid="provision-components" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {plan.components.map((c) => (
              <div
                key={c.id}
                data-testid="provision-component"
                data-resolved={c.resolved ? '1' : '0'}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  padding: '6px 8px', borderRadius: 8, background: 'var(--bg-elevated)',
                }}
              >
                <span style={{ fontSize: 11, color: 'var(--text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {displayComponentLabel(c)}
                  {c.installPath && (
                    <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-muted)' }}>· {c.installPath}</span>
                  )}
                </span>
                <span style={{
                  flexShrink: 0, fontSize: 10, fontWeight: 500,
                  color: c.resolved ? '#34d399' : '#fbbf24',
                }}>
                  {c.resolved ? '확정' : '미확정'}
                </span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              data-testid="provision-apply-btn"
              disabled={applyDisabled}
              title={applicable.ok ? '실제 설치는 아직 비활성입니다(승인 전).' : reasonText(applicable.reasonCode)}
              style={{
                padding: '8px 14px', borderRadius: 8, border: 'none',
                cursor: 'default', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
                background: 'var(--bg-elevated)', color: 'var(--text-muted)', opacity: 0.6,
              }}
            >
              설치 시작
            </button>
            <span data-testid="provision-apply-reason" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {!approval?.ready
                ? '관리형 설치 위치를 먼저 선택해야 합니다.'
                : applicable.ok
                ? '실제 설치는 아직 비활성입니다(승인 전).'
                : reasonText(applicable.reasonCode)}
            </span>
          </div>
        </div>
      )}

      {verify && (
        <div data-testid="provision-verify-result" style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {verify.components.map((v) => (
            <div
              key={v.id}
              data-testid="provision-verify-item"
              data-present={v.present ? '1' : '0'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                padding: '6px 8px', borderRadius: 8, background: 'var(--bg-elevated)',
              }}
            >
              <span style={{ fontSize: 11, color: 'var(--text-primary)' }}>{v.displayLabel ?? v.id}</span>
              <span style={{ flexShrink: 0, fontSize: 10, color: v.present ? '#34d399' : 'var(--text-muted)' }}>
                {v.present ? '설치됨' : '미설치'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
