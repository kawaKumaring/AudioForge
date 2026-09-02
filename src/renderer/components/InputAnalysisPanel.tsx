import { useEffect, useState } from 'react'
import {
  AXIS_NOTE, INSUFFICIENT_TEXT, PARAGRAPH_WALL_NOTE, PLAN_APPROXIMATE_NOTE,
  RESERVED_AXIS_LABELS, RESERVED_AXIS_NOTE, axisRelationLine, canShowWallTime, confidenceLabel,
  emotionSpanRows, formatRange, paragraphSummary, planIsApproximate, planWarningNote,
  planWarningRows, preparationNote, splitRows, summaryLine, utteranceRows,
} from '../../shared/analysisWording'
import { versionLabel } from '../../shared/buildMetadata'
import type { AnalysisResult } from '../../shared/inputAnalysis'
import { EMOTION_ID_TO_LABEL } from '../lib/emotions'
import type { AnalysisStatus } from '../hooks/useInputAnalysis'

/**
 * 대사 작성 보조 패널 — **읽기 전용**이다.
 *
 * textarea 내부를 건드리지 않는다. decoration·contenteditable 전환도 하지 않는다.
 * 분할 위치는 편집기 밖의 별도 목록으로만 보여 준다 — caret·selection·IME·scroll 을
 * 위협할 경로 자체를 만들지 않기 위해서다.
 *
 * 작은 창에서는 통째로 접힌다. 접힌 상태에서도 한 줄 요약은 남아 합성 UI 를 밀어내지 않는다.
 *
 * **계획을 다시 해석하지 않는다.** 문단·발화·묶음·감정 구간·경고는 모두 Python 이 준
 * `result.plan` 의 행을 그대로 보여 준다. 여기서 대본을 다시 나누거나 세지 않는다 —
 * 화면이 자기 계산을 갖는 순간 화면과 생성 결과가 갈라진다.
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
          <StructureLine result={result} stale={stale} />
          <PlanWarningList result={result} sourceText={sourceText} />
          <ParagraphList result={result} sourceText={sourceText} stale={stale} />
          <EmotionSpanList result={result} sourceText={sourceText} stale={stale} />
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
            {/* 문단 밑에 발화를 두어 세 축의 관계를 그 자리에서 보여 준다.
                발화가 하나뿐이고 지시도 없으면 줄을 늘리지 않는다(잡음이 된다). */}
            <UtteranceRows result={result} paragraphIndex={p.index} sourceText={sourceText} />
          </div>
        )
      })}
    </div>
  )
}

function UtteranceRows(props: {
  result: AnalysisResult; paragraphIndex: number; sourceText: string
}) {
  const rows = utteranceRows(props.result, props.paragraphIndex)
  const trivial = rows.length <= 1 && rows.every((u) => u.emotionId === null && !u.autoSplit)
  if (!rows.length || trivial) return null
  return (
    <div data-testid="analysis-utterances" data-paragraph={props.paragraphIndex}
      style={{
        flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 1,
        paddingLeft: 12, marginTop: 1,
      }}>
      {rows.map((u) => {
        const emotion = u.emotionId ? (EMOTION_ID_TO_LABEL[u.emotionId] ?? u.emotionId) : null
        return (
          <div key={u.index} data-testid="analysis-utterance"
            style={{
              display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap',
              fontSize: 11, color: 'var(--text-muted)', minWidth: 0,
            }}>
            <span style={{ flexShrink: 0, opacity: 0.9 }}>발화 {u.index + 1}</span>
            {emotion && (
              <span data-testid="analysis-utterance-emotion"
                style={{ flexShrink: 0, color: 'var(--text-secondary)' }}>{emotion}</span>
            )}
            <span style={{ flexShrink: 0 }}>{u.chars}자</span>
            <span style={{ flexShrink: 0 }}>
              묶음 {u.calls}개{u.autoSplit ? ' · 자동 분할' : ''}
            </span>
            {u.approximate && <span style={{ flexShrink: 0, opacity: 0.7 }}>위치 근사</span>}
          </div>
        )
      })}
    </div>
  )
}

/** 세 축의 개수 한 줄. 화면이 세는 것이 아니라 계획의 배열 길이를 그대로 읽는다. */
function StructureLine(props: { result: AnalysisResult; stale: boolean }) {
  const line = axisRelationLine(props.result)
  if (!line) return null
  return (
    <div data-testid="analysis-structure"
      style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
        opacity: props.stale ? 0.55 : 1 }}>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>{line}</span>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.8, minWidth: 0 }}>
        {AXIS_NOTE}
      </span>
    </div>
  )
}

