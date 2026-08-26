// 감정 샘플러 패널 (Agent C 소유). 기본 목소리로 감정별 '표준 문구' 샘플을 미리 만들어 들어보는 화면.
//
// ⚠️ '감정 참조 등록'(EmotionReferenceManager)과 다른 기능이다 — 별도 패널로 유지하고 이름을 섞지 않는다.
//    · 감정 참조 등록: 감정마다 별도 참조 클립을 등록(전용 목소리 등록됨 / 등록 필요 / 기본 목소리 사용).
//    · 감정 샘플러(여기): 기본 목소리 하나로 만든 **미리듣기 전용 일회성 샘플**. 참조로 등록되지 않는다.
//    이 사실을 패널 상단에 EMOTION_SAMPLER_DISCLAIMER 로 항상 명시한다(숨김 금지).
//
// 계약:
//   · props-only — store import 없음, 자체 IPC 없음. 생성/미리듣기/삭제는 전부 콜백.
//   · 생성은 **감정 하나씩** — onGenerate(emotionId) 한 개만 받는다. 전체 생성 버튼은 존재하지 않는다.
//   · 상태 표시/버튼 활성 판정은 전부 shared 의 describeEmotionSample() 파생을 그대로 쓴다(표시 로직 분산 금지).
//   · 비활성 버튼은 회색 처리로 끝내지 않고 반드시 사유 문장을 함께 렌더한다.
//   · 표준 문구 '내용'은 렌더하지 않는다(계약 6: 프롬프트 문자열 표시 금지) — 버전 번호만 표시.
//   · 800x600 · 150% 확대(≈533x400 CSS px)에서 가로 넘침 없음 — 고정 폭 금지, flexWrap + 세로 스크롤.
//
// ⚠️ 아직 어디에도 mount 되지 않았다. 셸 배선(스토어/IPC/합성 호출)은 통합 담당의 몫이다.
import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { ALL_EMOTIONS, EMOTION_ID_TO_LABEL } from '@/lib/emotions'
import {
  describeEmotionSample,
  EMOTION_SAMPLER_DISCLAIMER,
  EMOTION_SAMPLER_TITLE,
  EMOTION_SAMPLER_PHRASE_VERSION,
  EMOTION_SAMPLE_STATE_LABEL,
} from '../../shared/emotionSampler'
import type { EmotionSampleEntry, EmotionSampleTone, EmotionSampleView } from '../../shared/emotionSampler'

const ID_TO_COLOR: Record<string, string> = (() => {
  const m: Record<string, string> = {}
  for (const e of ALL_EMOTIONS) m[e.id] = e.color
  return m
})()

const TONE_COLOR: Record<EmotionSampleTone, string> = {
  neutral: 'var(--text-muted)',
  busy: 'var(--text-secondary)',
  ok: 'var(--cyan)',
  warn: 'var(--amber, #f59e0b)',
  error: 'var(--rose)',
}

export interface EmotionSamplerPanelProps {
  /** 사용자가 고른 감정들의 샘플 상태. 전체 감정 목록이 아니다 — 고른 것만 들어온다. */
  rows: readonly EmotionSampleEntry[]
  /** 감정 하나만 생성한다. 목록/배열을 받는 콜백은 의도적으로 없다. */
  onGenerate: (emotionId: string) => void
  onAudition: (emotionId: string) => void
  onDelete: (emotionId: string) => void
  /** 목록에 추가할 수 있는 감정(셸이 공급). 미주입/빈 배열이면 추가 UI 를 숨긴다. */
  addableEmotions?: readonly { id: string; label: string }[]
  /** 감정 하나를 샘플러 목록에 추가. 미주입이면 추가 UI 를 숨긴다. */
  onAddEmotion?: (emotionId: string) => void
  /** 감정 하나를 샘플러 목록에서 제외(샘플 파일 삭제는 onDelete 가 담당). */
  onRemoveEmotion?: (emotionId: string) => void
  /** 기본 참조 목소리 준비 여부. false 면 생성 비활성 + 사유 문장 표시. */
  defaultVoiceReady?: boolean
  /** 패널 전체 비활성(합성 진행 중 등). */
  disabled?: boolean
  /** 표시용 표준 문구 세트 버전. 기본은 shared 상수. */
  phraseVersion?: number
}

const NO_DEFAULT_VOICE_NOTICE = '기본 목소리를 먼저 등록하면 샘플을 만들 수 있습니다.'
const BUSY_NOTICE = '다른 작업이 진행 중이라 지금은 만들 수 없습니다.'

