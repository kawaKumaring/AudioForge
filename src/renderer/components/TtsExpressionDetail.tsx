// 세부 표현 블록 (통합 소유, I5-c). ExpressionControls(C) 기본 영역 아래에 별도로 두는 통합 담당 컴포넌트.
// C의 ExpressionControls.tsx는 수정하지 않는다. 말끝 finishing(tail) + 감정 전환 경계를 다룬다.
// 규칙(계약):
//  - "세부 값 직접 조절"(fineTune) = 세부 슬라이더 편집 가능 여부일 뿐, 기능 on/off가 아니다.
//    실제 말끝 on/off 권위 = tailMode(off|auto), 실제 감정 전환 권위 = emotionMode(immediate|pause).
//    별도 advancedEnabled backend/config/session 필드를 만들지 않는다.
//  - fineTune이 꺼져 있어도 현재 기본값(auto/pause + 120/8/200)이 적용 중임을 명시.
//  - 범위·기본값은 단일 권위(ttsExpressionCapabilities)만 사용. range input이 store invalid 값을 브라우저로 조용히
//    clamp하지 못하게, 범위 밖 값은 슬라이더 대신 오류 상태로 표시(합성은 상위 gate/백엔드 INVALID_TTS_CONFIG가 차단).
//  - smooth/formant/가성/빠른 재처리/가창 미노출. preset은 이 값들을 바꾸지 않는다(상위 onPreset이 tail/감정 미변경).
import { useState } from 'react'
import type { CSSProperties } from 'react'
import {
  TTS_TAIL_PADDING_MS, TTS_TAIL_FADE_MS, TTS_EMOTION_PAUSE_MS,
  inRange, type TtsExpressionCapability, type TtsTailMode, type TtsEmotionMode,
} from '../../shared/ttsExpressionCapabilities'

export interface TtsExpressionDetailPatch {
  ttsTailMode?: TtsTailMode
  ttsTailPaddingMs?: number
  ttsTailFadeMs?: number
  ttsEmotionBoundaryMode?: TtsEmotionMode
  ttsEmotionBoundaryPauseMs?: number
}
export interface TtsExpressionDetailProps {
  capability: TtsExpressionCapability
  tailMode: TtsTailMode
  tailPaddingMs: number
  tailFadeMs: number
  emotionMode: TtsEmotionMode
  emotionPauseMs: number
  fineTune: boolean
  showSettingHelp?: boolean
  disabled?: boolean
  onChange: (patch: TtsExpressionDetailPatch) => void
  onToggleFineTune: (v: boolean) => void
}

const card: CSSProperties = { borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }

