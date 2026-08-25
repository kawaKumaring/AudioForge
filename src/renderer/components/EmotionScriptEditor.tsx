// 감정/쉼 대사 편집기 (A 소유). 계약 §3/§4/§7 + D-1/D-4/D-8.
// 원칙:
//  - 입력 권위 = 실제 textarea. 색상 overlay는 aria-hidden(접근성 텍스트 권위는 textarea).
//  - 태그 삽입은 대사를 절대 삭제하지 않는다(순수 helper insertEmotionTag/insertPauseTag). caret/selection/scroll 복원.
//  - IME 조합 중에는 삽입하지 않고 compositionend 후 flush(큐잉).
//  - 색 그라데이션은 '감정 혼합'이 아니라 '감정 구간 표시'일 뿐(smooth/blending 미지원, 애니메이션 없음).
//  - parsedPreview는 renderer preview(합성 권위는 Python; parity mismatch 시 상위에서 합성 차단).
//  - ⚠️ TTSEditor 배선은 통합 담당 단계. 이 파일은 TTSEditor에 연결하지 않는다.
//  - ⚠️ 실제 Electron 800×600·125/150%·IME·스크롤 동기화 E2E는 shared env에서 검증(D-8 gate). 여기선 미검증.
import { useRef, useMemo, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react'
import type { CSSProperties, ClipboardEvent, Ref, ReactElement, ReactNode } from 'react'
import { ALL_EMOTIONS, EMOTION_ID_TO_LABEL, insertEmotionTag, insertPauseTag } from '@/lib/emotions'
import { parseTtsScript, type ParsedPlan, type TtsGrammarError } from '../../shared/ttsGrammar'
import type { EmotionScriptEditorProps } from '../types/ttsExpression'

const ID_TO_COLOR: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const e of ALL_EMOTIONS) m[e.id] = e.color
  return m
})()

// 감정 참조 준비 상태(등록/미등록/미준비) — EmotionReferenceManager(C) 소유 데이터의 읽기 전용 힌트.
// ttsExpression.ts(비소유)를 수정하지 않기 위해 로컬 optional prop로 확장한다.
export interface EmotionScriptEditorLocalProps extends EmotionScriptEditorProps {
  /** emotionId → {registered, ready}. 미지정 시 준비상태 배지는 '미리보기'로만 표시. */
  refStates?: Record<string, { registered: boolean; ready: boolean }>
}

export interface EmotionScriptEditorHandle {
  /** 현재 textarea selection 기준으로 감정 태그 삽입(대사 무손실). IME 조합 중이면 compositionend 후 flush. */
  insertEmotion: (emotionId: string) => void
  /** 현재 caret/선택 끝에 쉼 태그 삽입. 범위 밖/인접 중복은 무시(상위에 오류 신호). */
  insertPause: (pauseMs: number) => void
  focus: () => void
}

type QueuedOp = { kind: 'emotion'; id: string } | { kind: 'pause'; ms: number }

// 준비상태 → 배지 텍스트/색.
function refBadge(state?: { registered: boolean; ready: boolean }): { label: string; color: string } {
  if (!state || !state.registered) return { label: '미등록', color: 'var(--text-secondary)' }
  if (!state.ready) return { label: '미준비', color: '#f59e0b' }
  return { label: '등록', color: '#4ade80' }
}

const wrapStyle: CSSProperties = { position: 'relative', width: '100%' }
// overlay와 textarea는 동일 typography/padding/줄바꿈 규칙을 공유해야 위치가 맞는다.
const sharedBoxStyle: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  fontFamily: 'inherit',
  fontSize: '14px',
  lineHeight: '1.6',
  letterSpacing: 'normal',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'break-word',
  boxSizing: 'border-box',
  border: '1px solid var(--border, #33384a)',
  borderRadius: '8px',
}

