// 참조 목소리 보관함 — 저장해 둔 참조 자산을 등록·선택·삭제하는 섹션.
//
// ⚠️ ReferenceLibraryPanel 과 다른 화면이다. 그쪽은 '원본 하나 안에서 후보 구간을 고르는' UI 이고,
//    여기는 '여러 원본에서 저장해 둔 참조 자산을 관리하는' UI 다. 서로 섞지 않는다.
//
// 계약:
//   · props-only — store import 없음, 자체 IPC 없음. 등록/선택/삭제는 전부 콜백.
//   · 표시 판단(순서·표시명·상태 문구·버튼 활성)은 전부 .logic.ts 파생을 그대로 쓴다.
//   · 절대 경로·원본 파일명을 렌더하지 않는다. 이름은 앱이 붙인 번호다.
//   · 기본 접힘. 자체 토글만 쓰고 상위가 또 감싸지 않는다(이중 접기 금지).
//   · 고정 폭 금지 + flexWrap + 세로 스크롤 — 좁은 뷰포트·고배율에서 가로 넘침이 없어야 한다.
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ReferenceLibraryItem, ReferenceLibraryStatus } from '../../shared/referenceLibraryApi'
import {
  buildReferenceAssetView, decideImportAvailability, summarizeReferenceAssets,
  REFERENCE_ASSET_SECTION_TITLE, REFERENCE_ASSET_TEXT,
  type ReferenceAssetTone,
} from './ReferenceAssetLibraryPanel.logic'

const TONE_COLOR: Record<ReferenceAssetTone, string> = {
  neutral: 'var(--text-muted)',
  ok: 'var(--cyan)',
  warn: 'var(--amber, #f59e0b)',
  error: 'var(--rose)',
}

export interface ReferenceAssetLibraryPanelProps {
  status: ReferenceLibraryStatus
  items: readonly ReferenceLibraryItem[]
  /** ReferenceRegionPanel 에서 구간이 확정됐는가(등록 가능 조건). */
  hasConfirmedRegion?: boolean
  /** 합성·분석 등이 진행 중. */
  busy?: boolean
  /** 등록 요청 진행 중. */
  importing?: boolean
  /** 패널 전체 비활성. */
  disabled?: boolean
  /** 마지막 작업의 사용자 안내(오류 문구 등). 경로가 없는 문장만 들어온다. */
  notice?: string | null
  onImport: () => void
  onSelect: (referenceId: string) => void
  onRemove: (referenceId: string) => void
  /** 펼칠 때 목록을 새로 읽는다. */
  onRefresh?: () => void
}

const BODY_ID = 'reference-asset-library-body'

