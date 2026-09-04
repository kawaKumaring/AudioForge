/**
 * 여러 명 화면 — **인물의 한 발화 카드**가 기본 단위다.
 *
 * 카드 하나 = 누가(인물) · 어떤 목소리(준비 상태) · 어디서 어떤 감정(`+ 감정` 으로 대사 안에 태그) · 무엇을(대사).
 *   · 대화칸은 하나다. 첫 감정 태그·중간 태그·쉼 표기가 글자 그대로 들어 있고 일반 편집으로 넣고 지운다.
 *   · 같은 인물이 다시 말하면 새 카드. 같은 인물의 카드는 같은 인물 id 와 목소리 설정을 공유한다.
 *   · 카드 순서 = 생성 순서. 위/아래는 patcher 가 안전하다고 판정할 때만.
 *   · 목소리 설정은 카드 머리의 인물·상태를 눌러 **그 인물 한 명**의 패널만 연다(파형도 한 명만).
 *   · 인물 목록 요약 한 줄만 둔다(`인물 3명 · 모두 준비됨`). 위쪽에 인물 카드 영역을 따로 두지 않는다.
 *
 * 이 컴포넌트가 하지 않는 것
 *   · 대본을 다시 parse 하지 않는다. 화자·발화·좌표는 훅(계획)이 준 것만 쓴다.
 *   · 원문을 직접 쓰지 않는다. 모든 변경은 훅 → source patcher 를 거친다.
 *   · 대사 원문을 복제한 두 번째 textarea 를 만들지 않는다.
 *   · 목소리 저장소를 새로 만들지 않는다. 목소리 지정은 셸이 넘긴 기존 store 콜백을 부른다.
 *   · 발화 삭제·인물 변경이 목소리 자산이나 저장된 목소리 구성을 지우지 않는다.
 *
 * 표현할 수 없는 대본(`sourceOnly`)이면 이유만 말하고 원문 편집기는 셸이 보여 준다.
 * 계획이 잠시 낡은 동안(`PLAN_STALE`)에도 화면을 닫지 않고 좌표 의존 버튼만 잠근다.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

import type { DialogueProjection, DialogueRow, DialogueSpeaker } from '../hooks/useDialogueProjection'
import type { StructureBlocker } from '../../shared/dialogueSourcePatcher'
import { validateSpeakerLabel, insertTagAtCaret } from '../../shared/dialogueSourcePatcher'
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
  /** 실제 생성으로 나가는 감정별 음원의 감정 이름들(켠 인물만). 생성은 그것을 먼저 쓴다. */
  emotionOverrides?: string[]
  /** 목소리 구성이 이 인물에 대해 가진 감정 이름들(켜짐 무관). 있으면 패널에 켬/끔이 보인다. */
  emotionVoiceAvailable?: string[]
  /** 이 작업에서 사용자가 `감정별 목소리 사용` 을 켰는가. 기본 false. */
  emotionVoiceEnabled?: boolean
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
  LINE_EMPTY: '대사가 비어 있습니다',
  SPEAKER_HAS_UTTERANCES: '이 인물의 대사가 남아 있습니다. 다른 인물로 바꾸거나 대사를 먼저 지워 주세요',
  NOT_ADJACENT: '이웃한 대화만 자리를 바꿀 수 있습니다',
  SPEAKER_INHERITED: '앞 인물을 이어받는 대화라 순서를 바꿀 수 없습니다. 대본 표기 직접 편집에서 바꿔 주세요',
  CONTENT_BETWEEN: '대화 사이에 쉼이나 다른 표기가 있어 순서를 바꿀 수 없습니다. 대본 표기 직접 편집에서 바꿔 주세요',
  FOLLOWER_INHERITS: '뒤 대화가 이 인물을 이어받고 있어 순서를 바꿀 수 없습니다. 대본 표기 직접 편집에서 바꿔 주세요',
  SPEAKER_LABEL_EMPTY: '인물 이름을 입력해 주세요',
  SPEAKER_LABEL_HAS_WHITESPACE: '인물 이름에 공백을 쓸 수 없습니다',
  SPEAKER_LABEL_FORBIDDEN_CHAR: '인물 이름에는 한글·영문·숫자·_·- 만 쓸 수 있습니다',
  SPEAKER_LABEL_RESERVED_DEFAULT: '`기본`은 인물 이름으로 쓸 수 없습니다',
  TEXT_NOT_EMPTY: '이미 대본이 있어 새로 시작할 수 없습니다',
}