export default function EmotionSamplerPanel({
  rows,
  onGenerate,
  onAudition,
  onDelete,
  addableEmotions,
  onAddEmotion,
  onRemoveEmotion,
  defaultVoiceReady = true,
  disabled = false,
  phraseVersion = EMOTION_SAMPLER_PHRASE_VERSION,
}: EmotionSamplerPanelProps) {
  const views: EmotionSampleView[] = useMemo(() => rows.map(describeEmotionSample), [rows])

  // 상태 요약 — 화면 낭독기용 단일 live region(행마다 live region 을 두지 않는다).
  const summary = useMemo(() => {
    const counts = new Map<string, number>()
    for (const v of views) counts.set(v.state, (counts.get(v.state) ?? 0) + 1)
    const parts: string[] = []
    for (const [state, n] of counts) {
      parts.push(`${EMOTION_SAMPLE_STATE_LABEL[state as EmotionSampleView['state']]} ${n}`)
    }
    return parts.length > 0 ? parts.join(' · ') : '아직 고른 감정이 없습니다'
  }, [views])

  const addables = addableEmotions ?? []
  const canAdd = !!onAddEmotion && addables.length > 0 && !disabled

  return (
    <section
      aria-label={EMOTION_SAMPLER_TITLE}
      style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        maxWidth: '100%', minWidth: 0, boxSizing: 'border-box',
        padding: '10px 12px', borderRadius: 8, background: 'var(--bg-elevated)',
      }}
    >
      {/* 제목 + 문구 버전 */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          {EMOTION_SAMPLER_TITLE}
        </h3>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>표준 문구 v{phraseVersion}</span>
      </div>

      {/* ⚠️ 감정 참조 등록과의 구분을 화면에 못 박는 고정 문장. 접거나 숨기지 않는다. */}
      <p style={{
        fontSize: 11, lineHeight: 1.5, color: 'var(--text-secondary)', margin: 0,
        overflowWrap: 'anywhere',
      }}>
        {EMOTION_SAMPLER_DISCLAIMER}
      </p>

      {/* 낭독기용 상태 요약(단일 live region) */}
      <p role="status" aria-live="polite" style={{ fontSize: 10, color: 'var(--text-muted)', margin: 0 }}>
        {summary}
      </p>

      {!defaultVoiceReady && (
        <p style={{ fontSize: 11, color: 'var(--rose)', margin: 0, overflowWrap: 'anywhere' }}>
          {NO_DEFAULT_VOICE_NOTICE}
        </p>
      )}

      {/* 목록 — 세로 스크롤로 가둔다(가로 넘침 금지). */}
      <ul style={{
        listStyle: 'none', margin: 0, padding: 0,
        display: 'flex', flexDirection: 'column', gap: 6,
        maxHeight: '46vh', overflowY: 'auto', overflowX: 'hidden', minWidth: 0,
      }}>
        {views.length === 0 && (
          <li style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            아직 고른 감정이 없습니다. 아래에서 들어보고 싶은 감정을 하나씩 추가하세요.
          </li>
        )}

        {views.map((v) => {
          const label = EMOTION_ID_TO_LABEL[v.emotionId] ?? v.emotionId
          const color = ID_TO_COLOR[v.emotionId] ?? 'var(--text-secondary)'
          const noticeId = `emotion-sampler-notice-${v.emotionId}`
          // 생성 비활성 사유 — 우선순위: 기본 목소리 없음 > 패널 비활성 > 상태 사유.
          const blockedNotice = !defaultVoiceReady
            ? NO_DEFAULT_VOICE_NOTICE
            : disabled
              ? BUSY_NOTICE
              : v.generateNotice
          const generateDisabled = !v.generateEnabled || !defaultVoiceReady || disabled

          return (
            <li key={v.emotionId} style={{
              borderTop: '1px solid var(--border-subtle)', paddingTop: 6, minWidth: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span aria-hidden="true" style={{
                    width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
                </span>

                {/* 상태 — 미생성 / 생성 중 / 재생 가능 / 재생 가능(음색만 반영) / 생성 한도 초과 / 실패 */}
                <span style={badge(TONE_COLOR[v.tone])}>{v.stateLabel}</span>

                <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
                  <button
                    type="button"
                    onClick={() => onAudition(v.emotionId)}
                    disabled={!v.auditionEnabled || disabled}
                    aria-label={`${label} 샘플 미리듣기`}
                    style={btn('var(--bg-card)', 'var(--text-secondary)', !v.auditionEnabled || disabled)}
                  >▶ 미리듣기</button>

                  <button
                    type="button"
                    onClick={() => onGenerate(v.emotionId)}
                    disabled={generateDisabled}
                    aria-label={`${label} ${v.generateLabel}`}
                    aria-describedby={generateDisabled && blockedNotice ? noticeId : undefined}
                    style={btn(`${color}22`, color, generateDisabled)}
                  >{v.generateLabel}</button>

                  <button
                    type="button"
                    onClick={() => onDelete(v.emotionId)}
                    disabled={!v.deleteEnabled || disabled}
                    aria-label={`${label} 샘플 삭제`}
                    style={btn('var(--bg-card)', 'var(--text-muted)', !v.deleteEnabled || disabled)}
                  >삭제</button>

                  {onRemoveEmotion && (
                    <button
                      type="button"
                      onClick={() => onRemoveEmotion(v.emotionId)}
                      disabled={disabled}
                      aria-label={`${label} 샘플러 목록에서 제외`}
                      style={btn('var(--bg-card)', 'var(--text-muted)', disabled)}
                    >목록에서 빼기</button>
                  )}
                </span>
              </div>

              {/* 실패/강등 사유 — 상태만 두고 사유를 감추지 않는다. */}
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

      {/* 감정 추가 — 한 번에 하나씩. '전체 생성' 같은 일괄 진입점은 두지 않는다. */}
      {onAddEmotion && addables.length > 0 && (
        <div style={{
          borderTop: '1px solid var(--border-subtle)', paddingTop: 8,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0,
        }}>
          <label htmlFor="emotion-sampler-add" style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            감정 추가
          </label>
          <select
            id="emotion-sampler-add"
            defaultValue=""
            disabled={!canAdd}
            onChange={(e) => {
              const id = e.target.value
              e.target.value = ''
              if (id && onAddEmotion) onAddEmotion(id)
            }}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 6, maxWidth: '100%',
              border: '1px solid var(--border-subtle)', background: 'var(--bg-card)',
              color: 'var(--text-secondary)', fontFamily: 'inherit',
            }}
          >
            <option value="">감정 선택…</option>
            {addables.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
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
