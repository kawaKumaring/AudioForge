import type { CSSProperties } from 'react'
import {
  MAX_AUTO_CANDIDATES,
  type ReferenceCandidate,
  type ReferenceInvalidationReason,
  type ReferenceReuseVerdict,
  type ReferenceScanStatus,
} from '../../shared/referenceLibrary'

// 참조 클립 라이브러리 패널 — 확정된 3~10초 참조를 "재사용 가능한 자산"으로 보여준다.
//
// 이 컴포넌트는 props 만 소비한다: store import 없음, IPC 호출 없음, 부수효과 없음.
// 미리듣기/기본 지정/재탐색은 전부 콜백으로 상위(통합 담당)가 배선한다. 아직 어디에도 mount 되지 않는다.
//
// 표시 정책:
//   - 절대 경로는 절대 표시하지 않는다(후보는 불투명 id + 구간 초 + 숫자 지표로만 식별).
//   - 800x600 / 150% 확대에서도 가로 스크롤이 생기지 않도록 고정 px 폭 없이 wrap 한다.
//   - 조작은 전부 실제 <button>(키보드 도달 가능) + aria-label.

export interface ReferenceLibraryPanelProps {
  /** 저장된 후보(최대 3개). 서로 겹치지 않는 구간이어야 한다(referenceLibrary가 보증). */
  candidates: readonly ReferenceCandidate[]
  /** 현재 합성에 쓰이는 단 하나의 참조 id. */
  defaultCandidateId: string
  /** 재사용 판정 결과(무효화 사유 표시용). null 이면 아직 판정 전. */
  reuse?: ReferenceReuseVerdict | null
  /** 조작 불가(합성 중 등). */
  disabled?: boolean
  /** 후보 재탐색 진행 중. */
  scanning?: boolean
  /** 마지막 재탐색 결과 상태. 남은 구간이 없었다는 사실을 조용히 넘기지 않고 알린다. */
  scanStatus?: ReferenceScanStatus | null
  /** 지금 미리듣기 중인 후보 id. */
  auditioningId?: string | null
  /** 헤더 표시명(기본 참조 / 감정 label). */
  label?: string
  onAudition: (candidateId: string) => void
  onStopAudition?: () => void
  onSetDefault: (candidateId: string) => void
  onRescan: () => void
}

const REASON_LABEL: Record<ReferenceInvalidationReason, string> = {
  REF_SOURCE_CHANGED: '원본 파일이 바뀌었습니다',
  REF_REGION_CHANGED: '참조 구간이 바뀌었습니다',
  REF_TRANSCRIPT_CHANGED: '참조 전사가 바뀌었습니다',
  REF_ANALYSIS_VERSION_CHANGED: '분석 방식이 갱신되었습니다',
}

const card: CSSProperties = {
  borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
  padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8,
  maxWidth: '100%', boxSizing: 'border-box',
}
const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }
const sub: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6, overflowWrap: 'anywhere' }
const rowStyle: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
  padding: '8px 10px', borderRadius: 8, background: 'var(--bg-elevated)',
  maxWidth: '100%', boxSizing: 'border-box',
}

function btn(bg: string, color: string): CSSProperties {
  return {
    padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
    fontSize: 11, fontWeight: 600, fontFamily: 'inherit', background: bg, color,
    whiteSpace: 'nowrap', flexShrink: 0,
  }
}

function sec(ms: number): string {
  return `${(ms / 1000).toFixed(2)}초`
}

/** 구간 표기 — 시작~끝(초). 경로는 어디에도 쓰지 않는다. */
function regionText(c: ReferenceCandidate): string {
  return `${(c.startMs / 1000).toFixed(2)}~${((c.startMs + c.durationMs) / 1000).toFixed(2)}초`
}

/** 왜 추천됐는지 — 숫자 지표만. */
function metricsText(c: ReferenceCandidate): string {
  const m = c.metrics
  return [
    `길이 ${sec(c.durationMs)}`,
    `발화 ${(m.speechRatio * 100).toFixed(0)}%`,
    `무음 ${(m.silenceRatio * 100).toFixed(0)}%`,
    `클리핑 ${(m.clippingRatio * 100).toFixed(2)}%`,
    `RMS ${m.rmsDbfs.toFixed(1)}dBFS`,
    `피크 ${m.peak.toFixed(2)}`,
    `점수 ${c.score.toFixed(3)}`,
  ].join(' · ')
}