function EmotionScriptEditorImpl(
  props: EmotionScriptEditorLocalProps,
  ref: Ref<EmotionScriptEditorHandle>,
): ReactElement {
  const { value, parsedPreview, parseErrors, onChange, onInsertEmotion, onInsertPause, disabled, refStates } = props
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const queueRef = useRef<QueuedOp[]>([])

  // parsedPreview가 없으면(부모 미제공) 로컬로 파싱해 preview를 만든다(합성 권위는 Python).
  const localPreview = useMemo<{ plan: ParsedPlan | null; errors: TtsGrammarError[] }>(() => {
    if (parsedPreview !== undefined && parsedPreview !== null) return { plan: parsedPreview, errors: parseErrors ?? [] }
    if (parseErrors && parseErrors.length > 0) return { plan: null, errors: parseErrors }
    const r = parseTtsScript(value)
    return r.ok ? { plan: r.plan, errors: [] } : { plan: null, errors: r.errors }
  }, [value, parsedPreview, parseErrors])

  const plan = localPreview.plan
  const errors = localPreview.errors

  // textarea selection/scroll 복원 유틸. scrollTop을 함께 복원한다 — controlled value 교체 시 브라우저가
  // textarea.scrollTop을 0으로 리셋하므로, 삽입/교체 전 scrollTop을 넘겨받아 rAF에서 되돌린다(긴 대사에서
  // 태그 삽입 시 뷰가 맨 위로 튀는 것 방지). setSelectionRange의 caret-into-view 스크롤을 마지막 scrollTop
  // 대입이 덮어써 '기존 scroll 유지' 계약을 만족시킨다.
  const restore = useCallback((selStart: number, selEnd: number, scrollTop: number, scrollLeft: number) => {
    const ta = taRef.current
    if (!ta) return
    // React onChange 반영 후 selection 지정(다음 프레임).
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      try { el.setSelectionRange(selStart, selEnd) } catch { /* noop */ }
      el.scrollTop = scrollTop        // setSelectionRange의 caret-scroll을 덮어써 기존 scroll 유지
      el.scrollLeft = scrollLeft
      if (overlayRef.current) {
        overlayRef.current.scrollTop = el.scrollTop
        overlayRef.current.scrollLeft = el.scrollLeft
      }
    })
  }, [])

  const applyEmotion = useCallback((emotionId: string) => {
    const ta = taRef.current
    if (!ta || disabled) return
    const s = ta.selectionStart ?? value.length
    const e = ta.selectionEnd ?? s
    const scrollTop = ta.scrollTop, scrollLeft = ta.scrollLeft  // value 교체 전 캡처(교체 후 0으로 리셋됨)
    const res = insertEmotionTag(value, s, e, emotionId)
    onChange(res.text)
    onInsertEmotion(emotionId) // 상위 알림(감정 참조 게이팅 등)
    restore(res.selStart, res.selEnd, scrollTop, scrollLeft)
  }, [value, disabled, onChange, onInsertEmotion, restore])

  const applyPause = useCallback((pauseMs: number) => {
    const ta = taRef.current
    if (!ta || disabled) return
    const s = ta.selectionStart ?? value.length
    const e = ta.selectionEnd ?? s
    const scrollTop = ta.scrollTop, scrollLeft = ta.scrollLeft
    const res = insertPauseTag(value, s, e, pauseMs)
    if (!res.ok) {
      // 조용한 clamp/합산 금지 — 삽입하지 않고 상위 알림만(구조화 오류는 preview/parse에서 표면화).
      onInsertPause(pauseMs)
      return
    }
    onChange(res.text)
    onInsertPause(pauseMs)
    restore(res.selStart, res.selEnd, scrollTop, scrollLeft)
  }, [value, disabled, onChange, onInsertPause, restore])

  const flushQueue = useCallback(() => {
    const ops = queueRef.current
    queueRef.current = []
    for (const op of ops) {
      if (op.kind === 'emotion') applyEmotion(op.id)
      else applyPause(op.ms)
    }
  }, [applyEmotion, applyPause])

  useImperativeHandle(ref, (): EmotionScriptEditorHandle => ({
    insertEmotion: (id: string) => {
      if (composingRef.current) { queueRef.current.push({ kind: 'emotion', id }); return }
      applyEmotion(id)
    },
    insertPause: (ms: number) => {
      if (composingRef.current) { queueRef.current.push({ kind: 'pause', ms }); return }
      applyPause(ms)
    },
    focus: () => { taRef.current?.focus() },
  }), [applyEmotion, applyPause])

  // E2E 전용(window.api._e2e=AF_E2E): 셸에 쉼 삽입 UI 버튼이 아직 없어도 편집 계약(특히 scrollTop 복원)을
  // 감정/쉼 삽입 양쪽에서 실제 Electron으로 검증할 수 있도록 삽입 트리거만 노출한다(production은 노출 안 함).
  // A 편집 로직 변경이 아니라 imperative handle 재노출이다.
  useEffect(() => {
    const w = window as unknown as { api?: { _e2e?: boolean }; __afEditor?: unknown }
    if (!w.api?._e2e) return
    w.__afEditor = {
      insertEmotion: (id: string) => { if (composingRef.current) { queueRef.current.push({ kind: 'emotion', id }); return } applyEmotion(id) },
      insertPause: (ms: number) => { if (composingRef.current) { queueRef.current.push({ kind: 'pause', ms }); return } applyPause(ms) },
    }
    return () => { try { delete w.__afEditor } catch { /* noop */ } }
  }, [applyEmotion, applyPause])

  // ── overlay 색상 세그먼트 빌드(감정 구간 표시. 혼합 아님). ──
  // 원문 value를 세그먼트 offset(ui UTF-16)으로 잘라 배경색을 입힌 span 조각으로 재구성.
  const overlayNodes = useMemo(() => {
    if (!plan) return null
    const nodes: ReactNode[] = []
    let cursor = 0
    let key = 0
    for (const seg of plan.segments) {
      const start = seg.offset.uiStartUtf16
      const end = seg.offset.uiEndUtf16
      if (start > cursor) { nodes.push(<span key={key++}>{value.slice(cursor, start)}</span>); cursor = start }
      const color = seg.emotionId ? (ID_TO_COLOR[seg.emotionId] ?? 'transparent') : 'transparent'
      const bg = seg.emotionId ? hexToRgba(color, 0.18) : 'transparent'
      nodes.push(
        <span key={key++} style={{ backgroundColor: bg, borderRadius: '3px' }}>
          {value.slice(start, Math.max(start, end))}
        </span>,
      )
      cursor = Math.max(cursor, end)
    }
    if (cursor < value.length) nodes.push(<span key={key++}>{value.slice(cursor)}</span>)
    return nodes
  }, [plan, value])

  const hasBlockingError = errors.length > 0
  const usedIds = plan?.summary.usedEmotionIds ?? []

  return (
    <div>
      <div style={wrapStyle}>
        {/* aria-hidden 색상 overlay — 접근성/입력 권위는 textarea. 애니메이션 없음. */}
        <div
          ref={overlayRef}
          aria-hidden="true"
          style={{
            ...sharedBoxStyle,
            position: 'absolute',
            inset: 0,
            color: 'transparent',
            pointerEvents: 'none',
            overflow: 'hidden',
            background: 'transparent',
            borderColor: 'transparent',
          }}
        >
          {overlayNodes}
          {'​'}
        </div>
        <textarea
          ref={taRef}
          value={value}
          disabled={disabled}
          spellCheck={false}
          rows={8}
          onChange={(ev) => onChange(ev.target.value)}
          onScroll={() => {
            const ta = taRef.current
            if (ta && overlayRef.current) {
              overlayRef.current.scrollTop = ta.scrollTop
              overlayRef.current.scrollLeft = ta.scrollLeft
            }
          }}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false; flushQueue() }}
          onPaste={(_ev: ClipboardEvent<HTMLTextAreaElement>) => { /* 기본 붙여넣기 허용(대사 무손실). parse가 unknown/empty를 표면화. */ }}
          style={{
            ...sharedBoxStyle,
            position: 'relative',
            width: '100%',
            minHeight: '180px',
            resize: 'vertical',
            background: 'transparent',
            color: 'var(--text-primary, #e5e7eb)',
            caretColor: 'var(--text-primary, #e5e7eb)',
            outline: 'none',
          }}
        />
      </div>

      {/* 사용 감정 범례 + 준비상태(등록/미등록/미준비). 색은 '구간 표시'용이며 감정 혼합이 아님. */}
      {usedIds.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
          {usedIds.map((id) => {
            const badge = refStates ? refBadge(refStates[id]) : { label: '미리보기', color: 'var(--text-secondary)' }
            return (
              <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: ID_TO_COLOR[id] ?? '#888' }} />
                <span style={{ color: 'var(--text-primary, #e5e7eb)' }}>{EMOTION_ID_TO_LABEL[id] ?? id}</span>
                <span style={{ color: badge.color }}>· {badge.label}</span>
              </span>
            )
          })}
        </div>
      )}

      {/* 오류(합성 차단) 표시 — code/tag/offset만. 대사 전문 미출력. */}
      {hasBlockingError && (
        <div style={{ marginTop: '8px', color: '#f87171', fontSize: '12px' }}>
          {errors.map((er, i) => (
            <div key={i}>
              {tagLabel(er)} — {errorMessage(er)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function tagLabel(er: TtsGrammarError): string {
  if (er.tag) return `[${er.tag}]`
  if (er.arg != null) return `[쉼 ${er.arg}]`
  return '태그'
}

function errorMessage(er: TtsGrammarError): string {
  switch (er.code) {
    case 'UNKNOWN_TTS_TAG': return '알 수 없는 감정/쉼 태그입니다 (오타 확인). 합성이 차단됩니다.'
    case 'INVALID_PAUSE_TAG':
      if (er.reason === 'range') return '쉼 길이는 0.05~5.0초여야 합니다.'
      if (er.reason === 'adjacent_duplicate') return '같은 경계에 쉼 태그가 중복되었습니다.'
      return '쉼 태그 형식이 올바르지 않습니다 (예: [쉼 0.5]).'
    case 'EMPTY_EMOTION_SEGMENT': return '발화 텍스트가 없는 감정 구간입니다.'
    case 'PARSER_PARITY_MISMATCH': return '미리보기와 합성 파서 결과가 달라 합성이 차단되었습니다.'
    case 'INVALID_TTS_CONFIG': return '설정 값이 허용 범위를 벗어났습니다.'
    default: return '문법 오류.'
  }
}

// hex(#rgb/#rrggbb) → rgba(구간 배경 은은하게). CSS 변수(var(--...))는 그대로 두고 alpha만 못 입히므로 fallback.
function hexToRgba(color: string, alpha: number): string {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color)
  if (!m) return color // var(--...) 등은 그대로(alpha 미적용)
  let hex = m[1]
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const EmotionScriptEditor = forwardRef<EmotionScriptEditorHandle, EmotionScriptEditorLocalProps>(EmotionScriptEditorImpl)
EmotionScriptEditor.displayName = 'EmotionScriptEditor'
export default EmotionScriptEditor
