/**
 * 여러 명 화면 — **인물의 한 발화 카드**가 기본 단위다. 인물·목소리·대사가 카드 하나에 있다.
 *
 * 카드 하나 = 누가(인물) · 어떤 목소리(짧은 상태, 누르면 그 카드 안에 상세가 펼쳐진다) · 어디서 어떤 감정(`+ 감정` 으로
 * 대사 안 커서 위치에 태그) · 무엇을(대사 한 칸) · 순서 이동 · 삭제.
 *   · 같은 인물이 다시 말하면 새 카드. 같은 인물의 카드는 같은 인물 id 와 목소리 설정(확정 구간 포함)을 공유한다.
 *   · 목소리 상세(원본 파형·구간 수정)는 **누른 카드 안**에 하나만 펼친다. 위쪽에 별도 참조 패널을 두지 않는다.
 *   · 대화 추가는 목록 아래 `+ 대화 추가` 하나. 작은 설정 창에서 기존 인물을 고르거나 새 인물(이름·목소리)을 만들고,
 *     완료하면 카드가 생기고 그 카드의 대사 칸에 포커스가 간다. 대사는 설정 창에서 쓰지 않는다. 취소하면 무변경.
 *   · 빈 대본의 첫 진입은 처음 불러온 목소리를 이어받은 `인물1` 카드 하나. 첫 대사는 그 카드에 바로 쓴다.
 *     카드에 쓴 내용은 blur/Ctrl+Enter 로 목록(원문)에 반영된다 — 별도 추가 버튼이 없다.
 *
 * 이 컴포넌트가 하지 않는 것
 *   · 대본을 다시 parse 하지 않는다. 화자·발화·좌표는 훅(계획)이 준 것만 쓴다.
 *   · 원문을 직접 쓰지 않는다. 모든 변경은 훅 → source patcher 를 거친다. 빈 카드·설정 창은 원문에 아무것도 쓰지 않는다.
 *   · 대사 원문을 복제한 두 번째 textarea·기본 감정 select 를 만들지 않는다.
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
import { regionText } from '../../shared/referencePolicy'
import type { ReferenceDecision } from '../../shared/speakerReference'

/** 셸이 넘기는 인물별 목소리 상태 — 기존 store 슬롯에서 온다. */
export interface SpeakerVoiceState {
  registered: boolean
  ready: boolean
  fileName: string
  decision: ReferenceDecision
  /** 준비되지 않은 이유(슬롯 message). 구간 확정이 필요한지 판단하는 데 쓴다. */
  message?: string
  /** 실제로 모델에 가는 구간. null/없음 = 원본 전체. */
  region?: { start: number; duration: number } | null
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
  SPEAKER_LABEL_DUPLICATE: '같은 이름의 인물이 이미 있습니다. 기존 인물을 고르거나 다른 이름을 쓰세요',
  TEXT_NOT_EMPTY: '이미 대본이 있어 새로 시작할 수 없습니다',
}

function btn(color: string, off: boolean): CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: 'none',
    cursor: off ? 'not-allowed' : 'pointer', background: 'var(--bg-elevated)', color,
    fontFamily: 'inherit', opacity: off ? 0.45 : 1, whiteSpace: 'nowrap',
  }
}
const select: CSSProperties = {
  fontSize: 12, fontWeight: 600, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit',
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--cyan)', minWidth: 0, maxWidth: '100%',
}
const inputBox: CSSProperties = {
  fontSize: 12, padding: '6px 8px', borderRadius: 6, fontFamily: 'inherit', minWidth: 0,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary, var(--text-secondary))', lineHeight: 1.5,
}
const card: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10,
  border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated, transparent)',
  minWidth: 0, width: '100%', boxSizing: 'border-box',
}
const rowFlex: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }
const sub: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }

/** 카드 머리의 짧은 목소리 상태 — 기본 화면에 보이는 것은 이 한 줄뿐이다. 자세한 것은 카드 안 상세에서. */
export function voiceStatusShort(voice: SpeakerVoiceState | null): string {
  if (!voice || !voice.registered) return '목소리 선택 필요'
  if (voice.ready) return `준비됨 · ${regionText(voice.region)}`
  if ((voice.message ?? '').includes('구간')) return '구간 선택 필요'
  return '목소리 확인 중'
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
  /** 그 인물 한 명의 원본 파형·구간 편집기. open=false 면 접힌 상태(분석·준비는 계속). */
  renderRegionEditor?: (speakerId: string, open: boolean) => ReactNode
  onToggleEmotionVoice?: (speakerId: string, on: boolean) => void
  /** 감정별 목소리 후보 편집기(고급) — 셸이 주입한다. 이 카드가 유일한 편집 위치다. */
  renderEmotionVoiceEditor?: (speakerId: string, label: string) => ReactNode
  /** 시작 카드의 이름이 바뀌어 내부 id 가 달라졌다 — 셸이 목소리 슬롯을 새 id 로 옮긴다. */
  onSpeakerIdChanged?: (fromId: string, toId: string) => void
  /**
   * 원문에 있는 인물의 이름 변경(카드 상세의 '이름 바꾸기'). 셸이 모든 발화 표기·목소리 슬롯·감정별 설정·목소리 구성을 함께 옮긴다.
   * 거부 코드(다른 인물과 충돌 등)를 돌려주면 카드가 안내한다. 자동 병합은 없다.
   */
  onRenameSpeaker?: (speakerId: string, newLabel: string) => string | null
  disabled?: boolean
}

