import type { ReactNode } from 'react'
import { DEFAULT_SPEAKER_LABEL, referenceDecisionText } from '../../shared/analysisWording'
import type { ReferenceDecision } from '../../shared/speakerReference'

/**
 * 화자별 참조 목소리 등록 — 대본에 등장한 인물마다 어느 목소리로 만들지 지정한다.
 *
 * 기존 감정별 등록(`EmotionReferenceManager`)과 같은 뼈대를 쓴다. 파일 선택과 구간 편집기는
 * 셸(TTSEditor)이 주입한다 — 이 컴포넌트는 파일 I/O 를 하지 않는다.
 *
 * 화면에 **내부 경로를 쓰지 않는다.** 사용자가 자기가 고른 파일을 알아볼 수 있어야 하므로
 * 파일 이름만 보여 주고 폴더는 보이지 않는다.
 *
 * 표시 이름과 내부 id 를 혼동하지 않는다 — 화면 문자열은 항상 `label`, 등록·해제·조회 키는
 * 항상 `speakerId` 다.
 */

export interface SpeakerRow {
  /** 파서가 만든 내부 stable id. 화면 문자열로 쓰지 않는다. */
  speakerId: string
  /** 사용자가 쓴 표시 이름. */
  label: string
  utteranceCount: number
  /** 참조 원본을 지정했는가. */
  registered: boolean
  /** 지금 그대로 합성에 쓸 수 있는가. */
  ready: boolean
  /** 준비되지 않은 이유(비민감 문구). */
  message: string
  /** 화면에 보여 줄 파일 이름(폴더 없음). 미지정이면 빈 문자열. */
  fileName: string
  /** 같은 파일을 쓰는 다른 화자의 표시 이름들. */
  sharedWith: string[]
  /** 이 화자의 발화가 실제로 어느 규칙으로 참조를 얻는가 — 또는 왜 막히는가. */
  decision: ReferenceDecision
}

export default function SpeakerReferenceManager(props: {
  rows: SpeakerRow[]
  defaultSpeakerUtterances: number
  disabled?: boolean
  onRegister: (speakerId: string, source: string, label: string) => void
  onRemove: (speakerId: string) => void
  onPreview: (speakerId: string) => void
  requestSource: () => Promise<string | null>
  renderRegionEditor: (speakerId: string) => ReactNode
}) {
  const { rows, defaultSpeakerUtterances, disabled } = props
  if (!rows.length) return null

  const pick = async (row: SpeakerRow) => {
    if (disabled) return
    const src = await props.requestSource()
    if (src) props.onRegister(row.speakerId, src, row.label)
  }

  const btn = (accent: string, off: boolean): React.CSSProperties => ({
    padding: '3px 10px', borderRadius: 5, border: 'none',
    cursor: off ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 600,
    fontFamily: 'inherit', background: 'var(--bg-elevated)', color: accent,
    opacity: off ? 0.5 : 1,
  })

  return (
    <div data-testid="speaker-refs" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
        인물별 목소리 {rows.length}
      </span>
      {rows.map((r) => (
        <div key={r.speakerId} data-testid="speaker-ref-row" data-speaker={r.speakerId}
          data-ready={r.ready ? 'true' : 'false'}
          style={{
            display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px',
            borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0,
          }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--cyan)', flexShrink: 0 }}>
              {r.label}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>
              발화 {r.utteranceCount}개
            </span>
            {/* 실제로 어느 목소리가 쓰일지 — 화면과 생성이 같은 판정을 쓴다. */}
            <span data-testid="speaker-ref-decision"
              style={{
                fontSize: 11, flexShrink: 0,
                color: r.decision.ok ? 'var(--text-secondary)' : 'var(--rose)',
              }}>
              {referenceDecisionText(r.decision)}
            </span>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={() => { void pick(r) }} disabled={disabled}
              style={btn('var(--cyan)', !!disabled)}>
              {r.registered ? '목소리 바꾸기' : '목소리 지정'}
            </button>
            {r.registered && (
              <>
                <button type="button" onClick={() => props.onPreview(r.speakerId)}
                  disabled={disabled || !r.ready} style={btn('var(--text-secondary)', !!disabled || !r.ready)}>
                  ▶ 재생
                </button>
                <button type="button" onClick={() => props.onRemove(r.speakerId)} disabled={disabled}
                  style={btn('var(--rose)', !!disabled)}>
                  해제
                </button>
              </>
            )}
          </div>
          {r.registered && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
              fontSize: 11, color: 'var(--text-muted)', minWidth: 0 }}>
              {/* 폴더는 보여 주지 않는다 — 사용자가 고른 파일을 알아볼 수 있을 만큼만. */}
              <span data-testid="speaker-ref-file" style={{
                flex: '1 1 140px', minWidth: 0, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.fileName}</span>
              {r.message && <span style={{ flexShrink: 0, color: 'var(--amber, var(--text-secondary))' }}>{r.message}</span>}
            </div>
          )}
          {r.sharedWith.length > 0 && (
            <span data-testid="speaker-ref-shared"
              style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.85 }}>
              {r.sharedWith.join(', ')} 와 같은 파일을 씁니다. 같은 목소리로 만들어집니다.
            </span>
          )}
          {props.renderRegionEditor(r.speakerId)}
        </div>
      ))}
      {defaultSpeakerUtterances > 0 && (
        <span data-testid="speaker-ref-default" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {DEFAULT_SPEAKER_LABEL} · 발화 {defaultSpeakerUtterances}개 — 위에서 고른 기본 목소리를 씁니다.
        </span>
      )}
    </div>
  )
}
