// 감정·표현 미리듣기 패널 (Agent C 소유). 기본 목소리로 표현별 표준 샘플을 미리 만들어 들어보는 화면.
//
// ⚠️ '감정 참조 등록'(EmotionReferenceManager)과 다른 기능이다 — 별도 섹션으로 유지하고 이름을 섞지 않는다.
//    · 감정 참조 등록: 감정마다 별도 참조 클립을 등록(전용 목소리 등록됨 / 등록 필요 / 기본 목소리 사용).
//    · 감정·표현 미리듣기(여기): 기본 목소리 하나로 만든 **미리듣기 전용 일회성 샘플**. 참조로 등록되지 않는다.
//
// 점진적 공개(progressive disclosure) — UI 가 더 복잡해 보이지 않게:
//    · 기본은 **접힘**. 접혀 있을 때는 제목 + 수치 요약 한 줄'만' 보인다(만들어짐/만드는 중/확인 필요).
//    · 펼쳐야 비로소 안내 문장과 표현별 목록이 나온다. 목록은 갈래(감정/구두점/웃음)로 묶는다.
//
// 계약:
//    · props-only — store import 없음, 자체 IPC 없음. 생성/미리듣기/삭제는 전부 콜백.
//    · 생성은 **표현 하나씩** — onGenerate(rowId) 한 개만 받는다. 전체 생성 버튼은 존재하지 않는다.
//    · 상태 표시/버튼 활성 판정은 전부 shared 의 describeEmotionSample() 파생을 그대로 쓴다.
//    · 엔진이 못 하는(unsupported)·확인 안 된(unverified) 표현은 '미생성'이 아니라 각자의 이름 있는
//      상태로 보이고, 생성 버튼이 비활성인 이유를 문장으로 함께 렌더한다(가짜 '가능' 표시 금지).
//    · 표준 문구/대본 '내용'은 렌더하지 않는다(계약 6) — 버전 번호만 표시.
//    · 고정 폭 금지 + flexWrap + 세로 스크롤 — 좁은 뷰포트(고배율 확대)에서 가로 넘침이 없어야 한다.
//
// ⚠️ 아직 어디에도 mount 되지 않았다. 셸 배선(스토어/IPC/합성 호출/마운트 위치)은 통합 담당의 몫이다.
import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  describeEmotionSample,
  summarizeEmotionSamples,
  emotionSampleRow,
  EMOTION_SAMPLE_ROWS,
  EMOTION_SAMPLE_FAMILIES,
  EMOTION_SAMPLER_DISCLAIMER,
  EMOTION_SAMPLER_SECTION_TITLE,
  EMOTION_SAMPLER_PHRASE_VERSION,
} from '../../shared/emotionSampler'
import type {
  EmotionSampleEntry, EmotionSampleFamily, EmotionSampleTone, EmotionSampleView,
} from '../../shared/emotionSampler'

const TONE_COLOR: Record<EmotionSampleTone, string> = {
  neutral: 'var(--text-muted)',
  busy: 'var(--text-secondary)',
  ok: 'var(--cyan)',
  warn: 'var(--amber, #f59e0b)',
  error: 'var(--rose)',
}

const FAMILY_LABEL: Record<EmotionSampleFamily, string> = {
  emotion: '감정',
  emotionTransition: '감정 전환',
  punctuation: '구두점',
  laugh: '웃음',
}

export interface EmotionSamplerPanelProps {
  /** 사용자가 고른 표현들의 샘플 상태. 전체 카탈로그가 아니다 — 고른 것만 들어온다. */
  rows: readonly EmotionSampleEntry[]
  /** 표현 하나만 생성한다. 목록/배열을 받는 콜백은 의도적으로 없다. */
  onGenerate: (rowId: string) => void
  onAudition: (rowId: string) => void
  onDelete: (rowId: string) => void
  /** 카탈로그에서 아직 안 고른 표현 하나를 목록에 추가. 미주입이면 추가 UI 를 숨긴다. */
  onAddRow?: (rowId: string) => void
  /** 표현 하나를 목록에서 제외(샘플 파일 삭제는 onDelete 가 담당). */
  onRemoveRow?: (rowId: string) => void
  /** 기본 참조 목소리 준비 여부. false 면 생성 비활성 + 사유 문장 표시. */
  defaultVoiceReady?: boolean
  /** 패널 전체 비활성(합성 진행 중 등). */
  disabled?: boolean
  /** 표시용 표준 문구/이벤트 세트 버전. 기본은 shared 상수. */
  phraseVersion?: number
}