function btn(color: string, off: boolean): CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 5, border: 'none',
    cursor: off ? 'not-allowed' : 'pointer', background: 'var(--bg-elevated)', color,
    fontFamily: 'inherit', opacity: off ? 0.45 : 1, whiteSpace: 'nowrap',
  }
}
const select: CSSProperties = {
  fontSize: 12, fontWeight: 600, padding: '3px 8px', borderRadius: 6, fontFamily: 'inherit',
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--cyan)', minWidth: 0, maxWidth: '100%',
}
const inputBox: CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: 6, fontFamily: 'inherit', minWidth: 0,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary, var(--text-secondary))', lineHeight: 1.5,
}
const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 8,
  border: '1px solid var(--border-subtle)', minWidth: 0, width: '100%', boxSizing: 'border-box',
}
const rowFlex: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }

/** 카드 머리의 짧은 목소리 상태. 자세한 판정 문구는 패널에서. */
export function voiceStatusShort(voice: SpeakerVoiceState | null): string {
  if (!voice || !voice.registered) return '목소리 없음'
  return voice.ready ? '목소리 준비됨' : '목소리 확인 중'
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
  onToggleEmotionVoice?: (speakerId: string, on: boolean) => void
  disabled?: boolean
}

export default function MultiSpeakerDialogue(props: MultiSpeakerDialogueProps) {
  const { projection: p, emotions, emotionTagOf, speakerIdOf, voiceOf, disabled = false } = props
  const [newSpeaker, setNewSpeaker] = useState('')
  const [newLine, setNewLine] = useState('')
  // 목소리 패널은 한 번에 한 인물만 연다(파형도 한 명만).
  const [voiceSpeaker, setVoiceSpeaker] = useState<string | null>(null)

  // 빈 대본이면 빈 인물 카드 2개를 **보여 주기만** 한다 — 어디에도 쓰지 않는다.
  useEffect(() => {
    if (p.verdict.mode === 'initial' && p.speakers.length === 0) p.ensurePendingSpeakers(2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.verdict.mode])

  const blockerText = p.verdict.blockers.map((b) => STRUCTURE_BLOCKER_LABEL[b])
  const namedSpeakers = p.speakers.filter((s) => s.label.trim() && validateSpeakerLabel(s.label.trim()).ok)
  const speakerLabels = namedSpeakers.map((s) => s.label.trim())
  const voiceIdOf = (s: DialogueSpeaker) => (s.pending ? speakerIdOf(s.label.trim()) : s.speakerId)

  // ── 표현 불가: 이유만 말한다. 원문 편집기는 셸이 보여 준다. ──
  if (!p.editingAllowed) {
    return (
      <div data-testid="multi-dialogue-source-only" role="status"
        data-mode={p.verdict.mode} data-blockers={p.verdict.blockers.join(' ')}
        style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        {blockerText.map((t) => <div key={t}>{t}</div>)}
        <div style={{ color: 'var(--text-muted)' }}>아래 대본 표기 직접 편집은 그대로 사용할 수 있습니다.</div>
      </div>
    )
  }

  // ── 요약 한 줄: 인물 N명 · 준비 상태 ──
  const notReady = namedSpeakers.filter((s) => !voiceOf(voiceIdOf(s))?.ready).map((s) => s.label.trim())
  const defaultRows = p.rows.filter((r) => r.view.speakerLabel === null).length
  const summary = namedSpeakers.length === 0
    ? (p.rows.length > 0 ? `인물 없음 · 대사 ${p.rows.length}개는 기본 인물` : '인물을 만들고 첫 대사를 넣어 주세요')
    : `인물 ${namedSpeakers.length}명 · ${notReady.length === 0 ? '모두 준비됨' : `목소리 준비 안 됨 ${notReady.length}명: ${notReady.join(', ')}`}`
      + (defaultRows > 0 ? ` · 기본 인물 대사 ${defaultRows}개` : '')

  const addRow = () => {
    if (newSpeaker === '__new__') { p.addPendingSpeaker(); setNewSpeaker(''); return }
    const label = newSpeaker.trim()
    if (!validateSpeakerLabel(label).ok || !newLine.trim()) return
    if (p.rows.length === 0) p.createInitial([{ speakerLabel: label, line: newLine }])
    else p.insertAfter(p.rows.length - 1, label, newLine, null)
    setNewLine('')
  }
  const addDisabled = disabled || (newSpeaker !== '__new__' && (!newSpeaker || !newLine.trim()))
    || (p.rows.length > 0 && newSpeaker !== '__new__' && !p.patchAllowed)

  const panelSpeaker = voiceSpeaker
    ? p.speakers.find((s) => voiceIdOf(s) === voiceSpeaker || s.speakerId === voiceSpeaker) ?? null
    : null

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

      <div data-testid="multi-summary" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{summary}</div>

      {/* 선택한 인물 한 명의 목소리 패널 — 전체 폭. 닫으면 카드로 돌아온다. */}
      {panelSpeaker && (
        <SpeakerVoicePanel speaker={panelSpeaker} voiceId={voiceIdOf(panelSpeaker)} disabled={disabled}
          voice={voiceOf(voiceIdOf(panelSpeaker))}
          onAssignVoice={props.onAssignVoice} onRemoveVoice={props.onRemoveVoice}
          onPreviewVoice={props.onPreviewVoice} renderRegionEditor={props.renderRegionEditor}
          onToggleEmotionVoice={props.onToggleEmotionVoice} onClose={() => setVoiceSpeaker(null)} />
      )}

      {/* ── 발화 카드 — 1열 전체 폭 ── */}
      <div data-testid="multi-rows" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {p.rows.map((r, i) => (
          <UtteranceCard key={`${r.view.sourceStart}-${r.view.sourceEnd}`} row={r} index={i}
            projection={p} disabled={disabled} emotions={emotions} emotionTagOf={emotionTagOf}
            speakerLabels={speakerLabels}
            voice={r.view.speakerId ? voiceOf(r.view.speakerId) : null}
            onOpenVoice={() => setVoiceSpeaker(r.view.speakerId)} />
        ))}
        {/* 아직 원문에 없는 인물 — 이름·목소리·첫 대사를 카드 안에서. 넣기 전엔 어디에도 쓰지 않는다. */}
        {p.speakers.filter((s) => s.pending).map((s) => (
          <StarterCard key={s.speakerId} speaker={s} projection={p} disabled={disabled}
            voiceId={validateSpeakerLabel(s.label.trim()).ok ? speakerIdOf(s.label.trim()) : ''}
            voiceOf={voiceOf} onOpenVoice={(id) => setVoiceSpeaker(id)} />
        ))}
      </div>

      {/* + 대화 추가 — 기존 인물을 고르거나 새 인물을 만든다. */}
      <div data-testid="dialogue-add" style={rowFlex}>
        <label htmlFor="dlg-new-speaker" style={{ fontSize: 10, color: 'var(--text-muted)' }}>인물</label>
        <select id="dlg-new-speaker" value={newSpeaker} disabled={disabled} style={select}
          onChange={(e) => setNewSpeaker(e.target.value)}>
          <option value="">선택…</option>
          {speakerLabels.map((l) => <option key={l} value={l}>{l}</option>)}
          <option value="__new__">새 인물 만들기…</option>
        </select>
        {newSpeaker !== '__new__' && (
          <input id="dlg-new-line" aria-label="새 대사" value={newLine} disabled={disabled}
            placeholder="대사" onChange={(e) => setNewLine(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addRow() }}
            style={{ ...inputBox, flex: '1 1 160px' }} />
        )}
        <button type="button" disabled={addDisabled} onClick={addRow} style={btn('var(--cyan)', addDisabled)}>
          {newSpeaker === '__new__' ? '+ 인물 만들기' : '+ 대화 추가'}
        </button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 발화 카드
// ─────────────────────────────────────────────────────────────────────────────

function UtteranceCard(props: {
  row: DialogueRow
  index: number
  projection: DialogueProjection
  disabled: boolean
  emotions: readonly { id: string; label: string }[]
  emotionTagOf: (emotionId: string) => string
  speakerLabels: string[]
  voice: SpeakerVoiceState | null
  onOpenVoice: () => void
}) {
  const { row: r, index: i, projection: p, disabled, voice } = props
  const draft = p.draftOf(i)
  const value = draft ?? r.content
  const up = p.moveAllowed(i, -1)
  const down = p.moveAllowed(i, 1)
  const speakerSelectId = `dlg-speaker-${i}`
  const [pickerOpen, setPickerOpen] = useState(false)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  // 마지막으로 유효했던 caret — textarea 가 포커스를 잃어도 기억한다.
  const lastCaret = useRef<number | null>(null)
  // 한글 IME 조합 중에는 삽입하지 않고 조합이 끝난 뒤 넣는다.
  const composing = useRef(false)
  const queuedTag = useRef<string | null>(null)

  const rememberCaret = () => {
    const ta = taRef.current
    if (ta) lastCaret.current = ta.selectionStart
  }

  /** caret 위치에 태그를 넣는다. 네이티브 undo 가 살도록 execCommand 로 넣고, 안 되면 draft 로 넣는다. */
  const insertTag = (tag: string) => {
    if (disabled) return
    if (composing.current) { queuedTag.current = tag; return }
    const ta = taRef.current
    const caret = lastCaret.current ?? (ta ? ta.selectionStart : null)
    const res = insertTagAtCaret(value, caret, tag)
    p.beginDraft(i)
    if (ta) {
      ta.focus()
      ta.setSelectionRange(res.insertAt, res.insertAt)
      let ok = false
      try { ok = typeof document.execCommand === 'function' && document.execCommand('insertText', false, res.inserted) } catch { ok = false }
      if (!ok) p.updateDraft(i, res.text)
      requestAnimationFrame(() => { try { ta.setSelectionRange(res.caret, res.caret) } catch { /* noop */ } })
    } else {
      p.updateDraft(i, res.text)
    }
    lastCaret.current = res.caret
    setPickerOpen(false)
  }

  return (
    <div data-testid="dialogue-row" data-index={i} data-speaker={r.view.speakerId ?? ''} style={card}>
      {/* 머리: 번호 · 인물 · 목소리 상태(누르면 그 인물의 목소리 설정) · 이동/삭제 */}
      <div style={rowFlex}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', minWidth: 18 }}>{i + 1}.</span>
        <label htmlFor={speakerSelectId} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>인물</label>
        <select id={speakerSelectId} value={r.view.speakerLabel ?? ''} disabled={disabled || !p.patchAllowed}
          style={select} aria-label="인물"
          onChange={(e) => p.setSpeaker(i, e.target.value === '' ? null : e.target.value)}>
          <option value="">기본 인물</option>
          {r.view.speakerLabel && !props.speakerLabels.includes(r.view.speakerLabel) && (
            <option value={r.view.speakerLabel}>{r.view.speakerLabel}</option>
          )}
          {props.speakerLabels.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
        {r.view.speakerId ? (
          <button type="button" data-testid="card-voice" onClick={props.onOpenVoice} disabled={disabled}
            title="이 인물의 목소리 설정"
            style={btn(voice?.ready ? 'var(--text-secondary)' : 'var(--amber, #d4a017)', disabled)}>
            · {voiceStatusShort(voice)}
          </button>
        ) : (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· 한 명 탭과 같은 기본 목소리</span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" disabled={disabled || !up.allowed} onClick={() => p.move(i, -1)}
          title={up.allowed ? '' : (REFUSAL_LABEL[up.code ?? ''] ?? '')}
          aria-label="위로" style={btn('var(--text-secondary)', disabled || !up.allowed)}>위</button>
        <button type="button" disabled={disabled || !down.allowed} onClick={() => p.move(i, 1)}
          title={down.allowed ? '' : (REFUSAL_LABEL[down.code ?? ''] ?? '')}
          aria-label="아래로" style={btn('var(--text-secondary)', disabled || !down.allowed)}>아래</button>
        <button type="button" disabled={disabled || !p.patchAllowed} onClick={() => p.remove(i)}
          style={btn('var(--rose)', disabled || !p.patchAllowed)}>삭제</button>
      </div>

      {/* 대사 — 대화칸 하나. 감정 태그는 이 안에 글자 그대로. 입력은 계획 상태와 무관하게 받고 blur/Ctrl+Enter 에 반영. */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', minWidth: 0 }}>
        <textarea ref={taRef} data-testid="dialogue-body" rows={2} disabled={disabled}
          value={value}
          onFocus={() => p.beginDraft(i)}
          onChange={(e) => { p.updateDraft(i, e.target.value); rememberCaret() }}
          onSelect={rememberCaret} onKeyUp={rememberCaret} onClick={rememberCaret}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => {
            composing.current = false
            const q = queuedTag.current
            if (q) { queuedTag.current = null; requestAnimationFrame(() => insertTag(q)) }
          }}
          onBlur={() => { rememberCaret(); p.commitDraft(i) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) p.commitDraft(i) }}
          aria-label={`${i + 1}번 대사`}
          style={{ ...inputBox, flex: '1 1 auto', width: '100%', resize: 'vertical', boxSizing: 'border-box' }} />
        <div style={{ position: 'relative', flex: '0 0 auto' }}>
          <button type="button" data-testid="emotion-add" disabled={disabled}
            onClick={() => setPickerOpen((o) => !o)} aria-expanded={pickerOpen}
            title="커서 위치에 감정 넣기" style={btn('var(--cyan)', disabled)}>+ 감정</button>
          {pickerOpen && (
            <div data-testid="emotion-picker" role="menu"
              style={{ position: 'absolute', right: 0, top: '110%', zIndex: 5, display: 'flex', flexWrap: 'wrap', gap: 4,
                width: 220, maxWidth: '70vw', padding: 6, borderRadius: 8, background: 'var(--bg-elevated)',
                border: '1px solid var(--border-subtle)', boxShadow: '0 4px 14px rgba(0,0,0,.25)' }}>
              {props.emotions.filter((e) => e.id !== 'default').map((e) => (
                <button key={e.id} type="button" role="menuitem" data-emotion={e.id}
                  onMouseDown={(ev) => ev.preventDefault() /* textarea 포커스·caret 유지 */}
                  onClick={() => insertTag(props.emotionTagOf(e.id))}
                  style={btn('var(--text-secondary)', false)}>{e.label}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 아직 원문에 없는 인물의 시작 카드
// ─────────────────────────────────────────────────────────────────────────────

function StarterCard(props: {
  speaker: DialogueSpeaker
  projection: DialogueProjection
  disabled: boolean
  voiceId: string
  voiceOf: (speakerId: string) => SpeakerVoiceState | null
  onOpenVoice: (speakerId: string) => void
}) {
  const { speaker: s, projection: p, disabled, voiceId } = props
  const [line, setLine] = useState('')
  const label = s.label.trim()
  const check = validateSpeakerLabel(label)
  const voice = voiceId ? props.voiceOf(voiceId) : null
  const canAdd = !disabled && check.ok && !!line.trim() && (p.rows.length === 0 || p.patchAllowed)
  const add = () => {
    if (!canAdd) return
    if (p.rows.length === 0) p.createInitial([{ speakerLabel: label, line }])
    else { p.insertAfter(p.rows.length - 1, label, line, null); p.removePendingSpeaker(s.speakerId) }
    setLine('')
  }
  return (
    <div data-testid="starter-card" data-speaker={s.speakerId} data-pending="true" style={card}>
      <div style={rowFlex}>
        <label htmlFor={`spk-name-${s.speakerId}`} style={{ fontSize: 10, color: 'var(--text-muted)' }}>이름</label>
        <input id={`spk-name-${s.speakerId}`} value={s.label} disabled={disabled} placeholder="인물 이름"
          onChange={(e) => p.renamePendingSpeaker(s.speakerId, e.target.value)}
          style={{ ...inputBox, flex: '1 1 120px' }} />
        <button type="button" data-testid="card-voice" disabled={disabled || !voiceId}
          onClick={() => props.onOpenVoice(voiceId)} title="이 인물의 목소리 설정"
          style={btn(voice?.ready ? 'var(--text-secondary)' : 'var(--amber, #d4a017)', disabled || !voiceId)}>
          · {voiceStatusShort(voice)}
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" disabled={disabled} onClick={() => p.removePendingSpeaker(s.speakerId)}
          style={btn('var(--rose)', disabled)}>삭제</button>
      </div>
      {label && !check.ok && (
        <span data-testid="speaker-name-problem" style={{ fontSize: 10, color: 'var(--rose)' }}>
          {REFUSAL_LABEL[`SPEAKER_LABEL_${check.problem}`]}
        </span>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', minWidth: 0 }}>
        <textarea data-testid="starter-line" rows={2} disabled={disabled} value={line}
          placeholder="첫 대사" onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) add() }}
          aria-label={`${label || '새 인물'} 첫 대사`}
          style={{ ...inputBox, flex: '1 1 auto', width: '100%', resize: 'vertical', boxSizing: 'border-box' }} />
        <button type="button" data-testid="starter-add" disabled={!canAdd} onClick={add}
          style={btn('var(--cyan)', !canAdd)}>대화 추가</button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 선택한 인물 한 명의 목소리 패널
// ─────────────────────────────────────────────────────────────────────────────

function SpeakerVoicePanel(props: {
  speaker: DialogueSpeaker
  voiceId: string
  voice: SpeakerVoiceState | null
  disabled: boolean
  onAssignVoice: (speakerId: string, label: string) => void
  onRemoveVoice: (speakerId: string) => void
  onPreviewVoice: (speakerId: string) => void
  renderRegionEditor?: (speakerId: string) => ReactNode
  onToggleEmotionVoice?: (speakerId: string, on: boolean) => void
  onClose: () => void
}) {
  const { speaker: s, voiceId, voice, disabled } = props
  const label = s.label.trim()
  return (
    <div data-testid="voice-panel" data-speaker={voiceId} role="region" aria-label={`${label} 목소리`}
      style={{ ...card, border: '1px solid var(--cyan)', gap: 8 }}>
      <div style={rowFlex}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--cyan)' }}>{label} 목소리</span>
        <span data-testid="speaker-voice-decision" style={{ fontSize: 10, color: voice?.decision.ok ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
          {voice ? referenceDecisionText(voice.decision) : '목소리 없음'}
        </span>
        {voice?.fileName && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', maxWidth: 160 }}>{voice.fileName}</span>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" data-testid="voice-panel-close" onClick={props.onClose}
          style={btn('var(--text-secondary)', false)}>닫기</button>
      </div>
      <div style={rowFlex}>
        <button type="button" disabled={disabled || !voiceId} onClick={() => props.onAssignVoice(voiceId, label)}
          style={btn('var(--cyan)', disabled || !voiceId)}>
          {voice?.registered ? '목소리 바꾸기' : '목소리 지정'}
        </button>
        {voice?.registered && (
          <>
            <button type="button" disabled={disabled || !voice.ready} onClick={() => props.onPreviewVoice(voiceId)}
              style={btn('var(--text-secondary)', disabled || !voice.ready)}>▶ 재생</button>
            <button type="button" disabled={disabled} onClick={() => props.onRemoveVoice(voiceId)}
              style={btn('var(--rose)', disabled)}>목소리 해제</button>
          </>
        )}
      </div>
      {voice?.registered && (voice.sharedWith?.length ?? 0) > 0 && (
        <span data-testid="speaker-voice-shared" style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}>
          {voice.sharedWith!.join(', ')} 와 같은 파일을 씁니다. 같은 목소리로 만들어집니다.
        </span>
      )}
      {/* 감정별 목소리 — 고급 설정. 구성이 이 인물의 감정별 음원을 가질 때만 보이고 기본은 꺼짐. */}
      {(voice?.emotionVoiceAvailable?.length ?? 0) > 0 && (
        <label data-testid="speaker-emotion-voice-toggle"
          style={{ fontSize: 10, display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={!!voice!.emotionVoiceEnabled} disabled={disabled}
            onChange={(e) => props.onToggleEmotionVoice?.(voiceId, e.target.checked)} />
          감정별 목소리 사용
        </label>
      )}
      {(voice?.emotionVoiceAvailable?.length ?? 0) > 0 && voice!.emotionVoiceEnabled && (
        <span data-testid="speaker-voice-emotion-override" style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}>
          감정별 목소리 사용 중: {voice!.emotionOverrides!.join(', ')} — 이 감정의 대사는 그 음원으로 만들어지고,
          나머지 대사는 기본 목소리로 만들어집니다.
        </span>
      )}
      {(voice?.emotionVoiceAvailable?.length ?? 0) > 0 && !voice!.emotionVoiceEnabled && (
        <span data-testid="speaker-voice-emotion-off" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          감정별 음원 있음(꺼짐): {voice!.emotionVoiceAvailable!.join(', ')} — 지금은 기본 목소리만 사용합니다.
        </span>
      )}
      {/* 참조 구간 — 이 인물 한 명의 파형만. */}
      {voice?.registered && props.renderRegionEditor?.(voiceId)}
    </div>
  )
}