export default function TtsExpressionDetail(props: TtsExpressionDetailProps) {
  const { capability, tailMode, tailPaddingMs, tailFadeMs, emotionMode, emotionPauseMs, fineTune, showSettingHelp = false, disabled = false, onChange, onToggleFineTune } = props
  const [expanded, setExpanded] = useState(false)
  const [openHelp, setOpenHelp] = useState(false)

  const capOn = capability.tail && capability.emotionBoundary
  // 현재 적용값 요약(접힘 상태에서도 항상 노출) — 라벨·값을 계약 순서로.
  const summary = capOn
    ? `말끝 ${tailMode === 'auto' ? `자동 · 끝 여백 ${tailPaddingMs}ms · 페이드 ${tailFadeMs}ms` : '끔'} · 감정 전환 ${emotionMode === 'pause' ? `쉼 후 ${emotionPauseMs}ms` : '즉시'}`
    : (capability.reason || '이 빌드에서 지원되지 않음')

  const padOk = inRange(tailPaddingMs, TTS_TAIL_PADDING_MS)
  const fadeOk = inRange(tailFadeMs, TTS_TAIL_FADE_MS)
  const gapOk = inRange(emotionPauseMs, TTS_EMOTION_PAUSE_MS)

  return (
    <section className="tts-flow-card" aria-label="세부 표현" style={card}>
      <header className="tts-flow-head" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>세부 표현</span>
        <span style={{ fontSize: 11, color: capOn ? 'var(--text-muted)' : 'var(--rose)', flex: 1, minWidth: 160 }}>{summary}</span>
        <button type="button" onClick={() => setExpanded(e => !e)} aria-expanded={expanded} aria-controls="tts-expr-detail-body" disabled={!capOn}
          style={btn('var(--bg-elevated)', 'var(--text-secondary)', !capOn)}>{expanded ? '접기' : '펼치기'}</button>
      </header>

      {!capOn && (
        <div style={{ padding: '10px 16px', fontSize: 11, color: 'var(--rose)' }}>
          {capability.reason || '말끝/감정 전환 처리를 사용할 수 없습니다.'} — 이 설정은 비활성화됩니다.
        </div>
      )}

      {capOn && expanded && (
        <div id="tts-expr-detail-body" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* 세부 값 직접 조절 — 슬라이더 편집 가능 여부일 뿐(기능 on/off 아님) */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: disabled ? 'not-allowed' : 'pointer', flexWrap: 'wrap' }}>
            <input type="checkbox" checked={fineTune} disabled={disabled} onChange={(e) => onToggleFineTune(e.target.checked)} />
            세부 값 직접 조절
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              {fineTune ? '세부값을 직접 조정합니다' : '현재 기본값(자동 · 쉼 후)이 적용 중입니다 — 켜면 세부값을 조정할 수 있습니다'}
            </span>
          </label>

          {/* ── 말끝 다듬기(권위: tailMode) ── */}
          <div style={rowCol}>
            <div className="tts-expr-row" style={row}>
              <span style={lbl}>말끝 다듬기</span>
              <Seg options={[['off', '끔'], ['auto', '자동']]} value={tailMode} disabled={disabled}
                onPick={(v) => onChange({ ttsTailMode: v as TtsTailMode })} aria="말끝 다듬기 모드" />
              <button type="button" onClick={() => setOpenHelp(h => !h)} aria-expanded={showSettingHelp || openHelp} aria-label="말끝 다듬기 설명" style={infoBtn}>i</button>
            </div>
            {(showSettingHelp || openHelp) && (
              <p style={help}>합성 후 말끝의 급격한 절단을 완화하고 짧은 끝 여백을 추가합니다.</p>
            )}
            {/* 끝 여백(기본 120ms) — auto & fineTune일 때만 편집 */}
            <SliderRow label="끝 여백" unit="ms" range={TTS_TAIL_PADDING_MS} value={tailPaddingMs} valid={padOk}
              disabled={disabled || !fineTune || tailMode !== 'auto'}
              gateNote={tailMode !== 'auto' ? '말끝 자동일 때 적용됩니다' : (!fineTune ? '직접 조절을 켜세요' : '')}
              onChange={(v) => onChange({ ttsTailPaddingMs: v })} />
            {/* 말끝 페이드(기본 8ms) */}
            <SliderRow label="말끝 페이드" unit="ms" range={TTS_TAIL_FADE_MS} value={tailFadeMs} valid={fadeOk}
              disabled={disabled || !fineTune || tailMode !== 'auto'}
              gateNote={tailMode !== 'auto' ? '말끝 자동일 때 적용됩니다' : (!fineTune ? '직접 조절을 켜세요' : '')}
              onChange={(v) => onChange({ ttsTailFadeMs: v })} />
          </div>

          {/* ── 감정 전환(권위: emotionMode) ── */}
          <div style={{ ...rowCol, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
            <div className="tts-expr-row" style={row}>
              <span style={lbl}>감정 전환</span>
              <Seg options={[['immediate', '즉시'], ['pause', '쉼 후']]} value={emotionMode} disabled={disabled}
                onPick={(v) => onChange({ ttsEmotionBoundaryMode: v as TtsEmotionMode })} aria="감정 전환 모드" />
            </div>
            {(showSettingHelp || openHelp) && (
              <p style={help}>서로 다른 감정 구간 사이에 넣는 간격입니다. 감정을 섞는 기능은 아닙니다.</p>
            )}
            {/* 감정 전환 간격(기본 200ms) — pause & fineTune일 때만 편집 */}
            <SliderRow label="감정 전환 간격" unit="ms" range={TTS_EMOTION_PAUSE_MS} value={emotionPauseMs} valid={gapOk}
              disabled={disabled || !fineTune || emotionMode !== 'pause'}
              gateNote={emotionMode !== 'pause' ? '쉼 후 모드일 때 적용됩니다' : (!fineTune ? '직접 조절을 켜세요' : '')}
              onChange={(v) => onChange({ ttsEmotionBoundaryPauseMs: v })} />
          </div>

          {/* 경계 우선순위 · space 안내(합산 아님) */}
          {(showSettingHelp || openHelp) && (
            <p style={{ ...help, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
              문장 간격과 감정 전환 간격은 <strong>합산되지 않습니다</strong> — 한 경계에는 우선순위(명시적 쉼 &gt; 줄바꿈 간격 &gt; 감정 전환 간격 &gt; 내부)에 따라 하나만 적용됩니다.
              대사의 공백(space)은 쉬는 시간 설정이 아닙니다.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

// ── 슬라이더 행: 범위 밖 값은 슬라이더 대신 오류(조용한 clamp 금지). 라벨·현재값 항상 노출. ──
function SliderRow(props: { label: string; unit: string; range: { min: number; max: number; def: number }; value: number; valid: boolean; disabled: boolean; gateNote: string; onChange: (v: number) => void }) {
  const { label, unit, range, value, valid, disabled, gateNote, onChange } = props
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, borderRadius: 8, background: 'var(--bg-elevated)', padding: '8px 12px', opacity: disabled && valid ? 0.6 : 1 }}>
      <div className="tts-expr-row" style={row}>
        <span style={{ ...lbl, minWidth: 84 }}>{label}</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: valid ? 'var(--rose)' : 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 52 }}>
          {value}{unit}{!valid ? ' ⚠' : ''}
        </span>
        {valid ? (
          <input type="range" min={range.min} max={range.max} step={1} value={value} disabled={disabled}
            aria-label={`${label} (${unit})`} aria-valuetext={`${value}${unit}`}
            onChange={(e) => { const v = parseInt(e.target.value, 10); if (inRangeInt(v, range)) onChange(v) }}
            style={{ flex: 1, minWidth: 120, accentColor: 'var(--rose)', cursor: disabled ? 'not-allowed' : 'pointer' }} />
        ) : (
          <span style={{ flex: 1, minWidth: 120, fontSize: 10, color: 'var(--rose)' }}>
            값이 허용 범위({range.min}~{range.max}{unit})를 벗어났습니다 — 합성이 차단됩니다. 기본값 {range.def}{unit}으로 되돌리세요.
          </span>
        )}
        {!valid && (
          <button type="button" onClick={() => onChange(range.def)} disabled={disabled}
            style={btn('var(--bg-card)', 'var(--text-secondary)')}>기본값({range.def}{unit})</button>
        )}
      </div>
      {valid && gateNote && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{gateNote}</span>}
    </div>
  )
}

function inRangeInt(v: number, r: { min: number; max: number }): boolean {
  return Number.isInteger(v) && v >= r.min && v <= r.max
}

// 세그먼트 토글(off|auto / immediate|pause) — 권위 컨트롤(fineTune과 무관하게 활성).
function Seg(props: { options: [string, string][]; value: string; disabled: boolean; onPick: (v: string) => void; aria: string }) {
  return (
    <span role="group" aria-label={props.aria} style={{ display: 'inline-flex', gap: 4 }}>
      {props.options.map(([v, label]) => {
        const active = v === props.value
        return (
          <button key={v} type="button" onClick={() => props.onPick(v)} disabled={props.disabled} aria-pressed={active}
            style={btn(active ? 'var(--rose)' : 'var(--bg-elevated)', active ? '#fff' : 'var(--text-secondary)', props.disabled)}>{label}</button>
        )
      })}
    </span>
  )
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const rowCol: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const lbl: CSSProperties = { fontSize: 11, color: 'var(--text-muted)', minWidth: 64 }
const help: CSSProperties = { fontSize: 10, lineHeight: 1.5, color: 'var(--text-muted)', margin: 0 }
const infoBtn: CSSProperties = { width: 16, height: 16, borderRadius: '50%', border: '1px solid var(--text-muted)', background: 'transparent', color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontFamily: 'inherit' }
function btn(bg: string, color: string, isDisabled = false): CSSProperties {
  return { fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: 'none', cursor: isDisabled ? 'not-allowed' : 'pointer', background: bg, color, fontFamily: 'inherit', opacity: isDisabled ? 0.5 : 1, whiteSpace: 'nowrap' }
}