const NO_DEFAULT_VOICE_NOTICE = '기본 목소리를 먼저 등록하면 샘플을 만들 수 있습니다.'
const BUSY_NOTICE = '다른 작업이 진행 중이라 지금은 만들 수 없습니다.'
const BODY_ID = 'emotion-sampler-body'

export default function EmotionSamplerPanel({
  rows,
  onGenerate,
  onAudition,
  onDelete,
  onAddRow,
  onRemoveRow,
  defaultVoiceReady = true,
  disabled = false,
  phraseVersion = EMOTION_SAMPLER_PHRASE_VERSION,
}: EmotionSamplerPanelProps) {
  // 점진적 공개: 기본 접힘. 사용자가 열기 전에는 목록도 안내 문장도 만들지 않는다.
  const [open, setOpen] = useState(false)

  const views: EmotionSampleView[] = useMemo(() => rows.map(describeEmotionSample), [rows])
  const summary = useMemo(() => summarizeEmotionSamples(rows), [rows])

  // 갈래별로 묶어 보여준다(16행이 한 덩어리로 쏟아지지 않게).
  const grouped = useMemo(() => {
    const byFamily = new Map<EmotionSampleFamily, EmotionSampleView[]>()
    for (const v of views) {
      const fam = emotionSampleRow(v.rowId).family
      const list = byFamily.get(fam)
      if (list) list.push(v)
      else byFamily.set(fam, [v])
    }
    return EMOTION_SAMPLE_FAMILIES
      .map((fam) => ({ fam, items: byFamily.get(fam) ?? [] }))
      .filter((g) => g.items.length > 0)
  }, [views])

  const chosen = useMemo(() => new Set(rows.map((r) => r.rowId)), [rows])
  const addables = useMemo(
    () => EMOTION_SAMPLE_ROWS.filter((r) => !chosen.has(r.rowId)),
    [chosen]
  )
  const canAdd = !!onAddRow && addables.length > 0 && !disabled

  return (
    <section
      aria-label={EMOTION_SAMPLER_SECTION_TITLE}
      style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
        padding: '8px 12px', borderRadius: 8, background: 'var(--bg-elevated)',
      }}
    >
      {/* 헤더 — 접힘/펼침 토글. 접혀 있을 때 보이는 것은 이 줄이 전부다. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', minWidth: 0 }}>
          {EMOTION_SAMPLER_SECTION_TITLE}
        </span>
        {/* 수치 요약 — 만들어짐 / 만드는 중 / 확인 필요. 0인 항목은 아예 나오지 않는다. */}
        <span
          role="status"
          aria-live="polite"
          style={{ fontSize: 11, color: summary.attention > 0 ? 'var(--rose)' : 'var(--text-muted)', minWidth: 0 }}
        >
          {summary.text}
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={BODY_ID}
          aria-label={open ? `${EMOTION_SAMPLER_SECTION_TITLE} 접기` : `${EMOTION_SAMPLER_SECTION_TITLE} 펼치기`}
          style={{ ...btn('var(--bg-card)', 'var(--text-secondary)'), marginLeft: 'auto' }}
        >{open ? '닫기' : '열기'}</button>
      </div>

      {/* 본문 — 펼쳤을 때만. */}
      {open && (
        <div id={BODY_ID} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>표준 문구 v{phraseVersion}</span>
          </div>

          {/* ⚠️ 감정 참조 등록과의 구분을 못 박는 고정 문장. 본문 안에서는 숨기지 않는다. */}
          <p style={{
            fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)', margin: 0,
            overflowWrap: 'anywhere',
          }}>
            {EMOTION_SAMPLER_DISCLAIMER}
          </p>

          {!defaultVoiceReady && (
            <p style={{ fontSize: 11, color: 'var(--rose)', margin: 0, overflowWrap: 'anywhere' }}>
              {NO_DEFAULT_VOICE_NOTICE}
            </p>
          )}

          {/* 목록 — 세로 스크롤로 가둔다(가로 넘침 금지). */}
          <div style={{ maxHeight: '46vh', overflowY: 'auto', overflowX: 'hidden', minWidth: 0 }}>
            {views.length === 0 && (
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, overflowWrap: 'anywhere' }}>
                아직 고른 표현이 없습니다. 아래에서 들어보고 싶은 표현을 하나씩 추가하세요.
              </p>
            )}

            {grouped.map((g) => (
              <div key={g.fam} style={{ minWidth: 0 }}>
                <h4 style={{
                  fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', margin: '8px 0 2px',
                  letterSpacing: '0.03em',
                }}>{FAMILY_LABEL[g.fam]}</h4>
                <ul style={{
                  listStyle: 'none', margin: 0, padding: 0,
                  display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0,
                }}>
                  {g.items.map((v) => {
                    const label = emotionSampleRow(v.rowId).label
                    const noticeId = `emotion-sampler-notice-${v.rowId}`
                    // 생성 비활성 사유 — 우선순위: 상태(못함/미확인) > 기본 목소리 없음 > 패널 비활성 > 그 밖의 상태 사유.
                    const capBlocked = v.state === 'unsupported' || v.state === 'unverified'
                    const blockedNotice = capBlocked
                      ? v.generateNotice
                      : !defaultVoiceReady
                        ? NO_DEFAULT_VOICE_NOTICE
                        : disabled
                          ? BUSY_NOTICE
                          : v.generateNotice
                    const generateDisabled = !v.generateEnabled || !defaultVoiceReady || disabled

                    return (
                      <li key={v.rowId} style={{
                        borderTop: '1px solid var(--border-subtle)', paddingTop: 6, minWidth: 0,
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span aria-hidden="true" style={{
                              width: 8, height: 8, borderRadius: '50%',
                              background: TONE_COLOR[v.tone], flexShrink: 0,
                            }} />
                            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
                          </span>

                          {/* 상태 — 미생성/생성 중/재생 가능/재생 가능(음색만 반영)/생성 한도 초과/실패/지원 안 됨/미검증 */}
                          <span style={badge(TONE_COLOR[v.tone])}>{v.stateLabel}</span>

                          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
                            <button
                              type="button"
                              onClick={() => onAudition(v.rowId)}
                              disabled={!v.auditionEnabled || disabled}
                              aria-label={`${label} 샘플 미리듣기`}
                              style={btn('var(--bg-card)', 'var(--text-secondary)', !v.auditionEnabled || disabled)}
                            >▶ 미리듣기</button>

                            <button
                              type="button"
                              onClick={() => onGenerate(v.rowId)}
                              disabled={generateDisabled}
                              aria-label={`${label} ${v.generateLabel}`}
                              aria-describedby={generateDisabled && blockedNotice ? noticeId : undefined}
                              style={btn('var(--bg-card)', TONE_COLOR[v.tone], generateDisabled)}
                            >{v.generateLabel}</button>

                            <button
                              type="button"
                              onClick={() => onDelete(v.rowId)}
                              disabled={!v.deleteEnabled || disabled}
                              aria-label={`${label} 샘플 삭제`}
                              style={btn('var(--bg-card)', 'var(--text-muted)', !v.deleteEnabled || disabled)}
                            >삭제</button>

                            {onRemoveRow && (
                              <button
                                type="button"
                                onClick={() => onRemoveRow(v.rowId)}
                                disabled={disabled}
                                aria-label={`${label} 목록에서 제외`}
                                style={btn('var(--bg-card)', 'var(--text-muted)', disabled)}
                              >목록에서 빼기</button>
                            )}
                          </span>
                        </div>

                        {/* 실패/강등/불가 사유 — 상태만 두고 사유를 감추지 않는다. */}
                        {v.reasonLabel && (
                          <p style={{
                            fontSize: 11, color: TONE_COLOR[v.tone], margin: '4px 0 0',
                            overflowWrap: 'anywhere',
                          }}>{v.reasonLabel}</p>
                        )}

                        {/* 생성 버튼 비활성 사유 — 회색 처리로 끝내지 않고 문장으로 설명한다. */}
                        {generateDisabled && blockedNotice && (
                          <p id={noticeId} style={{
                            fontSize: 10, color: 'var(--text-muted)', margin: '4px 0 0',
                            overflowWrap: 'anywhere',
                          }}>{blockedNotice}</p>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>

          {/* 표현 추가 — 한 번에 하나씩. '전체 생성' 같은 일괄 진입점은 두지 않는다. */}
          {onAddRow && addables.length > 0 && (
            <div style={{
              borderTop: '1px solid var(--border-subtle)', paddingTop: 8,
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0,
            }}>
              <label htmlFor="emotion-sampler-add" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                표현 추가
              </label>
              <select
                id="emotion-sampler-add"
                defaultValue=""
                disabled={!canAdd}
                onChange={(e) => {
                  const id = e.target.value
                  e.target.value = ''
                  if (id && onAddRow) onAddRow(id)
                }}
                style={{
                  fontSize: 11, padding: '3px 8px', borderRadius: 6, maxWidth: '100%', minWidth: 0,
                  border: '1px solid var(--border-subtle)', background: 'var(--bg-card)',
                  color: 'var(--text-secondary)', fontFamily: 'inherit',
                }}
              >
                <option value="">표현 선택…</option>
                {addables.map((r) => (
                  <option key={r.rowId} value={r.rowId}>{FAMILY_LABEL[r.family]} · {r.label}</option>
                ))}
              </select>
            </div>
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
