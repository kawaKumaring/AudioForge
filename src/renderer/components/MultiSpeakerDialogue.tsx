/**
 * 여러 명 화면 — 인물 설정(위) + 하나의 시간순 대화 목록(아래).
 *
 * 이 컴포넌트가 하지 않는 것
 *   · 대본을 다시 parse 하지 않는다. 화자·발화·좌표는 훅(계획)이 준 것만 쓴다.
 *   · 원문을 직접 쓰지 않는다. 모든 변경은 훅 → source patcher 를 거친다.
 *   · 사람별 독립 대본을 만들지 않는다. 목록은 하나이고 한 인물이 여러 번 나온다.
 *   · 목소리 저장소를 새로 만들지 않는다. 목소리 지정은 셸이 넘긴 기존 store 콜백을 부른다.
 *   · VoiceCast 를 만들지 않는다. 인물 카드는 로컬 UI 상태이고 저장은 사용자의 별도 행위다.
 *
 * 표현할 수 없는 대본(`sourceOnly`)이면 이유만 말하고 원문 편집기는 셸이 그대로 보여 준다.
 * 계획이 잠시 낡은 동안(`PLAN_STALE`)에도 화면을 닫지 않고 좌표 의존 버튼만 잠근다.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import type { DialogueProjection, DialogueSpeaker } from '../hooks/useDialogueProjection'
import type { StructureBlocker } from '../../shared/dialogueSourcePatcher'
import { validateSpeakerLabel } from '../../shared/dialogueSourcePatcher'
import { referenceDecisionText } from '../../shared/analysisWording'
import type { ReferenceDecision } from '../../shared/speakerReference'

/** 셸이 넘기는 인물별 목소리 상태 — 기존 SpeakerReferenceManager 와 같은 store 에서 온다. */
export interface SpeakerVoiceState {
  registered: boolean
  ready: boolean
  fileName: string
  decision: ReferenceDecision
  /** 같은 음원 파일을 쓰는 다른 인물 이름 — 같은 목소리로 만들어진다는 사실을 숨기지 않는다. */
  sharedWith?: string[]
  /** 목소리 구성이 이 인물의 특정 감정에 다른 음원을 지정했으면 그 감정 이름들. 생성은 그것을 먼저 쓴다. */
  emotionOverrides?: string[]
}

export const STRUCTURE_BLOCKER_LABEL: Record<StructureBlocker, string> = {
  PLAN_MISSING: '대본 분석을 준비하는 중입니다',
  PLAN_STALE: '대본이 바뀌어 다시 분석하는 중입니다 — 입력은 계속할 수 있습니다',
  PARSER_FALLBACK: '대본 구조를 정확히 읽지 못해 직접 입력으로 편집합니다',
  OFFSETS_APPROXIMATE: '발화 위치가 정확하지 않아 직접 입력으로 편집합니다',
  SPANS_OVERLAP: '발화 구간이 겹쳐 직접 입력으로 편집합니다',
  NON_WHITESPACE_OUTSIDE: '대사 사이에 쉼·지시만 있는 줄이 있어 이 대본은 직접 입력으로 편집합니다 (대사 안의 쉼은 그대로 쓸 수 있습니다)',
  BLOCKING_WARNING: '대본에 오류가 있어 직접 입력으로 편집합니다',
  NO_UTTERANCES: '대사가 없어 직접 입력으로 편집합니다',
}

export const REFUSAL_LABEL: Record<string, string> = {
  STALE_SOURCE: '그 사이 대본이 바뀌어 반영하지 않았습니다. 최신 대본을 다시 불러왔습니다',
  MID_EMOTION_WOULD_BE_LOST: '대사 중간의 감정·쉼 표기가 사라져서 반영하지 않았습니다. `대사 중간에 감정 바꾸기`에서 고쳐 주세요',
  LINE_EMPTY: '대사가 비어 있습니다',
  SPEAKER_HAS_UTTERANCES: '이 인물의 대사가 남아 있습니다. 다른 인물로 바꾸거나 대사를 먼저 지워 주세요',
  NOT_ADJACENT: '이웃한 대화만 자리를 바꿀 수 있습니다',
  SPEAKER_INHERITED: '앞 인물을 이어받는 대화라 순서를 바꿀 수 없습니다. 직접 입력에서 바꿔 주세요',
  CONTENT_BETWEEN: '대화 사이에 쉼이나 다른 표기가 있어 순서를 바꿀 수 없습니다. 직접 입력에서 바꿔 주세요',
  FOLLOWER_INHERITS: '뒤 대화가 이 인물을 이어받고 있어 순서를 바꿀 수 없습니다. 직접 입력에서 바꿔 주세요',
  SPEAKER_LABEL_EMPTY: '인물 이름을 입력해 주세요',
  SPEAKER_LABEL_HAS_WHITESPACE: '인물 이름에 공백을 쓸 수 없습니다',
  SPEAKER_LABEL_FORBIDDEN_CHAR: '인물 이름에는 한글·영문·숫자·_·- 만 쓸 수 있습니다',
  SPEAKER_LABEL_RESERVED_DEFAULT: '`기본`은 인물 이름으로 쓸 수 없습니다',
  TEXT_NOT_EMPTY: '이미 대본이 있어 새로 시작할 수 없습니다',
}

