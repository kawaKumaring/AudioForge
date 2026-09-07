/**
 * 한 인물의 감정별 후보 목록과 선택.
 *
 * 이 컴포넌트가 하지 않는 것
 *   · 대본을 다시 해석하지 않는다 — 화자 목록은 계획이 준 것을 받는다.
 *   · 파일을 감정으로 자동 분류하지 않는다 — 감정은 사용자가 고른다.
 *   · 점수를 다시 계산하지 않는다 — 순위와 사유는 shared 순수 함수가 정한다.
 *   · 파일 I/O 를 하지 않는다 — 파일 선택과 구간 편집기는 셸이 주입한다.
 *
 * 후보가 하나뿐이면 "추천 / 최적 / 정확도" 라는 말을 쓰지 않는다. 등록 해제는 파일 삭제가
 * 아니므로 그렇게 부르지도 않는다.
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import {
  CANDIDATE_LIFECYCLE_LABEL, CANDIDATE_QUALITY_LABEL, CANDIDATE_REGISTER_LABEL,
  CANDIDATE_SOURCE_LABEL, EMOTION_AXIS_LABEL, PROVISIONAL_THRESHOLD_NOTE,
  SELECTION_REASON_LABEL, STEM_SOURCE_WARNING, candidatePlaybackText,
} from '../../shared/analysisWording'
import {
  joinCastRecords, resolveSlot, slotKey,
  USER_CHOICE_SPEAKER_DEFAULT,
} from '../../shared/emotionCandidateRegistry'
import type {
  EmotionCandidateRecord, ReferenceAsset, VoiceCast,
} from '../../shared/emotionCandidateRegistry'
// 문구 규칙은 의존성 없는 logic 파일이 소유한다 — 사본을 두지 않는다.
import { candidateCountText } from './SpeakerEmotionCandidates.logic'

export interface SpeakerEmotionCandidatesProps {
  /** 계획이 준 화자. UI 가 만들어 내지 않는다. */
  speakerId: string
  speakerLabel: string
  cast: VoiceCast
  assets: Readonly<Record<string, ReferenceAsset>>
  /** 앱의 감정 카탈로그. 여기서 새로 정의하지 않는다. */
  emotions: readonly { id: string; label: string }[]
  /** `slotKey(화자, 감정) → 후보 id`. 비교 계산이 아직 없으면 비어 있다. */
  recommendations?: Readonly<Record<string, string>>
  disabled?: boolean
  playingCandidateId?: string | null
  onAddFiles: (speakerId: string, emotionId: string) => void
  onPreview: (candidateId: string) => void
  onSelect: (speakerId: string, emotionId: string, choice: string | null) => void
  onUnregister: (speakerId: string, emotionId: string, candidateId: string) => void
  /** 10초를 넘는 후보의 구간 확정 — 기존 편집기를 셸이 주입한다. */
  renderRegionEditor?: (candidateId: string) => ReactNode
}

function btn(color: string, off: boolean): CSSProperties {
  return {
    fontSize: 10, fontWeight: 600, padding: '4px 10px', borderRadius: 5, border: 'none',
    cursor: off ? 'not-allowed' : 'pointer', background: 'var(--bg-elevated)', color,
    fontFamily: 'inherit', opacity: off ? 0.45 : 1, whiteSpace: 'nowrap',
  }
}
function badge(color: string): CSSProperties {
  return {
    fontSize: 10, fontWeight: 600, color, padding: '2px 8px', borderRadius: 5,
    background: 'var(--bg-elevated)', whiteSpace: 'nowrap',
  }
}