/** 감정 구간. 발화마다가 아니라 이어지는 구간 단위다. */
function EmotionSpanList(props: { result: AnalysisResult; sourceText: string; stale: boolean }) {
  const rows = emotionSpanRows(props.result)
  if (!rows.length) return null
  return (
    <div data-testid="analysis-emotions" aria-live="off"
      aria-label={props.stale ? '이전 입력의 감정 구간' : '감정 구간'}
      style={{ display: 'flex', flexDirection: 'column', gap: 2, opacity: props.stale ? 0.55 : 1 }}>
      <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>감정 구간</span>
      {rows.map((e) => (
        <div key={e.index} data-testid="analysis-emotion-span"
          style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
            fontSize: 11, color: 'var(--text-muted)', minWidth: 0 }}>
          <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
            {EMOTION_ID_TO_LABEL[e.emotionId] ?? e.emotionId}
          </span>
          <span style={{ flexShrink: 0 }}>{e.utteranceLabel}</span>
          {/* 원문은 renderer 가 가진 값에서 자른다 — 응답에는 대사가 들어 있지 않다. */}
          <span style={{ flex: '1 1 120px', minWidth: 0, opacity: 0.7,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {props.sourceText.slice(e.sourceStart, e.sourceEnd).trim().slice(0, 18)}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * 대본 표기 진단 — 위치와 무슨 일이 일어나는지만 말한다.
 *
 * **차단 오류와 비차단 경고를 같은 말로 부르지 않는다.** 둘을 한 덩어리로 보이면 사용자가
 * 무엇을 고쳐야 합성이 되는지 알 수 없다. 차단 여부는 `v1.2.0` 부터 있던 파서 계약에서
 * 그대로 온다 — 이 패널은 아무것도 새로 막지 않고 이름과 색만 갈라 놓는다.
 *
 * 오류라도 카드로 크게 띄우지 않는다. 대사 편집기 아래에 이미 붉은 줄로 사유가 뜨고,
 * 여기는 그 사실을 위치와 함께 한 번 더 말하는 자리다.
 */
function PlanWarningList(props: { result: AnalysisResult; sourceText: string }) {
  const rows = planWarningRows(props.result)
  const approximate = planIsApproximate(props.result)
  const note = planWarningNote(props.result)
  if (!rows.length && !approximate) return null
  return (
    <div data-testid="analysis-plan-warnings"
      aria-label="대본 표기 확인" role="group"
      style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rows.map((w) => (
        <div key={w.key} data-testid="analysis-plan-warning" data-code={w.code}
          data-blocking={w.blocking ? 'true' : 'false'}
          style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
            fontSize: 11, color: 'var(--text-muted)', minWidth: 0 }}>
          {/* 이름부터 다르다. 색만으로 가르면 색을 구분하기 어려운 사용자에게 전달되지 않는다. */}
          <span data-testid="analysis-plan-warning-kind"
            style={{
              flexShrink: 0, fontWeight: 600,
              color: w.blocking ? 'var(--rose)' : 'var(--amber, var(--text-secondary))',
            }}>
            {w.kindLabel}
          </span>
          <span style={{
            flexShrink: 0,
            color: w.blocking ? 'var(--rose)' : 'var(--amber, var(--text-secondary))',
          }}>
            {w.label}
          </span>
          <span style={{ flexShrink: 0 }}>{w.where}</span>
          {w.tag && <span style={{ flexShrink: 0, opacity: 0.8 }}>{w.tag}</span>}
          <span style={{ flex: '1 1 140px', minWidth: 0, opacity: 0.8,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {w.hint}
          </span>
        </div>
      ))}
      {approximate && (
        <span data-testid="analysis-plan-approximate"
          style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.8 }}>
          {PLAN_APPROXIMATE_NOTE}
        </span>
      )}
      {note && (
        <span data-testid="analysis-plan-warning-note"
          style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.7 }}>
          {note}
        </span>
      )}
    </div>
  )
}

/**
 * 앞으로 지시가 들어올 자리. **상세 정보 안에만** 둔다.
 *
 * 비어 있다는 사실 자체가 정보이긴 하지만, 기본 화면에 값 0 여섯 개를 항상 늘어놓으면
 * 지금 실제로 쓰는 숫자가 그만큼 뒤로 밀린다. 그래서 알고 싶을 때 펼쳐 보는 자리로 옮겼다.
 * 없는 값을 채워 보여 주지 않는다는 원칙은 그대로다.
 */
function ReservedAxisList() {
  return (
    <div data-testid="analysis-reserved-axes"
      style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
        fontSize: 11, color: 'var(--text-muted)', opacity: 0.65, minWidth: 0 }}>
      {RESERVED_AXIS_LABELS.map((a) => (
        <span key={a.axis} data-testid="analysis-reserved-axis" data-axis={a.axis}
          style={{ flexShrink: 0 }}>{a.label} 0</span>
      ))}
      <span style={{ minWidth: 0 }}>{RESERVED_AXIS_NOTE}</span>
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
      {/* 아직 없는 축은 여기까지 들어와서 본다 — 기본 화면에 늘 0 여섯 개를 늘어놓으면
          지금 쓰는 정보가 그만큼 뒤로 밀린다(사용자 판단). */}
      <ReservedAxisList />
    </div>
  )
}