function btn(color: string, off: boolean): CSSProperties {
  return {
    fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 5, border: 'none',
    cursor: off ? 'not-allowed' : 'pointer', background: 'var(--bg-elevated)', color,
    fontFamily: 'inherit', opacity: off ? 0.45 : 1, whiteSpace: 'nowrap',
  }
}
const select: CSSProperties = {
  fontSize: 11, padding: '3px 8px', borderRadius: 6, fontFamily: 'inherit',
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)', minWidth: 0, maxWidth: '100%',
}
const inputBox: CSSProperties = {
  fontSize: 11, padding: '3px 8px', borderRadius: 6, fontFamily: 'inherit', minWidth: 0,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
}

export interface MultiSpeakerDialogueProps {
  projection: DialogueProjection
  emotions: readonly { id: string; label: string }[]
  /** 감정 id → 원문 태그(`[기쁨]`). 셸이 기존 라벨 표에서 만든다. */
  emotionTagOf: (emotionId: string) => string
  /** 표시 이름 → 내부 stable id. 계획이 쓰는 것과 같은 정규화여야 한다. */
  speakerIdOf: (label: string) => string
  voiceOf: (speakerId: string) => SpeakerVoiceState | null
  onAssignVoice: (speakerId: string, label: string) => void
  onRemoveVoice: (speakerId: string) => void
  onPreviewVoice: (speakerId: string) => void
  renderRegionEditor?: (speakerId: string) => ReactNode
  disabled?: boolean
}

