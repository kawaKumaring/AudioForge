// 감정 참조 관리자 (C 소유). '목소리' 흐름 안에서 감정 음성 요약 배지 + [관리] 패널을 담당한다.
// 관리 패널 열: 감정명 / 등록 상태 / 참조 길이 / 미리듣기 / 변경 / 삭제.
// ⚠️ 파일 I/O(파일 선택 다이얼로그)는 이 컴포넌트가 하지 않는다 — 셸(I5)이 requestSource로 주입한다.
//    구간 확정(파형)은 ReferenceRegionPanel(비소유)이 담당 — renderRegionEditor로 주입받는다.
// ⚠️ TTSEditor 셸 배선은 I5. 이 파일은 셸에 스스로 연결하지 않는다.
// props 계약: src/renderer/types/ttsExpression.ts EmotionReferenceManagerProps.
import { useMemo, useState } from 'react'
import type { ReactNode, CSSProperties } from 'react'
import { ALL_EMOTIONS, EMOTION_ID_TO_LABEL } from '@/lib/emotions'
import type { TtsEmotionRegion } from '../../shared/ttsConfig'
import type { EmotionReferenceManagerProps } from '../types/ttsExpression'

const ID_TO_COLOR: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const e of ALL_EMOTIONS) m[e.id] = e.color
  return m
})()

// 계약을 수정하지 않고 셸 주입 슬롯을 로컬 확장(A의 로컬 확장 선례와 동일).
export interface EmotionReferenceManagerLocalProps extends EmotionReferenceManagerProps {
  /** 셸이 파일 선택 다이얼로그를 열어 원본 경로를 돌려준다. 미주입 시 등록/변경 버튼 비활성(미배선). */
  requestSource?: (emotionId: string) => Promise<string | null> | string | null
  /** 셸이 감정별 구간 편집기(ReferenceRegionPanel)를 주입. onChangeRegion을 내부에서 호출한다. */
  renderRegionEditor?: (emotionId: string, onChangeRegion: (r: TtsEmotionRegion) => void) => ReactNode
  /** 대사에 실제 쓰인 감정 id(첫 등장 순). 목록 상단 우선 표시에만 쓴다. */
  usedEmotionIds?: string[]
  disabled?: boolean
}

// 한 감정이 가질 수 있는 상태는 셋뿐이다(토글 아님 — 등록 여부와 구간 확정 여부에서 파생).
type RefStatus = 'registered' | 'needs-setup' | 'default-voice'
const STATUS_LABEL: Record<RefStatus, string> = {
  registered: '전용 목소리 등록됨',
  'needs-setup': '등록 필요',
  'default-voice': '기본 목소리 사용',
}
const STATUS_COLOR: Record<RefStatus, string> = {
  registered: 'var(--cyan)',
  'needs-setup': 'var(--rose)',
  'default-voice': 'var(--text-muted)',
}
function statusOf(r: { registered: boolean; ready: boolean }): RefStatus {
  if (!r.registered) return 'default-voice'
  return r.ready ? 'registered' : 'needs-setup'
}

// 길이는 값이 있을 때만 문자열을 만든다(없으면 ''). 셸이 실제 길이를 아직 공급하지 않는 경우
// "길이 -"를 상시 노출하는 대신 그 자리를 비운다(빈 값 표시 금지).
function fmtDur(sec?: number): string {
  return typeof sec === 'number' && Number.isFinite(sec) ? `${sec.toFixed(1)}초` : ''
}
function fmtRegion(r?: TtsEmotionRegion): string | null {
  if (!r || typeof r.start !== 'number' || typeof r.duration !== 'number') return null
  return `${r.start.toFixed(1)}~${(r.start + r.duration).toFixed(1)}초`
}