/** 기존 인물의 새 발화 — 아직 원문에 없는 카드. 대사를 쓰고 반영하기 전까지 어디에도 저장되지 않는다. */
interface PendingUtterance { key: string; label: string }

export default function MultiSpeakerDialogue(props: MultiSpeakerDialogueProps) {
  const { projection: p, emotions, emotionTagOf, speakerIdOf, voiceOf, disabled = false } = props
  // 목소리 상세는 한 번에 한 카드 안에서만 펼친다(파형도 한 명만).
  const [voiceOpen, setVoiceOpen] = useState<{ speakerId: string; cardKey: string } | null>(null)
  const [pendingUtts, setPendingUtts] = useState<PendingUtterance[]>([])
  const pendingSeq = useRef(0)
  // 새로 만든 카드의 대사 칸에 포커스를 준다.
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  // 빈 대본이면 1번 인물의 시작 카드 하나만 **보여 준다** — 어디에도 쓰지 않는다. 2번 이후는 사용자가 만든다.
  useEffect(() => {
    if (p.verdict.mode === 'initial' && p.speakers.length === 0) p.ensurePendingSpeakers(1)
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
    ? (p.rows.length > 0 ? `인물 없음 · 대사 ${p.rows.length}개는 기본 인물` : '첫 인물의 대사를 카드에 입력하세요')
    : `인물 ${namedSpeakers.length}명 · ${notReady.length === 0 ? '모두 준비됨' : `목소리 준비 안 됨 ${notReady.length}명: ${notReady.join(', ')}`}`
      + (defaultRows > 0 ? ` · 기본 인물 대사 ${defaultRows}개` : '')

  /** 카드에 쓴 첫 대사를 원문에 반영한다(빈 대본이면 새로 시작, 아니면 마지막 뒤에 추가). 빈 대사는 반영하지 않는다. */
  const commitNewLine = (label: string, line: string): string | null => {
    if (!line.trim()) return null
    if (p.rows.length === 0) return p.createInitial([{ speakerLabel: label, line }])
    return p.insertAfter(p.rows.length - 1, label, line, null)
  }

  const openAdd = () => { if (!disabled) setAddOpen(true) }
  /** 설정 창 완료: 기존 인물이면 그 인물의 빈 카드, 새 인물이면 이름 카드(시작 카드)를 만든다. 원문은 쓰지 않는다. */
  const addExisting = (label: string) => {
    const key = `pu-${++pendingSeq.current}`
    setPendingUtts((u) => [...u, { key, label }])
    setFocusKey(key)
    setAddOpen(false)
  }
  const addNew = (label: string) => {
    p.addPendingSpeakerNamed(label)
    setFocusKey(`pending:${label}`)
    setAddOpen(false)
  }

  return (
    <div data-testid="multi-dialogue" data-mode={p.verdict.mode}
      data-blockers={p.verdict.blockers.join(' ')}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      {p.verdict.blockers.length > 0 && (
        <div data-testid="multi-dialogue-transient" role="status" aria-live="polite" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          {blockerText.join(' · ')}
        </div>
      )}
      {p.lastRefusal && (
        <div data-testid="multi-dialogue-refusal" role="status" aria-live="polite" style={{ fontSize: 10, color: 'var(--amber, #f59e0b)' }}>
          {REFUSAL_LABEL[p.lastRefusal] ?? p.lastRefusal}
        </div>
      )}

      <div data-testid="multi-summary" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{summary}</div>

      {/* ── 발화 카드 — 1열 전체 폭. 목소리 상세는 누른 카드 안에 펼친다. ── */}
      <div data-testid="multi-rows" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {p.rows.map((r, i) => {
          const cardKey = `row-${r.view.sourceStart}-${r.view.sourceEnd}`
          const sid = r.view.speakerId
          return (
            <UtteranceCard key={cardKey} row={r} index={i}
              projection={p} disabled={disabled} emotions={emotions} emotionTagOf={emotionTagOf}
              speakerLabels={speakerLabels}
              voice={sid ? voiceOf(sid) : null}
              voiceDetailOpen={!!sid && voiceOpen?.speakerId === sid && voiceOpen.cardKey === cardKey}
              onToggleVoice={() => { if (!sid) return; setVoiceOpen((v) => (v && v.cardKey === cardKey ? null : { speakerId: sid, cardKey })) }}
              renderVoiceDetail={() => sid ? (
                <SpeakerVoicePanel voiceId={sid} label={r.view.speakerLabel ?? ''} voice={voiceOf(sid)} disabled={disabled}
                  onAssignVoice={props.onAssignVoice} onRemoveVoice={props.onRemoveVoice} onPreviewVoice={props.onPreviewVoice}
                  renderRegionEditor={props.renderRegionEditor} onToggleEmotionVoice={props.onToggleEmotionVoice}
                  renderEmotionVoiceEditor={props.renderEmotionVoiceEditor} onClose={() => setVoiceOpen(null)}
                  onRenameSpeaker={props.onRenameSpeaker ? ((label) => props.onRenameSpeaker!(sid, label)) : undefined} />
              ) : null} />
          )
        })}
        {/* 기존 인물의 새 발화(아직 원문에 없음) — 대사를 쓰면 반영되고 카드가 목록으로 옮겨 간다. */}
        {pendingUtts.map((u) => (
          <PendingUtteranceCard key={u.key} label={u.label} disabled={disabled}
            voice={voiceOf(speakerIdOf(u.label))}
            index={p.rows.length + 1}
            autoFocus={focusKey === u.key}
            canCommit={p.rows.length === 0 || p.patchAllowed}
            onCommit={(line) => {
              const refused = commitNewLine(u.label, line)
              if (refused === null && line.trim()) setPendingUtts((all) => all.filter((x) => x.key !== u.key))
            }}
            onCancel={() => setPendingUtts((all) => all.filter((x) => x.key !== u.key))} />
        ))}
        {/* 아직 원문에 없는 인물 — 이름·목소리·첫 대사를 카드 안에서. 넣기 전엔 어디에도 쓰지 않는다. */}
        {p.speakers.filter((s) => s.pending).map((s) => (
          <StarterCard key={s.speakerId} speaker={s} projection={p} disabled={disabled}
            voiceId={validateSpeakerLabel(s.label.trim()).ok ? speakerIdOf(s.label.trim()) : ''}
            voiceOf={voiceOf} speakerIdOf={speakerIdOf}
            autoFocus={focusKey === `pending:${s.label}`}
            voiceDetailOpen={voiceOpen?.cardKey === `pending-${s.speakerId}`}
            onToggleVoice={(id) => setVoiceOpen((v) => (v && v.cardKey === `pending-${s.speakerId}` ? null : { speakerId: id, cardKey: `pending-${s.speakerId}` }))}
            renderVoiceDetail={(id) => (
              <SpeakerVoicePanel voiceId={id} label={s.label.trim()} voice={voiceOf(id)} disabled={disabled}
                onAssignVoice={props.onAssignVoice} onRemoveVoice={props.onRemoveVoice} onPreviewVoice={props.onPreviewVoice}
                renderRegionEditor={props.renderRegionEditor} onToggleEmotionVoice={props.onToggleEmotionVoice}
                renderEmotionVoiceEditor={props.renderEmotionVoiceEditor} onClose={() => setVoiceOpen(null)} />
            )}
            onSpeakerIdChanged={props.onSpeakerIdChanged}
            onCommit={(label, line) => commitNewLine(label, line)} />
        ))}
      </div>

      {/* + 대화 추가 — 하나. 설정 창에서 기존 인물을 고르거나 새 인물(이름·목소리)을 만든다. 대사는 카드에서. */}
      <div data-testid="dialogue-add" style={rowFlex}>
        <button type="button" data-testid="dialogue-add-open" disabled={disabled} onClick={openAdd}
          aria-expanded={addOpen} style={btn('var(--cyan)', disabled)}>+ 대화 추가</button>
      </div>
      {addOpen && (
        <AddDialogueSheet speakerLabels={speakerLabels} speakerIdOf={speakerIdOf} voiceOf={voiceOf} disabled={disabled}
          existingIds={new Set(p.speakers.map((s) => voiceIdOf(s)))}
          onAssignVoice={props.onAssignVoice} onRemoveVoice={props.onRemoveVoice}
          onExisting={addExisting} onNew={addNew} onCancel={() => setAddOpen(false)} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 발화 카드
// ─────────────────────────────────────────────────────────────────────────────

function useCaretInsert(value: string, disabled: boolean, onDraft: (text: string) => void, begin: () => void) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  // 마지막으로 유효했던 caret — textarea 가 포커스를 잃어도 기억한다.
  const lastCaret = useRef<number | null>(null)
  // 한글 IME 조합 중에는 삽입하지 않고 조합이 끝난 뒤 넣는다.
  const composing = useRef(false)
  const queuedTag = useRef<string | null>(null)
  const rememberCaret = () => { const ta = taRef.current; if (ta) lastCaret.current = ta.selectionStart }
  /** caret 위치에 태그를 넣는다. 네이티브 undo 가 살도록 execCommand 로 넣고, 안 되면 draft 로 넣는다. */
  const insertTag = (tag: string) => {
    if (disabled) return
    if (composing.current) { queuedTag.current = tag; return }
    const ta = taRef.current
    const caret = lastCaret.current ?? (ta ? ta.selectionStart : null)
    const res = insertTagAtCaret(value, caret, tag)
    begin()
    if (ta) {
      ta.focus()
      ta.setSelectionRange(res.insertAt, res.insertAt)
      let ok = false
      try { ok = typeof document.execCommand === 'function' && document.execCommand('insertText', false, res.inserted) } catch { ok = false }
      if (!ok) onDraft(res.text)
      requestAnimationFrame(() => { try { ta.setSelectionRange(res.caret, res.caret) } catch { /* noop */ } })
    } else {
      onDraft(res.text)
    }
    lastCaret.current = res.caret
  }
  const onCompositionStart = () => { composing.current = true }
  const onCompositionEnd = () => {
    composing.current = false
    const q = queuedTag.current
    if (q) { queuedTag.current = null; requestAnimationFrame(() => insertTag(q)) }
  }
  return { taRef, rememberCaret, insertTag, onCompositionStart, onCompositionEnd }
}

function EmotionAdd(props: { emotions: readonly { id: string; label: string }[]; emotionTagOf: (id: string) => string; disabled: boolean; onInsert: (tag: string) => void }) {
  const [pickerOpen, setPickerOpen] = useState(false)
  return (
    <div style={{ position: 'relative', flex: '0 0 auto' }}>
      <button type="button" data-testid="emotion-add" disabled={props.disabled}
        onClick={() => setPickerOpen((o) => !o)} aria-expanded={pickerOpen}
        title="커서 위치에 감정 넣기" style={btn('var(--cyan)', props.disabled)}>+ 감정</button>
      {pickerOpen && (
        <div data-testid="emotion-picker" role="menu"
          style={{ position: 'absolute', right: 0, top: '110%', zIndex: 5, display: 'flex', flexWrap: 'wrap', gap: 4,
            width: 220, maxWidth: '70vw', padding: 6, borderRadius: 8, background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)', boxShadow: '0 4px 14px rgba(0,0,0,.25)' }}>
          {props.emotions.filter((e) => e.id !== 'default').map((e) => (
            <button key={e.id} type="button" role="menuitem" data-emotion={e.id}
              onMouseDown={(ev) => ev.preventDefault() /* textarea 포커스·caret 유지 */}
              onClick={() => { props.onInsert(props.emotionTagOf(e.id)); setPickerOpen(false) }}
              style={btn('var(--text-secondary)', false)}>{e.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

function UtteranceCard(props: {
  row: DialogueRow
  index: number
  projection: DialogueProjection
  disabled: boolean
  emotions: readonly { id: string; label: string }[]
  emotionTagOf: (emotionId: string) => string
  speakerLabels: string[]
  voice: SpeakerVoiceState | null
  voiceDetailOpen: boolean
  onToggleVoice: () => void
  renderVoiceDetail: () => ReactNode
}) {
  const { row: r, index: i, projection: p, disabled, voice } = props
  const draft = p.draftOf(i)
  const value = draft ?? r.content
  const up = p.moveAllowed(i, -1)
  const down = p.moveAllowed(i, 1)
  const speakerSelectId = `dlg-speaker-${i}`
  const caret = useCaretInsert(value, disabled, (t) => p.updateDraft(i, t), () => p.beginDraft(i))

  return (
    <div data-testid="dialogue-row" data-index={i} data-speaker={r.view.speakerId ?? ''} style={card}>
      {/* 머리: 번호 · 인물 · 목소리 상태(누르면 이 카드 안에 상세) · 이동/삭제 */}
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
          <button type="button" data-testid="card-voice" onClick={props.onToggleVoice} disabled={disabled}
            aria-expanded={props.voiceDetailOpen} title="이 인물의 목소리 설정"
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

      {/* 목소리 상세 — 이 카드 안에서만. 같은 인물의 다른 카드에도 같은 설정이 적용된다. */}
      {props.voiceDetailOpen && props.renderVoiceDetail()}

      {/* 대사 — 대화칸 하나. 감정 태그는 이 안에 글자 그대로. 입력은 계획 상태와 무관하게 받고 blur/Ctrl+Enter 에 반영. */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', minWidth: 0 }}>
        <textarea ref={caret.taRef} data-testid="dialogue-body" rows={2} disabled={disabled}
          value={value}
          onFocus={() => p.beginDraft(i)}
          onChange={(e) => { p.updateDraft(i, e.target.value); caret.rememberCaret() }}
          onSelect={caret.rememberCaret} onKeyUp={caret.rememberCaret} onClick={caret.rememberCaret}
          onCompositionStart={caret.onCompositionStart}
          onCompositionEnd={caret.onCompositionEnd}
          onBlur={() => { caret.rememberCaret(); p.commitDraft(i) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) p.commitDraft(i) }}
          aria-label={`${i + 1}번 대사`}
          style={{ ...inputBox, flex: '1 1 auto', width: '100%', resize: 'vertical', boxSizing: 'border-box' }} />
        <EmotionAdd emotions={props.emotions} emotionTagOf={props.emotionTagOf} disabled={disabled} onInsert={caret.insertTag} />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 기존 인물의 새 발화 카드(아직 원문에 없음) — 대사를 쓰면 반영된다.
// ─────────────────────────────────────────────────────────────────────────────

function PendingUtteranceCard(props: {
  label: string
  index: number
  disabled: boolean
  voice: SpeakerVoiceState | null
  autoFocus: boolean
  canCommit: boolean
  onCommit: (line: string) => void
  onCancel: () => void
}) {
  const [line, setLine] = useState('')
  const commit = () => { if (props.canCommit && line.trim()) props.onCommit(line) }
  return (
    <div data-testid="pending-utterance" data-speaker-label={props.label} style={card}>
      <div style={rowFlex}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', minWidth: 18 }}>{props.index}.</span>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--cyan)' }}>{props.label}</span>
        <span style={{ fontSize: 11, color: props.voice?.ready ? 'var(--text-secondary)' : 'var(--amber, #d4a017)' }}>· {voiceStatusShort(props.voice)}</span>
        <span style={{ flex: 1 }} />
        <button type="button" disabled={props.disabled} onClick={props.onCancel} style={btn('var(--rose)', props.disabled)}>삭제</button>
      </div>
      <textarea data-testid="pending-line" rows={2} disabled={props.disabled} value={line} autoFocus={props.autoFocus}
        placeholder="대사를 입력하면 목록에 반영됩니다" onChange={(e) => setLine(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit() }}
        aria-label={`${props.label} 새 대사`}
        style={{ ...inputBox, width: '100%', resize: 'vertical', boxSizing: 'border-box' }} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 아직 원문에 없는 인물의 시작 카드 — 이름·목소리·첫 대사. 첫 대사를 쓰면 반영된다(별도 추가 버튼 없음).
// ─────────────────────────────────────────────────────────────────────────────

function StarterCard(props: {
  speaker: DialogueSpeaker
  projection: DialogueProjection
  disabled: boolean
  voiceId: string
  voiceOf: (speakerId: string) => SpeakerVoiceState | null
  speakerIdOf: (label: string) => string
  autoFocus: boolean
  voiceDetailOpen: boolean
  onToggleVoice: (voiceId: string) => void
  renderVoiceDetail: (voiceId: string) => ReactNode
  onSpeakerIdChanged?: (fromId: string, toId: string) => void
  onCommit: (label: string, line: string) => string | null
}) {
  const { speaker: s, projection: p, disabled, voiceId } = props
  const [line, setLine] = useState('')
  const label = s.label.trim()
  const check = validateSpeakerLabel(label)
  const voice = voiceId ? props.voiceOf(voiceId) : null
  const canCommit = !disabled && check.ok && !!line.trim() && (p.rows.length === 0 || p.patchAllowed)
  const commit = () => {
    if (!canCommit) return
    const refused = props.onCommit(label, line)
    if (refused === null) { p.removePendingSpeaker(s.speakerId); setLine('') }
  }
  const rename = (next: string) => {
    const fromId = check.ok ? props.speakerIdOf(label) : ''
    const nextCheck = validateSpeakerLabel(next.trim())
    const toId = nextCheck.ok ? props.speakerIdOf(next.trim()) : ''
    p.renamePendingSpeaker(s.speakerId, next)
    // 이름이 바뀌어 내부 id 가 달라지면 목소리 슬롯도 따라간다(이어받은 첫 목소리 포함).
    if (fromId && toId && fromId !== toId) props.onSpeakerIdChanged?.(fromId, toId)
  }
  return (
    <div data-testid="starter-card" data-speaker={s.speakerId} data-pending="true" style={card}>
      <div style={rowFlex}>
        <label htmlFor={`spk-name-${s.speakerId}`} style={{ fontSize: 10, color: 'var(--text-muted)' }}>이름</label>
        <input id={`spk-name-${s.speakerId}`} value={s.label} disabled={disabled} placeholder="인물 이름"
          onChange={(e) => rename(e.target.value)}
          style={{ ...inputBox, flex: '1 1 120px' }} />
        <button type="button" data-testid="card-voice" disabled={disabled || !voiceId}
          onClick={() => props.onToggleVoice(voiceId)} aria-expanded={props.voiceDetailOpen} title="이 인물의 목소리 설정"
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
      {props.voiceDetailOpen && voiceId && props.renderVoiceDetail(voiceId)}
      <textarea data-testid="starter-line" rows={2} disabled={disabled} value={line} autoFocus={props.autoFocus}
        placeholder="첫 대사를 입력하면 목록에 반영됩니다" onChange={(e) => setLine(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commit() }}
        aria-label={`${label || '새 인물'} 첫 대사`}
        style={{ ...inputBox, width: '100%', resize: 'vertical', boxSizing: 'border-box' }} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// + 대화 추가 설정 창 — 기존 인물 선택 / 새 인물(이름·목소리). 대사는 여기서 쓰지 않는다. 취소 = 무변경.
// ─────────────────────────────────────────────────────────────────────────────

function AddDialogueSheet(props: {
  speakerLabels: string[]
  speakerIdOf: (label: string) => string
  voiceOf: (speakerId: string) => SpeakerVoiceState | null
  existingIds: Set<string>
  disabled: boolean
  onAssignVoice: (speakerId: string, label: string) => void
  onRemoveVoice: (speakerId: string) => void
  onExisting: (label: string) => void
  onNew: (label: string) => void
  onCancel: () => void
}) {
  const hasExisting = props.speakerLabels.length > 0
  const [mode, setMode] = useState<'existing' | 'new'>(hasExisting ? 'existing' : 'new')
  const [existing, setExisting] = useState(props.speakerLabels[0] ?? '')
  const [name, setName] = useState('')
  // 이 창에서 새 인물에 목소리를 지정했는가 — 취소하면 그 지정만 되돌린다(자산은 지우지 않는다).
  const assignedHere = useRef<string | null>(null)
  const trimmed = name.trim()
  const check = validateSpeakerLabel(trimmed)
  const newId = check.ok ? props.speakerIdOf(trimmed) : ''
  const duplicate = !!newId && (props.existingIds.has(newId) || props.speakerLabels.some((l) => props.speakerIdOf(l) === newId))
  const newVoice = newId ? props.voiceOf(newId) : null
  const canDone = mode === 'existing' ? !!existing : (check.ok && !duplicate)
  const cancel = () => {
    if (assignedHere.current) props.onRemoveVoice(assignedHere.current)
    props.onCancel()
  }
  return (
    <div data-testid="dialogue-add-dialog" role="dialog" aria-label="대화 추가" style={{ ...card, border: '1px solid var(--cyan)', gap: 8 }}>
      <div style={rowFlex}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--cyan)' }}>대화 추가</span>
        <span style={sub}>누가 말하는 카드를 만들지 고르세요. 대사는 만들어진 카드에 씁니다.</span>
      </div>
      <div role="radiogroup" aria-label="인물 선택 방식" style={rowFlex}>
        <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text-secondary)' }}>
          <input type="radio" name="dlg-add-mode" checked={mode === 'existing'} disabled={props.disabled || !hasExisting}
            onChange={() => setMode('existing')} /> 기존 인물
        </label>
        <label style={{ fontSize: 11, display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text-secondary)' }}>
          <input type="radio" name="dlg-add-mode" checked={mode === 'new'} disabled={props.disabled}
            onChange={() => setMode('new')} /> 새 인물
        </label>
      </div>
      {mode === 'existing' ? (
        <div style={rowFlex}>
          <label htmlFor="dlg-add-existing" style={{ fontSize: 10, color: 'var(--text-muted)' }}>인물</label>
          <select id="dlg-add-existing" value={existing} disabled={props.disabled} style={select}
            onChange={(e) => setExisting(e.target.value)}>
            {props.speakerLabels.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          {existing && (
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              · {voiceStatusShort(props.voiceOf(props.speakerIdOf(existing)))} — 준비된 목소리를 그대로 씁니다
            </span>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={rowFlex}>
            <label htmlFor="dlg-add-name" style={{ fontSize: 10, color: 'var(--text-muted)' }}>이름</label>
            <input id="dlg-add-name" data-testid="dialogue-add-name" value={name} disabled={props.disabled} placeholder="인물 이름"
              autoFocus onChange={(e) => setName(e.target.value)} style={{ ...inputBox, flex: '1 1 140px' }} />
            <button type="button" data-testid="dialogue-add-voice" disabled={props.disabled || !newId || duplicate}
              onClick={() => { assignedHere.current = newId; props.onAssignVoice(newId, trimmed) }}
              style={btn('var(--cyan)', props.disabled || !newId || duplicate)}>
              {newVoice?.registered ? '목소리 바꾸기' : '목소리 지정'}
            </button>
            {newId && !duplicate && (
              <span style={{ fontSize: 11, color: newVoice?.ready ? 'var(--text-secondary)' : 'var(--text-muted)' }}>· {voiceStatusShort(newVoice)}</span>
            )}
          </div>
          {trimmed && !check.ok && (
            <span data-testid="speaker-name-problem" style={{ fontSize: 10, color: 'var(--rose)' }}>{REFUSAL_LABEL[`SPEAKER_LABEL_${check.problem}`]}</span>
          )}
          {duplicate && (
            <span data-testid="speaker-name-problem" style={{ fontSize: 10, color: 'var(--rose)' }}>{REFUSAL_LABEL.SPEAKER_LABEL_DUPLICATE}</span>
          )}
          <span style={sub}>목소리는 나중에 카드에서 지정해도 됩니다.</span>
        </div>
      )}
      <div style={rowFlex}>
        <button type="button" data-testid="dialogue-add-done" disabled={props.disabled || !canDone}
          onClick={() => (mode === 'existing' ? props.onExisting(existing) : props.onNew(trimmed))}
          style={btn('var(--cyan)', props.disabled || !canDone)}>완료</button>
        <button type="button" data-testid="dialogue-add-cancel" onClick={cancel} style={btn('var(--text-secondary)', false)}>취소</button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 인물 한 명의 목소리 상세 — 누른 카드 안에 펼쳐진다(한 번에 하나).
// ─────────────────────────────────────────────────────────────────────────────

function SpeakerVoicePanel(props: {
  voiceId: string
  label: string
  voice: SpeakerVoiceState | null
  disabled: boolean
  onAssignVoice: (speakerId: string, label: string) => void
  onRemoveVoice: (speakerId: string) => void
  onPreviewVoice: (speakerId: string) => void
  renderRegionEditor?: (speakerId: string, open: boolean) => ReactNode
  onToggleEmotionVoice?: (speakerId: string, on: boolean) => void
  /** 감정별 목소리 후보 편집기(고급) — 셸이 주입한다. 이 카드가 유일한 편집 위치다. */
  renderEmotionVoiceEditor?: (speakerId: string, label: string) => ReactNode
  /** 원문에 있는 인물만(시작 카드는 이름 입력이 따로 있다). 거부 코드를 돌려주면 그대로 안내한다. */
  onRenameSpeaker?: (newLabel: string) => string | null
  onClose: () => void
}) {
  const { voiceId, label, voice, disabled } = props
  const [emotionOpen, setEmotionOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(label)
  const [renameProblem, setRenameProblem] = useState<string | null>(null)
  const applyRename = () => {
    if (!props.onRenameSpeaker) return
    const next = renameValue.trim()
    if (next === label) { setRenameOpen(false); return }
    const check = validateSpeakerLabel(next)
    if (!check.ok) { setRenameProblem(REFUSAL_LABEL[`SPEAKER_LABEL_${check.problem}`] ?? check.problem); return }
    const refused = props.onRenameSpeaker(next)
    if (refused) { setRenameProblem(REFUSAL_LABEL[refused] ?? refused); return }
    setRenameProblem(null); setRenameOpen(false)
  }
  // 원본 파형·구간 수정은 필요할 때만 펼친다. 접혀 있어도 분석·준비는 계속 돈다.
  const [regionOpen, setRegionOpen] = useState(false)
  return (
    <div data-testid="voice-panel" data-speaker={voiceId} role="region" aria-label={`${label} 목소리`}
      style={{ ...card, border: '1px solid var(--cyan)', gap: 8, background: 'var(--bg-card)' }}>
      <div style={rowFlex}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--cyan)' }}>{label} 목소리</span>
        <span data-testid="speaker-voice-decision" style={{ fontSize: 11, color: voice?.ready ? 'var(--text-secondary)' : 'var(--amber, #d4a017)' }}>
          {voiceStatusShort(voice)}
        </span>
        {voice?.fileName && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>{voice.fileName}</span>
        )}
        <span style={{ flex: 1 }} />
        {props.onRenameSpeaker && (
          <button type="button" data-testid="speaker-rename-toggle" disabled={disabled} aria-expanded={renameOpen}
            onClick={() => { setRenameValue(label); setRenameProblem(null); setRenameOpen((o) => !o) }} style={btn('var(--text-secondary)', disabled)}>이름 바꾸기</button>
        )}
        <button type="button" data-testid="voice-panel-close" onClick={props.onClose} style={btn('var(--text-secondary)', false)}>닫기</button>
      </div>
      {renameOpen && props.onRenameSpeaker && (
        <div data-testid="speaker-rename" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={rowFlex}>
            <label htmlFor={`spk-rename-${voiceId}`} style={{ fontSize: 10, color: 'var(--text-muted)' }}>새 이름</label>
            <input id={`spk-rename-${voiceId}`} data-testid="speaker-rename-input" value={renameValue} disabled={disabled}
              onChange={(e) => { setRenameValue(e.target.value); setRenameProblem(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') applyRename() }} style={{ ...inputBox, flex: '1 1 140px' }} />
            <button type="button" data-testid="speaker-rename-apply" disabled={disabled || !renameValue.trim()} onClick={applyRename}
              style={btn('var(--cyan)', disabled || !renameValue.trim())}>적용</button>
            <button type="button" onClick={() => { setRenameOpen(false); setRenameProblem(null) }} style={btn('var(--text-secondary)', false)}>취소</button>
          </div>
          <span style={sub}>이 인물의 모든 대사와 목소리·구간·감정별 설정이 새 이름으로 함께 유지됩니다.</span>
          {renameProblem && <span data-testid="speaker-rename-problem" style={{ fontSize: 10, color: 'var(--rose)' }}>{renameProblem}</span>}
        </div>
      )}
      {/* 실제 안전 사유(준비 실패)만 그대로 보인다. */}
      {voice?.registered && !voice.ready && voice.message && (
        <span data-testid="speaker-voice-reason" style={{ fontSize: 11, color: 'var(--amber, #d4a017)' }}>{voice.message}</span>
      )}
      {!voice?.registered && (
        <span style={sub}>아직 목소리를 지정하지 않았습니다. 아래 '목소리 지정'으로 음성 파일을 고르세요.</span>
      )}
      <div style={rowFlex}>
        <button type="button" disabled={disabled || !voiceId} onClick={() => props.onAssignVoice(voiceId, label)}
          style={btn('var(--cyan)', disabled || !voiceId)}>
          {voice?.registered ? '목소리 바꾸기' : '목소리 지정'}
        </button>
        {voice?.registered && (
          <>
            <button type="button" disabled={disabled || !voice.ready} onClick={() => props.onPreviewVoice(voiceId)}
              style={btn('var(--text-secondary)', disabled || !voice.ready)}>▶ 재생</button>
            <button type="button" data-testid="voice-region-toggle" disabled={disabled} aria-expanded={regionOpen}
              onClick={() => setRegionOpen((o) => !o)} style={btn('var(--text-secondary)', disabled)}>
              {regionOpen ? '구간 수정 닫기' : '구간 수정'}
            </button>
            <button type="button" disabled={disabled} onClick={() => props.onRemoveVoice(voiceId)}
              style={btn('var(--rose)', disabled)}>목소리 해제</button>
          </>
        )}
      </div>
      <span data-testid="speaker-voice-applies-all" style={sub}>이 인물의 다른 대사에도 같은 목소리·구간이 적용됩니다.</span>
      {voice?.registered && (voice.sharedWith?.length ?? 0) > 0 && (
        <span data-testid="speaker-voice-shared" style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}>
          {voice.sharedWith!.join(', ')} 와 같은 파일을 씁니다. 같은 목소리로 만들어집니다.
        </span>
      )}
      {/* 감정별 목소리 — 고급 설정. 구성이 이 인물의 감정별 음원을 가질 때만 보이고 기본은 꺼짐. */}
      {(voice?.emotionVoiceAvailable?.length ?? 0) > 0 && (
        <label data-testid="speaker-emotion-voice-toggle" style={{ fontSize: 10, display: 'flex', gap: 4, alignItems: 'center', color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={!!voice!.emotionVoiceEnabled} disabled={disabled}
            onChange={(e) => props.onToggleEmotionVoice?.(voiceId, e.target.checked)} />
          감정별 목소리 사용
        </label>
      )}
      {(voice?.emotionVoiceAvailable?.length ?? 0) > 0 && voice!.emotionVoiceEnabled && (
        <span data-testid="speaker-voice-emotion-override" style={{ fontSize: 10, color: 'var(--amber, #d4a017)' }}>
          감정별 목소리 사용 중: {voice!.emotionOverrides!.join(', ')} — 이 감정의 대사는 그 음원으로 만들어지고, 나머지 대사는 기본 목소리로 만들어집니다.
        </span>
      )}
      {(voice?.emotionVoiceAvailable?.length ?? 0) > 0 && !voice!.emotionVoiceEnabled && (
        <span data-testid="speaker-voice-emotion-off" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          감정별 음원 있음(꺼짐): {voice!.emotionVoiceAvailable!.join(', ')} — 지금은 기본 목소리만 사용합니다.
        </span>
      )}
      {/* 원본 전체 파형·구간 수정 — 이 인물 한 명의 편집기만. 접혀 있어도 분석·준비는 계속(마운트 유지). */}
      {voice?.registered && props.renderRegionEditor?.(voiceId, regionOpen)}
      {/* 감정별 목소리 후보(고급) — 접혀 있고, 이 카드가 유일한 편집 위치다. */}
      {props.renderEmotionVoiceEditor && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <button type="button" data-testid="emotion-voice-toggle" aria-expanded={emotionOpen}
            onClick={() => setEmotionOpen((o) => !o)} style={btn('var(--text-muted)', false)}>
            {emotionOpen ? '감정별 목소리 후보 닫기' : '감정별 목소리 후보 (고급)'}
          </button>
          {emotionOpen && <div data-testid="emotion-voice-editor">{props.renderEmotionVoiceEditor(voiceId, label)}</div>}
        </div>
      )}
    </div>
  )
}