export default function ReferenceLibraryPanel({
  candidates,
  defaultCandidateId,
  reuse = null,
  disabled = false,
  scanning = false,
  scanStatus = null,
  auditioningId = null,
  label = '참조 클립 라이브러리',
  onAudition,
  onStopAudition,
  onSetDefault,
  onRescan,
}: ReferenceLibraryPanelProps) {
  const list = candidates ?? []
  const reasons = reuse?.reasons ?? []
  const reusable = reuse?.reusable === true

  return (
    <section style={card} aria-label={`${label} — 저장된 참조 후보`}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle}>{label}</span>
        <span style={{ ...sub, flex: '1 1 200px', minWidth: 0 }}>
          확정한 구간은 재사용 자산입니다 — 대본·속도·감정을 바꿔도 다시 분석하지 않습니다.
          합성에는 항상 <strong style={{ color: 'var(--text-secondary)' }}>기본 참조 1개</strong>만 쓰입니다.
        </span>
        <button
          type="button"
          onClick={onRescan}
          disabled={disabled || scanning}
          aria-label="참조 후보 구간 다시 찾기"
          style={btn('var(--bg-elevated)', 'var(--text-secondary)')}
        >
          {scanning ? '탐색 중...' : '후보 다시 찾기'}
        </button>
      </div>

      {/* 재사용/무효화 상태 */}
      {reuse && (
        <div role="status" aria-live="polite" style={{ ...sub, color: reusable ? 'var(--cyan)' : 'var(--rose)' }}>
          {reusable
            ? '저장된 참조를 그대로 재사용합니다(재분석 없음).'
            : `다시 확정이 필요합니다 — ${reasons.map((r) => REASON_LABEL[r] ?? r).join(' · ')}`}
        </div>
      )}

      {/* 재탐색 결과 — 남은 구간이 없었다는 사실을 조용히 넘기지 않는다 */}
      {!scanning && scanStatus === 'NO_MORE_REFERENCE_CANDIDATES' && (
        <div role="status" aria-live="polite" style={sub}>
          기존 후보와 겹치지 않는 새 구간이 더 없습니다. 기존 후보는 그대로 유지됩니다.
        </div>
      )}

      {list.length === 0 && (
        <div style={sub}>저장된 참조 후보가 없습니다. 구간을 확정하면 여기에 쌓입니다.</div>
      )}

      {/* 후보 목록 — 각 행은 wrap 되며 고정 px 폭을 쓰지 않는다(150% 확대에서도 넘치지 않음) */}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {list.map((c, i) => {
          const isDefault = c.id === defaultCandidateId
          const isAuditioning = auditioningId === c.id
          const region = regionText(c)
          return (
            <li key={c.id} style={rowStyle}>
              <span
                style={{
                  ...labelStyle, flex: '1 1 140px', minWidth: 0,
                  color: isDefault ? 'var(--cyan)' : 'var(--text-secondary)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                후보 {i + 1} · {region}
                {isDefault && <span aria-hidden="true"> ✓</span>}
              </span>

              <span style={{ ...sub, flex: '999 1 220px', minWidth: 0, fontVariantNumeric: 'tabular-nums' }}>
                {metricsText(c)}
              </span>

              {isDefault
                ? (
                  <span style={{ ...sub, color: 'var(--cyan)', flexShrink: 0 }} role="note">
                    기본 참조(합성에 사용)
                  </span>
                )
                : (
                  <button
                    type="button"
                    onClick={() => onSetDefault(c.id)}
                    disabled={disabled}
                    aria-label={`후보 ${i + 1}(${region})을 기본 참조로 지정`}
                    style={btn('var(--rose)', '#fff')}
                  >
                    기본 참조로 지정
                  </button>
                )}

              <button
                type="button"
                onClick={() => (isAuditioning && onStopAudition ? onStopAudition() : onAudition(c.id))}
                disabled={disabled}
                aria-label={isAuditioning
                  ? `후보 ${i + 1}(${region}) 미리듣기 정지`
                  : `후보 ${i + 1}(${region}) 미리듣기`}
                style={btn('var(--bg-card)', 'var(--text-secondary)')}
              >
                {isAuditioning ? '■ 정지' : '▶ 미리듣기'}
              </button>
            </li>
          )
        })}
      </ul>

      <div style={sub}>
        후보는 서로 겹치지 않는 구간으로 최대 {MAX_AUTO_CANDIDATES}개까지 보관됩니다.
        원본 파일은 변경되지 않으며, 파생 클립과 숫자 지표만 저장됩니다.
      </div>
    </section>
  )
}
