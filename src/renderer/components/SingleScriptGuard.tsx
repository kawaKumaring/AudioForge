/**
 * 한 명 화면의 화자 구조 보호 — 안내 한 줄 + `한 명 대본으로 전환`.
 *
 * 한 명과 여러 명은 같은 원문을 본다. 명시 화자가 있는 대본에서 한 명 편집기는 화자 표기의
 * 개수·순서·이름이 그대로인 변경만 받는다(판정은 셸이 `speakerStructurePreserved` 로 한다).
 * 구조를 실제로 없애는 것은 여기의 전환 동작만이고, 결과를 먼저 말한 뒤 사용자가 누를 때만
 * 실행한다. 취소는 아무것도 바꾸지 않는다. 이 컴포넌트는 원문·store·설정을 직접 만지지 않는다.
 */
import { useState, type CSSProperties } from 'react'

export const SINGLE_GUARD_TEXT = {
  notice: (speakerCount: number) =>
    `이 대본에는 인물 ${speakerCount}명의 표기가 있습니다. 인물 표기는 여러 명 화면에서 바꿉니다.`,
  blocked: '인물 표기를 지우거나 바꾸는 편집은 한 명 화면에서 반영하지 않았습니다. 여러 명 화면에서 바꾸거나 아래 전환을 쓰세요.',
  convertOpen: '한 명 대본으로 전환',
  explain: (directiveCount: number) =>
    `인물 구분이 제거되며 모든 대사가 기본 목소리를 사용합니다. 인물 표기 ${directiveCount}개를 대본에서 지웁니다.`,
  keep: '저장된 목소리 구성과 후보 음원은 삭제되지 않습니다. 대사·감정·쉼 표기는 그대로 남습니다.',
  confirm: '전환',
  cancel: '취소',
} as const

export default function SingleScriptGuard(props: {
  directiveCount: number
  speakerCount: number
  blocked: boolean
  onConvert: () => void
  disabled?: boolean
}) {
  const { directiveCount, speakerCount, blocked, onConvert, disabled = false } = props
  const [open, setOpen] = useState(false)
  const btn = (color: string, off: boolean): CSSProperties => ({
    padding: '3px 10px', borderRadius: 5, border: 'none', fontSize: 11, fontWeight: 600, fontFamily: 'inherit',
    cursor: off ? 'not-allowed' : 'pointer', background: 'var(--bg-elevated)', color, opacity: off ? 0.5 : 1,
  })
  return (
    <div data-testid="single-guard" role="note"
      style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)', minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
        <span>{SINGLE_GUARD_TEXT.notice(speakerCount)}</span>
        {!open && (
          <button type="button" data-testid="single-convert-open" disabled={disabled}
            onClick={() => { if (!disabled) setOpen(true) }} style={btn('var(--text-muted)', disabled)}>
            {SINGLE_GUARD_TEXT.convertOpen}
          </button>
        )}
      </div>
      {blocked && (
        <span data-testid="single-guard-blocked" role="status" aria-live="polite" style={{ color: 'var(--rose)' }}>
          {SINGLE_GUARD_TEXT.blocked}
        </span>
      )}
      {open && (
        <div data-testid="single-convert-panel"
          style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', borderRadius: 6,
            border: '1px solid var(--border-subtle)', minWidth: 0 }}>
          <span style={{ color: 'var(--text-primary)' }}>{SINGLE_GUARD_TEXT.explain(directiveCount)}</span>
          <span style={{ color: 'var(--text-muted)' }}>{SINGLE_GUARD_TEXT.keep}</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" data-testid="single-convert-confirm" disabled={disabled}
              onClick={() => { if (disabled) return; setOpen(false); onConvert() }}
              style={btn('var(--rose)', disabled)}>
              {SINGLE_GUARD_TEXT.confirm}
            </button>
            {/* 취소 — 패널만 닫는다. 원문·설정에는 아무 일도 없다. */}
            <button type="button" data-testid="single-convert-cancel"
              onClick={() => setOpen(false)} style={btn('var(--text-secondary)', false)}>
              {SINGLE_GUARD_TEXT.cancel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