export default function ReferenceAssetLibraryPanel({
  status,
  items,
  hasConfirmedRegion = false,
  busy = false,
  importing = false,
  disabled = false,
  notice = null,
  onImport,
  onSelect,
  onRemove,
  onRefresh,
}: ReferenceAssetLibraryPanelProps) {
  const [open, setOpen] = useState(false)

  const view = useMemo(() => buildReferenceAssetView(status, items), [status, items])
  const summary = useMemo(() => summarizeReferenceAssets(view), [view])
  const importDecision = useMemo(
    () => decideImportAvailability({ hasConfirmedRegion, busy: busy || disabled, status, importing }),
    [hasConfirmedRegion, busy, disabled, status, importing]
  )

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && onRefresh) onRefresh()   // 펼칠 때만 읽는다(닫힌 채로 폴링하지 않는다)
  }

  return (
    <section
      aria-label={REFERENCE_ASSET_SECTION_TITLE}
      style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
        padding: '8px 12px', borderRadius: 8, background: 'var(--bg-elevated)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', minWidth: 0 }}>
          {REFERENCE_ASSET_SECTION_TITLE}
        </span>
        <span
          role="status"
          aria-live="polite"
          style={{
            fontSize: 11, minWidth: 0,
            color: view.showCorruptNotice ? 'var(--rose)' : 'var(--text-muted)',
          }}
        >{summary}</span>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={BODY_ID}
          aria-label={open ? `${REFERENCE_ASSET_SECTION_TITLE} 접기` : `${REFERENCE_ASSET_SECTION_TITLE} 펼치기`}
          style={{ ...btn('var(--bg-card)', 'var(--text-secondary)'), marginLeft: 'auto' }}
        >{open ? '닫기' : '열기'}</button>
      </div>

      {open && (
        <div id={BODY_ID} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          {view.showCorruptNotice && (
            <p style={{ fontSize: 11, color: 'var(--rose)', margin: 0, overflowWrap: 'anywhere' }}>
              {REFERENCE_ASSET_TEXT.corrupt}
            </p>
          )}

          {!view.showCorruptNotice && view.isEmpty && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
              {REFERENCE_ASSET_TEXT.empty}
            </p>
          )}

          {view.rows.length > 0 && (
            <ul style={{
              listStyle: 'none', margin: 0, padding: 0, maxHeight: '40vh',
              overflowY: 'auto', overflowX: 'hidden',
              display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
            }}>
              {view.rows.map((row) => (
                <li key={row.referenceId} style={{
                  borderTop: '1px solid var(--border-subtle)', paddingTop: 6, minWidth: 0,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                    <span aria-hidden="true" style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: TONE_COLOR[row.tone], flexShrink: 0,
                    }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {row.displayName}
                    </span>
                    {row.statusLabel && (
                      <span style={badge(TONE_COLOR[row.tone])}>{row.statusLabel}</span>
                    )}

                    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
                      <button
                        type="button"
                        onClick={() => onSelect(row.referenceId)}
                        disabled={!row.selectable || row.selected || disabled}
                        aria-label={`${row.displayName} 사용하기`}
                        style={btn('var(--bg-card)', 'var(--cyan)', !row.selectable || row.selected || disabled)}
                      >{row.selected ? '사용 중' : '사용하기'}</button>

                      <button
                        type="button"
                        onClick={() => onRemove(row.referenceId)}
                        disabled={!row.removable || disabled}
                        aria-label={`${row.displayName} 삭제`}
                        aria-describedby={row.removeBlockedNotice ? `${BODY_ID}-notice-${row.referenceId}` : undefined}
                        style={btn('var(--bg-card)', 'var(--text-muted)', !row.removable || disabled)}
                      >삭제</button>
                    </span>
                  </div>

                  {row.removeBlockedNotice && (
                    <p
                      id={`${BODY_ID}-notice-${row.referenceId}`}
                      style={{ fontSize: 10, color: 'var(--text-muted)', margin: '4px 0 0', overflowWrap: 'anywhere' }}
                    >{row.removeBlockedNotice}</p>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div style={{
            borderTop: '1px solid var(--border-subtle)', paddingTop: 8,
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0,
          }}>
            <button
              type="button"
              onClick={onImport}
              disabled={!importDecision.enabled}
              aria-label={REFERENCE_ASSET_TEXT.importButton}
              style={btn('var(--bg-card)', 'var(--cyan)', !importDecision.enabled)}
            >{importing ? '저장 중…' : REFERENCE_ASSET_TEXT.importButton}</button>
            {importDecision.notice && (
              <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 0, overflowWrap: 'anywhere' }}>
                {importDecision.notice}
              </span>
            )}
          </div>

          {notice && (
            <p style={{ fontSize: 11, color: 'var(--rose)', margin: 0, overflowWrap: 'anywhere' }}>{notice}</p>
          )}
        </div>
      )}
    </section>
  )
}

function badge(color: string): CSSProperties {
  return {
    fontSize: 10, fontWeight: 600, color, padding: '2px 8px', borderRadius: 5,
    background: 'var(--bg-card)', whiteSpace: 'nowrap',
  }
}

function btn(bg: string, color: string, isDisabled = false): CSSProperties {
  return {
    fontSize: 10, fontWeight: 600, padding: '4px 10px', borderRadius: 5, border: 'none',
    cursor: isDisabled ? 'not-allowed' : 'pointer', background: bg, color, fontFamily: 'inherit',
    opacity: isDisabled ? 0.45 : 1, whiteSpace: 'nowrap',
  }
}
