import { useEffect, useState } from 'react'
import {
  INSUFFICIENT_TEXT, PARAGRAPH_WALL_NOTE, canShowWallTime, confidenceLabel, formatRange,
  paragraphSummary, preparationNote, splitRows, summaryLine,
} from '../../shared/analysisWording'
import { versionLabel } from '../../shared/buildMetadata'
import type { AnalysisResult } from '../../shared/inputAnalysis'
import type { AnalysisStatus } from '../hooks/useInputAnalysis'

/**
 * 대사 작성 보조 패널 — **읽기 전용**이다.
 *
 * textarea 내부를 건드리지 않는다. decoration·contenteditable 전환도 하지 않는다.
 * 분할 위치는 편집기 밖의 별도 목록으로만 보여 준다 — caret·selection·IME·scroll 을
 * 위협할 경로 자체를 만들지 않기 위해서다.
 *
 * 작은 창에서는 통째로 접힌다. 접힌 상태에서도 한 줄 요약은 남아 합성 UI 를 밀어내지 않는다.
 */
export default function InputAnalysisPanel(props: {
  status: AnalysisStatus
  result: AnalysisResult | null
  sourceText: string
}) {
  const { status, result, sourceText } = props
  const [open, setOpen] = useState(true)
  const [showDetail, setShowDetail] = useState(false)

  if (status === 'idle' && !result) return null

  const muted: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)' }
  const stale = status === 'stale'

  // 상태 한 줄 — 오류 카드를 크게 띄우지 않는다. 합성은 언제나 그대로 가능하다.
  const statusText =
    status === 'preparing' ? '대사 분석 준비 중…'
      : status === 'analyzing' ? '분석 중…'
        : status === 'unavailable' ? '예상 정보를 표시할 수 없습니다'
          : stale ? '입력이 바뀌었습니다' : null

  const head = result ? summaryLine(result) : null

  return (
    <div
      data-testid="input-analysis"
      data-status={status}
      style={{
        marginTop: 10, padding: '8px 10px', borderRadius: 10,
        border: '1px solid var(--border-subtle)', background: 'transparent',
        display: 'flex', flexDirection: 'column', gap: 6,
        // 좁아지면 줄바꿈으로 흡수한다 — 아래 합성 UI 를 밀어내지 않는다.
        minWidth: 0, maxWidth: '100%',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="input-analysis-toggle"
          style={{
            border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
            color: 'var(--text-secondary)', flexShrink: 0,
          }}
        >
          {open ? '▾' : '▸'} 대사 분석
        </button>
        {/* 결과 요약은 live 영역이 아니다 — 타이핑마다 전체를 낭독하면 방해가 된다.
            흐리게만 두지 않고 접근성 이름으로도 '이전 입력의 예상값' 임을 말한다. */}
        <span
          data-testid="input-analysis-summary"
          aria-label={head ? (stale ? `이전 입력의 예상값: ${head}` : head) : undefined}
          style={{
            ...muted, flex: 1, minWidth: 0, opacity: stale ? 0.55 : 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {head ?? statusText ?? ''}
        </span>
        {/* 상태 변화만 알린다. 결과 표는 사용자가 탐색할 때 읽히면 된다. */}
        <span
          data-testid="input-analysis-status"
          role="status"
          aria-live="polite"
          style={{ ...muted, flexShrink: 0, opacity: 0.8 }}
        >
          {head ? (statusText ?? '') : ''}
        </span>
      </div>

      {open && result && (
        <>
          <ParagraphList result={result} sourceText={sourceText} stale={stale} />
          <SplitList result={result} stale={stale} />
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            aria-expanded={showDetail}
            data-testid="input-analysis-detail-toggle"
            style={{
              alignSelf: 'flex-start', border: 'none', background: 'transparent', padding: 0,
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, color: 'var(--text-muted)',
            }}
          >
            {showDetail ? '▾' : '▸'} 상세 정보
          </button>
          {showDetail && <DetailBlock result={result} />}
        </>
      )}
    </div>
  )
}

function ParagraphList(props: { result: AnalysisResult; sourceText: string; stale: boolean }) {
  const { result, sourceText, stale } = props
  if (!result.sourceParagraphs.length) return null
  return (
    <div data-testid="analysis-paragraphs" aria-live="off"
      aria-label={stale ? '이전 입력의 문단별 예상값' : '문단별 예상값'}
      style={{ display: 'flex', flexDirection: 'column', gap: 3, opacity: stale ? 0.55 : 1 }}>
      {result.sourceParagraphs.map((p) => {
        const s = paragraphSummary(result, p.index)
        // 원문은 renderer 가 가진 값에서 자른다 — 응답에는 대사가 들어 있지 않다.
        const preview = sourceText.slice(p.sourceStart, p.sourceEnd).trim().slice(0, 18)
        return (
          <div key={p.index}
            style={{
              display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
              fontSize: 11, color: 'var(--text-muted)', minWidth: 0,
            }}>
            <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
              문단 {p.index + 1}
            </span>
            <span style={{
              flex: '1 1 120px', minWidth: 0, opacity: 0.7,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {preview}
            </span>
            <span style={{ flexShrink: 0 }}>{s.audio ?? INSUFFICIENT_TEXT}</span>
            <span style={{ flexShrink: 0 }}>{s.wall ?? INSUFFICIENT_TEXT}</span>
            <span style={{ flexShrink: 0 }}>
              {s.calls}개 묶음{s.autoSplit ? ' · 자동 분할' : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function SplitList(props: { result: AnalysisResult; stale: boolean }) {
  const rows = splitRows(props.result)
  if (!rows.length) return null
  return (
    <div data-testid="analysis-splits" aria-live="off"
      aria-label={props.stale ? '이전 입력의 분할 위치' : '분할 위치'}
      style={{ display: 'flex', flexDirection: 'column', gap: 2, opacity: props.stale ? 0.55 : 1 }}>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>분할 위치</span>
      {rows.map((r) => (
        <div key={r.afterChunkIndex}
          style={{ fontSize: 11, color: r.forced ? 'var(--rose)' : 'var(--text-muted)' }}>
          묶음 {r.afterChunkIndex + 1} 뒤 — {r.label}
        </div>
      ))}
    </div>
  )
}

function DetailBlock({ result }: { result: AnalysisResult }) {
  const muted: React.CSSProperties = { fontSize: 11, color: 'var(--text-muted)' }
  // 어느 빌드를 보고 있는지 여기서도 확인할 수 있어야 한다 — 시작 화면을 지나면
  // 하단 버전 줄이 보이지 않아 stale 빌드를 가릴 수 없었다(실제로 겪은 문제).
  const [build, setBuild] = useState<string | null>(null)
  useEffect(() => {
    let on = true
    window.api?.app?.getBuildInfo?.()
      // 표시 규칙은 versionLabel 하나가 소유한다. 여기서 손으로 합치면 rc 에도 +sha 가 붙는다.
      .then((b) => { if (on) setBuild(b ? versionLabel(b) : null) })
      .catch(() => {})
    return () => { on = false }
  }, [])
  return (
    <div data-testid="analysis-detail" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {build && <span data-testid="analysis-build" style={muted}>빌드 {build}</span>}
      <span style={muted}>
        문단 {result.sourceParagraphCount} · 대사 구간 {result.segmentCount} ·
        생성 묶음 {result.plannedCalls}
      </span>
      <span style={muted}>
        production token {result.productionTokens} · 분할 상한 {result.splitCapProductionTokens}
      </span>
      {preparationNote(result) && (
        <span data-testid="analysis-prep-note" style={muted}>{preparationNote(result)}</span>
      )}
      <span style={muted}>{PARAGRAPH_WALL_NOTE}</span>
      {/* 신뢰도는 여기에만 둔다 — 장문에서는 거의 늘 '외삽' 이라 요약 줄에 두면 잡음이 된다. */}
      <span data-testid="analysis-confidence" style={muted}>
        {confidenceLabel(result)}
        {result.confidenceReason ? ` (${result.confidenceReason})` : ''}
      </span>
      {!canShowWallTime(result) && (
        <span style={muted}>작업 시간: {INSUFFICIENT_TEXT}</span>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {result.chunks.map((c) => (
          <span key={c.globalIndex} style={muted}>
            묶음 {c.globalIndex + 1} · token {c.productionTokens} · tier {c.generationTier ?? '-'} ·
            {' '}{formatRange(c.estimatedAudioSeconds) ?? INSUFFICIENT_TEXT}
          </span>
        ))}
      </div>
      {result.warnings.length > 0 && (
        <span style={muted}>참고: {result.warnings.join(', ')}</span>
      )}
    </div>
  )
}