export default function EmotionReferenceManager({
  refs,
  onRegister,
  onRemove,
  onPreview,
  onChangeRegion,
  requestSource,
  renderRegionEditor,
  usedEmotionIds,
  disabled = false,
}: EmotionReferenceManagerLocalProps) {
  const [open, setOpen] = useState(false)
  const [expandedRow, setExpandedRow] = useState<string | null>(null)
  const [addId, setAddId] = useState<string>('')

  const registered = useMemo(() => refs.filter(r => r.registered), [refs])
  const readyCount = registered.filter(r => r.ready).length
  const needsConfirm = registered.length - readyCount

  // 한 목록으로 보여줄 행: 대사에 쓰인 감정(첫 등장 순) 먼저, 그 뒤 쓰이지 않았지만 등록된 감정.
  // 쓰인 감정이 미등록이면 '기본 목소리 사용' 행으로 같은 목록에 남는다(별도 안내 문단 대신).
  const rows = useMemo(() => {
    const byId = new Map(refs.map(r => [r.emotionId, r]))
    const used = (usedEmotionIds ?? []).filter(id => id !== 'default')
    const usedSet = new Set(used)
    const usedRows = used.map(id => byId.get(id) ?? { emotionId: id, registered: false, ready: false })
    const otherRegistered = registered.filter(r => !usedSet.has(r.emotionId))
    return [...usedRows, ...otherRegistered]
  }, [refs, registered, usedEmotionIds])

  // 추가 가능한 감정 = 아직 등록되지 않은 것(default 제외).
  const addable = useMemo(() => {
    const regIds = new Set(registered.map(r => r.emotionId))
    return ALL_EMOTIONS.filter(e => e.id !== 'default' && !regIds.has(e.id))
  }, [registered])

  const canPick = !!requestSource && !disabled

  const pickAndRegister = async (emotionId: string) => {
    if (!requestSource) return
    const src = await requestSource(emotionId)
    if (src) onRegister(emotionId, src)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* 요약 배지 + [관리] */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        padding: '8px 12px', borderRadius: 8, background: 'var(--bg-elevated)',
      }}>
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {registered.length > 0 ? <>감정 음성 <strong style={{ color: 'var(--text-primary)' }}>{registered.length}개</strong> 등록됨</> : '감정 음성 없음'}
        </span>
        {readyCount > 0 && <span style={badge('var(--cyan)')}>준비 {readyCount}</span>}
        {needsConfirm > 0 && <span style={badge('var(--rose)')}>확정 필요 {needsConfirm}</span>}
        {registered.length === 0 && (
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>대사의 [감정] 태그는 기본 참조로 합성됩니다</span>
        )}
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          aria-controls="tts-emotion-manage-panel"
          style={{ ...btn('var(--bg-card)', 'var(--text-secondary)'), marginLeft: 'auto' }}
        >
          {open ? '닫기' : registered.length > 0 ? '관리' : '감정 음성 추가'}
        </button>
      </div>

      {/* 관리 패널 */}
      {open && (
        <div
          id="tts-emotion-manage-panel"
          role="group"
          aria-label="감정 참조 관리"
          style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 4px' }}
        >
          {rows.length === 0 && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)' }}>아직 등록된 감정 음성이 없습니다. 아래에서 감정을 추가하세요.</p>
          )}

          {rows.map((r) => {
            const label = EMOTION_ID_TO_LABEL[r.emotionId] ?? r.emotionId
            const color = ID_TO_COLOR[r.emotionId] ?? 'var(--text-secondary)'
            const rowOpen = expandedRow === r.emotionId
            const regionText = fmtRegion(r.region)
            const status = statusOf(r)
            const durText = fmtDur(r.durationSec)
            return (
              <div key={r.emotionId} style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 6 }}>
                <div className="tts-expr-row" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {/* 감정명 */}
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 72 }}>
                    <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
                  </span>
                  {/* 상태 — 셋 중 하나만(색 + 텍스트 병기). 토글이 아니라 파생 상태다. */}
                  <span style={badge(STATUS_COLOR[status])}>{STATUS_LABEL[status]}</span>
                  {/* 보조 정보 — 값이 있을 때만(빈 "길이 -"를 상시 노출하지 않는다) */}
                  {(durText || regionText) && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {[durText ? `길이 ${durText}` : null, regionText ? `구간 ${regionText}` : null].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {/* 미등록(기본 목소리 사용) → 등록 하나만. 등록됨 → 미리듣기/구간/변경/삭제 보존. */}
                  {!r.registered ? (
                    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
                      <button type="button" onClick={() => pickAndRegister(r.emotionId)} disabled={!canPick}
                        title={canPick ? '' : '파일 선택은 셸 배선(I5) 후 동작합니다'}
                        aria-label={`${label} 전용 목소리 등록`} style={btn(`${color}22`, color, !canPick)}>전용 목소리 등록</button>
                    </span>
                  ) : (
                  <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
                    <button type="button" onClick={() => onPreview(r.emotionId)} disabled={disabled}
                      aria-label={`${label} 참조 미리듣기`} style={btn('var(--bg-elevated)', 'var(--text-secondary)')}>▶ 미리듣기</button>
                    {renderRegionEditor && (
                      <button type="button" onClick={() => setExpandedRow(rowOpen ? null : r.emotionId)} disabled={disabled}
                        aria-expanded={rowOpen} aria-label={`${label} 참조 구간 조정`} style={btn('var(--bg-elevated)', 'var(--text-secondary)')}>구간</button>
                    )}
                    <button type="button" onClick={() => pickAndRegister(r.emotionId)} disabled={!canPick}
                      title={canPick ? '' : '파일 선택은 셸 배선(I5) 후 동작합니다'}
                      aria-label={`${label} 참조 파일 변경`} style={btn(`${color}22`, color, !canPick)}>변경</button>
                    <button type="button" onClick={() => onRemove(r.emotionId)} disabled={disabled}
                      aria-label={`${label} 참조 삭제`} style={btn('var(--bg-elevated)', 'var(--text-muted)')}>삭제</button>
                  </span>
                  )}
                </div>
                {/* 셸 주입 구간 편집기(onChangeRegion 소비). */}
                {rowOpen && renderRegionEditor && (
                  <div style={{ marginTop: 6 }}>
                    {renderRegionEditor(r.emotionId, (region) => onChangeRegion(r.emotionId, region))}
                  </div>
                )}
              </div>
            )
          })}

          {/* 감정 추가 */}
          {addable.length > 0 && (
            <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label htmlFor="tts-emotion-add-select" style={{ fontSize: 11, color: 'var(--text-muted)' }}>감정 추가</label>
              <select
                id="tts-emotion-add-select"
                value={addId}
                onChange={(e) => setAddId(e.target.value)}
                disabled={disabled}
                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontFamily: 'inherit' }}
              >
                <option value="">감정 선택…</option>
                {addable.map(e => <option key={e.id} value={e.id}>{e.label}</option>)}
              </select>
              <button
                type="button"
                onClick={() => { if (addId) { void pickAndRegister(addId); setAddId('') } }}
                disabled={!canPick || !addId}
                title={canPick ? '' : '파일 선택은 셸 배선(I5) 후 동작합니다'}
                style={btn('var(--bg-elevated)', 'var(--text-secondary)', !canPick || !addId)}
              >등록</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function badge(color: string): CSSProperties {
  return { fontSize: 10, fontWeight: 600, color, padding: '2px 8px', borderRadius: 5, background: 'var(--bg-elevated)', whiteSpace: 'nowrap' }
}
function btn(bg: string, color: string, isDisabled = false): CSSProperties {
  return {
    fontSize: 10, fontWeight: 600, padding: '4px 10px', borderRadius: 5, border: 'none',
    cursor: isDisabled ? 'not-allowed' : 'pointer', background: bg, color, fontFamily: 'inherit',
    opacity: isDisabled ? 0.45 : 1, whiteSpace: 'nowrap',
  }
}