export default function MultiSpeakerDialogue(props: MultiSpeakerDialogueProps) {
  const { projection: p, emotions, emotionTagOf, speakerIdOf, voiceOf, disabled = false } = props
  const [advancedOpen, setAdvancedOpen] = useState<Record<number, boolean>>({})
  const [newSpeaker, setNewSpeaker] = useState('')
  const [newLine, setNewLine] = useState('')
  const [newEmotion, setNewEmotion] = useState('default')

  // 빈 대본이면 빈 인물 카드 2개를 **보여 주기만** 한다 — 어디에도 쓰지 않는다.
  useEffect(() => {
    if (p.verdict.mode === 'initial' && p.speakers.length === 0) p.ensurePendingSpeakers(2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.verdict.mode])

  const blockerText = p.verdict.blockers.map((b) => STRUCTURE_BLOCKER_LABEL[b])
  const speakerLabels = p.speakers.map((s) => s.label).filter((l) => l.trim())

  // ── 표현 불가: 이유만 말한다. 원문 편집기는 셸이 그대로 보여 준다. ──
  if (!p.editingAllowed) {
    return (
      <div data-testid="multi-dialogue-source-only" role="status"
        data-mode={p.verdict.mode} data-blockers={p.verdict.blockers.join(' ')}
        style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        {blockerText.map((t) => <div key={t}>{t}</div>)}
        <div style={{ color: 'var(--text-muted)' }}>아래 대본 직접 입력은 그대로 사용할 수 있습니다.</div>
      </div>
    )
  }

  const addRow = () => {
    const label = newSpeaker.trim()
    const check = validateSpeakerLabel(label)
    if (!check.ok) return
    if (p.rows.length === 0) {
      p.createInitial([{ speakerLabel: label, line: newLine }])
    } else {
      p.insertAfter(p.rows.length - 1, label, newLine,
        newEmotion === 'default' ? null : emotionTagOf(newEmotion))
    }
    setNewLine('')
  }

  return (
    <div data-testid="multi-dialogue" data-mode={p.verdict.mode}
      data-blockers={p.verdict.blockers.join(' ')}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {/* 일시적 사유(분석 중)는 화면을 닫지 않고 알리기만 한다. */}
      {p.verdict.blockers.length > 0 && (
        <div data-testid="multi-dialogue-transient" role="status" aria-live="polite"
          style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {blockerText.join(' · ')}
        </div>
      )}
      {p.lastRefusal && (
        <div data-testid="multi-dialogue-refusal" role="status" aria-live="polite"
          style={{ fontSize: 10, color: 'var(--amber, #f59e0b)' }}>
          {REFUSAL_LABEL[p.lastRefusal] ?? p.lastRefusal}
        </div>
      )}

      {/* ── 인물 ── */}
      <div data-testid="multi-speakers" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>인물</span>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
          {p.speakers.map((s) => (
            <SpeakerCard key={s.speakerId} speaker={s} projection={p} disabled={disabled}
              speakerIdOf={speakerIdOf} voiceOf={voiceOf}
              onAssignVoice={props.onAssignVoice} onRemoveVoice={props.onRemoveVoice}
              onPreviewVoice={props.onPreviewVoice} renderRegionEditor={props.renderRegionEditor} />
          ))}
          <button type="button" disabled={disabled} onClick={p.addPendingSpeaker}
            style={btn('var(--cyan)', disabled)}>+ 인물 추가</button>
        </div>
        {/* 화자 표기가 없는 대사가 있으면 그것이 무엇인지 한 줄로 말한다. 카드도 등록도 아니다. */}
        {p.rows.some((r) => r.view.speakerLabel === null) && (
          <span data-testid="default-speaker-note" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            인물 표기가 없는 대사는 <b>기본 인물</b>로 표시됩니다. 한 명 탭과 같은 기본 목소리를 씁니다.
            대사의 인물 칸에서 다른 인물로 바꿀 수 있습니다.
          </span>
        )}
      </div>

      {/* ── 대화 ── */}
      <div data-testid="multi-rows" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>대화</span>
        {p.rows.map((r, i) => {
          const draft = p.draftOf(i)
          const up = p.moveAllowed(i, -1)
          const down = p.moveAllowed(i, 1)
          const adv = !!advancedOpen[i]
          const emotionSelectId = `dlg-emotion-${i}`
          const speakerSelectId = `dlg-speaker-${i}`
          return (
            <div key={`${r.view.sourceStart}-${r.view.sourceEnd}`} data-testid="dialogue-row"
              data-index={i} data-speaker={r.view.speakerId ?? ''}
              style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px',
                borderRadius: 6, border: '1px solid var(--border-subtle)', minWidth: 0 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', minWidth: 18 }}>{i + 1}.</span>
                <label htmlFor={speakerSelectId} style={{ fontSize: 10, color: 'var(--text-muted)' }}>인물</label>
                <select id={speakerSelectId} value={r.view.speakerLabel ?? ''}
                  disabled={disabled || !p.patchAllowed} style={select}
                  onChange={(e) => p.setSpeaker(i, e.target.value === '' ? null : e.target.value)}>
                  {/* 화자 표기가 없는 대사 = 기본 인물. 빈 칸으로 두지 않는다. 고르면 [화자 기본] 으로 되돌린다. */}
                  <option value="">기본 인물</option>
                  {r.view.speakerLabel && !speakerLabels.includes(r.view.speakerLabel) && (
                    <option value={r.view.speakerLabel}>{r.view.speakerLabel}</option>
                  )}
                  {speakerLabels.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
                <label htmlFor={emotionSelectId} style={{ fontSize: 10, color: 'var(--text-muted)' }}>감정</label>
                <select id={emotionSelectId} value={r.view.emotionId ?? 'default'}
                  disabled={disabled || !p.patchAllowed} style={select}
                  onChange={(e) => p.setBaseEmotion(i,
                    e.target.value === 'default' ? null : emotionTagOf(e.target.value))}>
                  {emotions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                </select>
                <span style={{ flex: 1 }} />
                <button type="button" disabled={disabled || !up.allowed} onClick={() => p.move(i, -1)}
                  title={up.allowed ? '' : (REFUSAL_LABEL[up.code ?? ''] ?? '')}
                  aria-label="위로" style={btn('var(--text-secondary)', disabled || !up.allowed)}>↑</button>
                <button type="button" disabled={disabled || !down.allowed} onClick={() => p.move(i, 1)}
                  title={down.allowed ? '' : (REFUSAL_LABEL[down.code ?? ''] ?? '')}
                  aria-label="아래로" style={btn('var(--text-secondary)', disabled || !down.allowed)}>↓</button>
                <button type="button" disabled={disabled || !p.patchAllowed} onClick={() => p.remove(i)}
                  style={btn('var(--rose)', disabled || !p.patchAllowed)}>대화 삭제</button>
              </div>

              {/* 본문 — draft. 입력은 계획 상태와 무관하게 받고, blur/완료 때 한 번 반영한다. */}
              <textarea data-testid="dialogue-body" rows={2} disabled={disabled}
                value={draft ?? r.body}
                onFocus={() => p.beginDraft(i)}
                onChange={(e) => p.updateDraft(i, e.target.value)}
                onBlur={() => p.commitDraft(i)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) p.commitDraft(i) }}
                aria-label={`${i + 1}번 대사`}
                style={{ ...inputBox, width: '100%', resize: 'vertical', boxSizing: 'border-box' }} />
              {r.hasMidEmotionTags && !adv && (
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  이 대사에는 중간 감정·쉼 표기가 있습니다. 표기를 지키면서만 반영됩니다.
                </span>
              )}
              <button type="button" onClick={() => setAdvancedOpen((a) => ({ ...a, [i]: !adv }))}
                style={btn('var(--text-muted)', false)} aria-expanded={adv}>
                {adv ? '대사 중간에 감정 바꾸기 닫기' : '대사 중간에 감정 바꾸기'}
              </button>
              {adv && (
                <AdvancedSliceEditor index={i} slice={r.slice} projection={p} disabled={disabled} />
              )}
            </div>
          )
        })}

        {/* + 대화 추가 */}
        <div data-testid="dialogue-add" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <label htmlFor="dlg-new-speaker" style={{ fontSize: 10, color: 'var(--text-muted)' }}>인물</label>
          <select id="dlg-new-speaker" value={newSpeaker} disabled={disabled} style={select}
            onChange={(e) => setNewSpeaker(e.target.value)}>
            <option value="">선택…</option>
            {speakerLabels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <label htmlFor="dlg-new-emotion" style={{ fontSize: 10, color: 'var(--text-muted)' }}>감정</label>
          <select id="dlg-new-emotion" value={newEmotion} disabled={disabled} style={select}
            onChange={(e) => setNewEmotion(e.target.value)}>
            {emotions.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
          <input id="dlg-new-line" aria-label="새 대사" value={newLine} disabled={disabled}
            placeholder="대사" onChange={(e) => setNewLine(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addRow() }}
            style={{ ...inputBox, flex: '1 1 160px' }} />
          <button type="button"
            disabled={disabled || !newSpeaker || !newLine.trim()
              || (p.rows.length > 0 && !p.patchAllowed)}
            onClick={addRow}
            style={btn('var(--cyan)', disabled || !newSpeaker || !newLine.trim()
              || (p.rows.length > 0 && !p.patchAllowed))}>
            + 대화 추가
          </button>
        </div>
      </div>
    </div>
  )
}

function SpeakerCard(props: {
  speaker: DialogueSpeaker
  projection: DialogueProjection
  disabled: boolean
  speakerIdOf: (label: string) => string
  voiceOf: (speakerId: string) => SpeakerVoiceState | null
  onAssignVoice: (speakerId: string, label: string) => void
  onRemoveVoice: (speakerId: string) => void
  onPreviewVoice: (speakerId: string) => void
  renderRegionEditor?: (speakerId: string) => ReactNode
}) {
  const { speaker: s, projection: p, disabled } = props
  const [open, setOpen] = useState(false)
  const label = s.label.trim()
  const check = validateSpeakerLabel(label)
  // pending 카드도 이름이 유효하면 같은 store 키(정규화 id)로 목소리를 지정할 수 있다.
  const voiceId = s.pending ? (check.ok ? props.speakerIdOf(label) : '') : s.speakerId
  const voice = voiceId ? props.voiceOf(voiceId) : null
  const removable = p.canRemoveSpeaker(s.speakerId)
  return (
    <div data-testid="speaker-card" data-speaker={s.speakerId} data-pending={s.pending ? 'true' : 'false'}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', borderRadius: 6,
        border: '1px solid var(--border-subtle)', minWidth: 0, flex: '1 1 200px', maxWidth: '100%' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        {s.pending ? (
          <>
            <label htmlFor={`spk-name-${s.speakerId}`} style={{ fontSize: 10, color: 'var(--text-muted)' }}>이름</label>
            <input id={`spk-name-${s.speakerId}`} value={s.label} disabled={disabled}
              placeholder="인물 이름" onChange={(e) => p.renamePendingSpeaker(s.speakerId, e.target.value)}
              style={{ ...inputBox, flex: '1 1 80px' }} />
          </>
        ) : (
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--cyan)' }}>{s.label}</span>
        )}
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>대사 {s.utteranceCount}개</span>
        <button type="button" disabled={disabled || !removable.ok}
          title={removable.ok ? '' : (REFUSAL_LABEL[removable.reason ?? ''] ?? '')}
          onClick={() => { if (s.pending) p.removePendingSpeaker(s.speakerId) }}
          style={btn('var(--rose)', disabled || !removable.ok)}>인물 삭제</button>
      </div>
      {s.pending && label && !check.ok && (
        <span data-testid="speaker-name-problem" style={{ fontSize: 10, color: 'var(--rose)' }}>
          {REFUSAL_LABEL[`SPEAKER_LABEL_${check.problem}`]}
        </span>
      )}
      {/* 목소리 — 같은 store, 같은 판정 문구. 인물 카드에서 바로 지정한다. */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <span data-testid="speaker-voice-decision" style={{
          fontSize: 10, color: voice?.decision.ok ? 'var(--text-secondary)' : 'var(--text-muted)',
        }}>
          {voice ? referenceDecisionText(voice.decision) : '목소리 없음'}
        </span>
        {voice?.fileName && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden',
            textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{voice.fileName}</span>
        )}
        <button type="button" disabled={disabled || !voiceId}
          onClick={() => props.onAssignVoice(voiceId, label)}
          style={btn('var(--cyan)', disabled || !voiceId)}>
          {voice?.registered ? '목소리 바꾸기' : '목소리 지정'}
        </button>
        {voice?.registered && (
          <>
            <button type="button" disabled={disabled || !voice.ready}
              onClick={() => props.onPreviewVoice(voiceId)}
              style={btn('var(--text-secondary)', disabled || !voice.ready)}>▶ 재생</button>
            <button type="button" disabled={disabled} onClick={() => props.onRemoveVoice(voiceId)}
              style={btn('var(--rose)', disabled)}>목소리 해제</button>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
              style={btn('var(--text-muted)', false)}>{open ? '구간 닫기' : '참조 구간'}</button>
          </>
        )}
      </div>
      {/* 실제 생성이 이 카드의 표시와 다를 수 있는 두 경우를 그 자리에서 말한다. */}
      {voice?.registered && (voice.sharedWith?.length ?? 0) > 0 && (
        <span data-testid="speaker-voice-shared" style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}>
          {voice.sharedWith!.join(', ')} 와 같은 파일을 씁니다. 같은 목소리로 만들어집니다.
        </span>
      )}
      {(voice?.emotionOverrides?.length ?? 0) > 0 && (
        <span data-testid="speaker-voice-emotion-override" style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}>
          이 감정에서는 다른 목소리 사용: {voice!.emotionOverrides!.join(', ')} — 적용된 목소리 구성의 음원이
          이 인물의 기본 목소리보다 먼저 쓰입니다.
        </span>
      )}
      {open && voice?.registered && props.renderRegionEditor?.(voiceId)}
    </div>
  )
}

/** 원문 조각을 그대로 편집한다 — 기존 감정 태그 여러 개가 글자 그대로 보인다. */
function AdvancedSliceEditor(props: {
  index: number; slice: string; projection: DialogueProjection; disabled: boolean
}) {
  const { index: i, projection: p, disabled } = props
  const draft = p.draftOf(i)
  return (
    <div data-testid="dialogue-advanced" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        아래는 이 대사의 원문 조각입니다. 감정 태그를 여러 개 두거나 바꿀 수 있습니다.
        (앞의 화자 표기와 첫 감정 태그는 위에서 바꾸세요.)
      </span>
      <textarea rows={3} disabled={disabled} aria-label={`${i + 1}번 대사 원문 조각`}
        value={draft ?? props.slice.replace(/^\s*\[\s*(?:화자|speaker)\s+[^\]]*\]\s*(\[[^\]\s]+\]\s*)?/, '')}
        onFocus={() => p.beginDraft(i)}
        onChange={(e) => p.updateDraft(i, e.target.value)}
        onBlur={() => p.commitDraft(i, { advanced: true })}
        style={{ ...inputBox, width: '100%', resize: 'vertical', boxSizing: 'border-box',
          fontFamily: 'ui-monospace, monospace' }} />
    </div>
  )
}
