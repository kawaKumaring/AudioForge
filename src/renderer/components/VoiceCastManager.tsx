/**
 * 배역 세트 관리 — 생성·선택·이름 변경·적용·해제·삭제.
 *
 * 핵심 규칙 하나: **배역이 하나뿐이어도 자동 적용하지 않는다.** 적용은 사용자가 누르는
 * 행위이고, 적용되지 않은 동안에는 아래 화자 설정이 아예 나타나지 않는다. 그래야 다른
 * 작업의 `[화자 민수]` 가 조용히 같은 목소리를 쓰는 사고가 생기지 않는다.
 *
 * 저장 상태는 화면의 임시 선택과 분리해 표시한다 — `저장 중` / `저장됨` / `저장 실패`.
 * 실패했을 때는 기존 저장본이 그대로 남았다는 사실을 함께 말한다.
 */
import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import {
  SAVE_STATE_LABEL, VOICE_CAST_LABEL, saveFailureText,
} from '../../shared/analysisWording'
import { findVoiceCast } from '../../shared/emotionCandidateRegistry'
import type {
  ReferenceAsset, VoiceCastStore,
} from '../../shared/emotionCandidateRegistry'
import type { SaveState } from '../../shared/analysisWording'
import SpeakerEmotionCandidates from './SpeakerEmotionCandidates'

export interface VoiceCastManagerProps {
  casts: VoiceCastStore
  assets: Readonly<Record<string, ReferenceAsset>>
  /** 이 작업 세션에서만 유효한 활성 배역. 저장되지 않는다. */
  activeVoiceCastId: string | null
  saveState: SaveState
  saveErrorCode: string | null
  /** 계획이 준 화자 목록. UI 가 만들어 내지 않는다. */
  speakers: readonly { speakerId: string; label: string }[]
  emotions: readonly { id: string; label: string }[]
  recommendations?: Readonly<Record<string, string>>
  disabled?: boolean
  playingCandidateId?: string | null
  onCreate: (castName: string) => void
  onRename: (voiceCastId: string, castName: string) => void
  onRemove: (voiceCastId: string) => void
  onApply: (voiceCastId: string) => void
  onUnapply: () => void
  onAddFiles: (voiceCastId: string, speakerId: string, emotionId: string) => void
  onPreview: (candidateId: string) => void
  onSelect: (
    voiceCastId: string, speakerId: string, emotionId: string, choice: string | null
  ) => void
  onUnregister: (
    voiceCastId: string, speakerId: string, emotionId: string, candidateId: string
  ) => void
  renderRegionEditor?: (candidateId: string) => ReactNode
}

function btn(color: string, off: boolean): CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 5, border: 'none',
    cursor: off ? 'not-allowed' : 'pointer', background: 'var(--bg-elevated)', color,
    fontFamily: 'inherit', opacity: off ? 0.45 : 1, whiteSpace: 'nowrap',
  }
}