export default function SpeakerEmotionCandidates(props: SpeakerEmotionCandidatesProps) {
  const {
    speakerId, speakerLabel, cast, assets, emotions, recommendations = {},
    disabled = false, playingCandidateId = null,
  } = props
  const [emotionId, setEmotionId] = useState<string>(emotions[0]?.id ?? 'default')
  const [detailOf, setDetailOf] = useState<string | null>(null)

  const rows: EmotionCandidateRecord[] = joinCastRecords(cast, assets, speakerId, emotionId)
  const key = slotKey(speakerId, emotionId)
  const registry = { schemaVersion: 1, records: rows }
  const resolution = resolveSlot(registry, speakerId, emotionId, cast.selections,
    recommendations)
  const selectId = `cand-emotion-${speakerId}`

  return (
    <div data-testid="speaker-emotion-candidates" data-speaker={speakerId}
      style={{
        display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px',
        borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0,
      }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--cyan)' }}>
          {speakerLabel}
        </span>
        <label htmlFor={selectId} style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          감정
        </label>
        <select id={selectId} value={emotionId} disabled={disabled}
          onChange={(e) => { setEmotionId(e.target.value); setDetailOf(null) }}
          style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 6, fontFamily: 'inherit',
            border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
          }}>
          {emotions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>
        <button type="button" disabled={disabled}
          onClick={() => props.onAddFiles(speakerId, emotionId)}
          style={btn('var(--cyan)', disabled)}>
          {CANDIDATE_REGISTER_LABEL.add}
        </button>
      </div>

      <span data-testid="candidate-count" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
        {candidateCountText(rows.length)}
      </span>
      {resolution.reason && (
        <span data-testid="candidate-reason" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {SELECTION_REASON_LABEL[resolution.reason]}
        </span>
      )}

      {rows.map((r) => {
        const isRecommended = recommendations[key] === r.candidateId
          && rows.length > 1 && r.autoRecommendable
        const isSelected = resolution.candidateId === r.candidateId
        const open = detailOf === r.candidateId
        const playing = playingCandidateId === r.candidateId
        return (
          <div key={r.candidateId} data-testid="candidate-row"
            data-candidate={r.candidateId} data-lifecycle={r.lifecycle}
            data-recommended={isRecommended ? 'true' : 'false'}
            data-selected={isSelected ? 'true' : 'false'}
            style={{
              display: 'flex', flexDirection: 'column', gap: 3, padding: '6px 8px',
              borderRadius: 6, minWidth: 0,
              border: `1px solid ${isSelected ? 'var(--cyan)' : 'var(--border-subtle)'}`,
            }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
              {/* 전체 경로는 쓰지 않는다 — 파일 이름만. */}
              <span data-testid="candidate-file" style={{
                fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
                flex: '1 1 120px', minWidth: 0, overflow: 'hidden',
                textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{r.sourcePath.split(/[\\/]/).pop() || '(이름 없음)'}</span>
              {isRecommended && <span style={badge('var(--cyan)')}>자동 제안</span>}
              {isSelected && <span style={badge('var(--cyan)')}>지금 사용</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 10, color: 'var(--text-muted)' }}>
              {r.sourceDurationSec > 0 && <span>{r.sourceDurationSec.toFixed(1)}초</span>}
              <span>{CANDIDATE_SOURCE_LABEL[r.sourceKind]}</span>
              <span>{CANDIDATE_QUALITY_LABEL[r.qualityState]}</span>
              <span data-testid="candidate-lifecycle">
                {CANDIDATE_LIFECYCLE_LABEL[r.lifecycle] ?? r.lifecycle}
              </span>
            </div>
            {r.sourceKind === 'separated_stem' && (
              <span data-testid="candidate-stem-warning"
                style={{ fontSize: 10, color: 'var(--amber, #f59e0b)' }}>
                {STEM_SOURCE_WARNING}
              </span>
            )}
            {playing && (
              <span data-testid="candidate-playing" role="status"
                style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {candidatePlaybackText(true, r.sourcePath.split(/[\\/]/).pop() ?? '')}
              </span>
            )}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button type="button" disabled={disabled}
                onClick={() => props.onPreview(r.candidateId)}
                style={btn('var(--text-secondary)', disabled)}>재생</button>
              <button type="button" disabled={disabled || isSelected}
                onClick={() => props.onSelect(speakerId, emotionId, r.candidateId)}
                style={btn('var(--cyan)', disabled || isSelected)}>이 후보 사용</button>
              <button type="button" disabled={disabled}
                onClick={() => props.onUnregister(speakerId, emotionId, r.candidateId)}
                style={btn('var(--rose)', disabled)}>
                {CANDIDATE_REGISTER_LABEL.unregister}
              </button>
              <button type="button" onClick={() => setDetailOf(open ? null : r.candidateId)}
                style={btn('var(--text-muted)', false)}>
                {open ? '상세 닫기' : '상세 정보'}
              </button>
            </div>
            {open && (
              <div data-testid="candidate-detail"
                style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 2 }}>
                {r.profileId && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    {EMOTION_AXIS_LABEL.relative_f0} 측정됨
                  </span>
                )}
                {r.qualityCodes.map((c) => (
                  <span key={c} style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    참조 품질: {c}
                  </span>
                ))}
                {r.lifecycleCode && (
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                    상태 코드: {r.lifecycleCode}
                  </span>
                )}
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {PROVISIONAL_THRESHOLD_NOTE}
                </span>
              </div>
            )}
            {r.lifecycle === 'needs_region' && props.renderRegionEditor && (
              <div style={{ marginTop: 4 }}>{props.renderRegionEditor(r.candidateId)}</div>
            )}
          </div>
        )
      })}

      {rows.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" disabled={disabled || !cast.selections[key]}
            onClick={() => props.onSelect(speakerId, emotionId, null)}
            style={btn('var(--text-secondary)', disabled || !cast.selections[key])}>
            {CANDIDATE_REGISTER_LABEL.clearSelection}
          </button>
          <button type="button" disabled={disabled}
            onClick={() => props.onSelect(speakerId, emotionId, USER_CHOICE_SPEAKER_DEFAULT)}
            style={btn('var(--text-secondary)', disabled)}>
            {CANDIDATE_REGISTER_LABEL.speakerDefault}
          </button>
        </div>
      )}
      <span style={{ fontSize: 10, color: 'var(--text-muted)', opacity: 0.9 }}>
        {CANDIDATE_REGISTER_LABEL.unregisterNote}
      </span>
    </div>
  )
}