export default function VoiceCastManager(props: VoiceCastManagerProps) {
  const {
    casts, assets, activeVoiceCastId, saveState, saveErrorCode, speakers, emotions,
    recommendations = {}, disabled = false, playingCandidateId = null,
  } = props
  const [draftName, setDraftName] = useState('')
  const [picked, setPicked] = useState<string>('')
  const active = findVoiceCast(casts, activeVoiceCastId)
  const pickId = 'voice-cast-pick'
  const nameId = 'voice-cast-name'

  return (
    <div data-testid="voice-cast" style={{
      display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 10px',
      borderRadius: 8, border: '1px solid var(--border-subtle)', minWidth: 0,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          {VOICE_CAST_LABEL.section}
        </span>
        {/* 저장 상태는 필요한 변화만 알린다. */}
        <span data-testid="voice-cast-save" role="status" aria-live="polite"
          style={{
            fontSize: 10, color: saveState === 'failed' ? 'var(--rose)' : 'var(--text-muted)',
          }}>
          {SAVE_STATE_LABEL[saveState]}
        </span>
      </div>
      {saveState === 'failed' && (
        <span data-testid="voice-cast-save-error"
          style={{ fontSize: 10, color: 'var(--rose)', lineHeight: 1.5 }}>
          {saveFailureText(saveErrorCode)}
        </span>
      )}

      {/* 만들기 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <label htmlFor={nameId} style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          목소리 구성 이름
        </label>
        <input id={nameId} value={draftName} disabled={disabled}
          onChange={(e) => setDraftName(e.target.value)}
          style={{
            fontSize: 11, padding: '3px 8px', borderRadius: 6, minWidth: 0,
            flex: '1 1 120px', fontFamily: 'inherit',
            border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
            color: 'var(--text-secondary)',
          }} />
        <button type="button" disabled={disabled || !draftName.trim()}
          onClick={() => { props.onCreate(draftName.trim()); setDraftName('') }}
          style={btn('var(--cyan)', disabled || !draftName.trim())}>
          {VOICE_CAST_LABEL.create}
        </button>
      </div>

      {/* 고르기·적용 */}
      {casts.casts.length > 0 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <label htmlFor={pickId} style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {VOICE_CAST_LABEL.pick}
          </label>
          <select id={pickId} value={picked} disabled={disabled}
            onChange={(e) => setPicked(e.target.value)}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 6, fontFamily: 'inherit',
              border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
              color: 'var(--text-secondary)', minWidth: 0, maxWidth: '100%',
            }}>
            <option value="">선택…</option>
            {casts.casts.map((c) => (
              <option key={c.voiceCastId} value={c.voiceCastId}>
                {c.castName || '(이름 없음)'}
              </option>
            ))}
          </select>
          <button type="button" disabled={disabled || !picked}
            onClick={() => props.onApply(picked)}
            style={btn('var(--cyan)', disabled || !picked)}>
            {VOICE_CAST_LABEL.apply}
          </button>
          <button type="button" disabled={disabled || !picked || !draftName.trim()}
            onClick={() => { props.onRename(picked, draftName.trim()); setDraftName('') }}
            style={btn('var(--text-secondary)', disabled || !picked || !draftName.trim())}>
            {VOICE_CAST_LABEL.rename}
          </button>
          <button type="button" disabled={disabled || !picked}
            onClick={() => props.onRemove(picked)}
            style={btn('var(--rose)', disabled || !picked)}>
            {VOICE_CAST_LABEL.remove}
          </button>
        </div>
      )}

      {/* 적용 상태 — 하나뿐이어도 자동 적용하지 않는다는 사실을 말한다. */}
      {!active && (
        <span data-testid="voice-cast-inactive"
          style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {casts.casts.length === 0 ? VOICE_CAST_LABEL.none : VOICE_CAST_LABEL.notApplied}
          {' · '}{VOICE_CAST_LABEL.noAutoApply}
        </span>
      )}

      {active && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span data-testid="voice-cast-active" style={{ fontSize: 11, color: 'var(--cyan)' }}>
              {VOICE_CAST_LABEL.applied}: {active.castName || '(이름 없음)'}
            </span>
            <button type="button" disabled={disabled} onClick={props.onUnapply}
              style={btn('var(--text-secondary)', disabled)}>
              {VOICE_CAST_LABEL.unapply}
            </button>
          </div>
          {speakers.length === 0 ? (
            <span data-testid="voice-cast-no-speakers"
              style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              대본에 화자 표기가 없습니다
            </span>
          ) : (
            speakers.map((s) => (
              <SpeakerEmotionCandidates
                key={s.speakerId}
                speakerId={s.speakerId}
                speakerLabel={s.label}
                cast={active}
                assets={assets}
                emotions={emotions}
                recommendations={recommendations}
                disabled={disabled}
                playingCandidateId={playingCandidateId}
                onAddFiles={(sid, eid) => props.onAddFiles(active.voiceCastId, sid, eid)}
                onPreview={props.onPreview}
                onSelect={(sid, eid, choice) =>
                  props.onSelect(active.voiceCastId, sid, eid, choice)}
                onUnregister={(sid, eid, cid) =>
                  props.onUnregister(active.voiceCastId, sid, eid, cid)}
                renderRegionEditor={props.renderRegionEditor}
              />
            ))
          )}
        </>
      )}
    </div>
  )
}
