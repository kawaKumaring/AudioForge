// 표현 컨트롤 (C 소유). 4-flow의 [3] 표현 흐름 — 후처리 축(pitch/speed/문장 간격)만 조작한다(생성축과 분리).
// 규칙:
//  - 프리셋(원본/낮고 차분/중성적/밝고 가볍게)은 후처리 값 묶음. 실제 값 적용(store)은 셸의 onPreset 핸들러가 한다.
//  - '세부 조절 사용'(enable)과 펼치기/접기(expand)는 별개 컨트롤이다.
//  - 접혀 있어도 적용값 요약을 항상 보인다.
//  - 지원 축(capabilities=true)만 활성. emotionTransitionGap/tailTrim/tailPadding은 capability=false면 비활성(미노출/준비 중).
//  - smooth/formant/brightness/breathiness/가성 슬라이더는 존재하지 않는다(가짜 슬라이더 금지).
//  - '다시 합성 없이 적용'(빠른 재처리) 버튼은 노출하지 않는다. 축 성격은 정보 배지로만 표시한다.
//  - pitch 축 라벨은 '낮고 묵직함 ↔ 높고 가볍게'(성별 전환 아님, 남성/여성 표현 금지).
// ⚠️ TTSEditor 셸 배선은 I5. 이 파일은 셸에 스스로 연결하지 않는다.
// props 계약: src/renderer/types/ttsExpression.ts ExpressionControlsProps / ExpressionCapabilities.
import { useState } from 'react'
import type { CSSProperties } from 'react'
import type { ExpressionControlsProps, ExpressionCapabilities } from '../types/ttsExpression'

// ── 순수 로직(테스트 대상, React 비의존 계산) ────────────────────────────────
export interface PresetValues { pitchSemitones: number; speed: number; sentenceGapMs: number }
export interface ExpressionPreset { id: string; label: string; values: PresetValues }

// 프리셋 값은 보수적(연구 tts-prosody-control §4: pitch ±1 이내로 유사도 보호). 전부 후처리 축.
export const EXPRESSION_PRESETS: readonly ExpressionPreset[] = Object.freeze([
  { id: 'original', label: '원본', values: { pitchSemitones: 0, speed: 1.0, sentenceGapMs: 500 } },
  { id: 'calm_low', label: '낮고 차분', values: { pitchSemitones: -1, speed: 0.95, sentenceGapMs: 650 } },
  { id: 'neutral', label: '중성적', values: { pitchSemitones: 0, speed: 1.0, sentenceGapMs: 500 } },
  { id: 'bright_light', label: '밝고 가볍게', values: { pitchSemitones: 1, speed: 1.05, sentenceGapMs: 400 } },
])
export const EXPRESSION_PRESET_IDS: readonly string[] = EXPRESSION_PRESETS.map(p => p.id)

export function getPresetValues(presetId: string): PresetValues | null {
  const p = EXPRESSION_PRESETS.find(x => x.id === presetId)
  return p ? { ...p.values } : null
}
export function presetLabel(presetId: string): string {
  return EXPRESSION_PRESETS.find(x => x.id === presetId)?.label ?? '사용자 지정'
}

// 활성 컨트롤 판정(가짜 슬라이더 방지) — capability=true인 축만.
export function activeControlKeys(cap: ExpressionCapabilities): string[] {
  const out: string[] = []
  if (cap.pitch) out.push('pitch')
  if (cap.speed) out.push('speed')
  if (cap.sentenceGap) out.push('sentenceGap')
  if (cap.emotionTransitionGap) out.push('emotionTransitionGap')
  if (cap.tailTrim) out.push('tailTrim')
  if (cap.tailPadding) out.push('tailPadding')
  return out
}

function fmtPitch(v: number): string { return `${v > 0 ? '+' : ''}${v.toFixed(1)}반음` }
function fmtSpeed(v: number): string { return `${v.toFixed(2)}x` }
function fmtSec(ms: number): string { const s = ms / 1000; return `${Number.isInteger(s) ? s.toFixed(1) : String(s)}초` }

// 접힘 상태에서도 보이는 적용값 요약. 기본값(pitch 0/speed 1.0/gap 500)은 노이즈 방지로 생략.
export function summarizeExpression(
  presetId: string,
  values: { pitchSemitones: number; speed: number; sentenceGapMs: number },
  cap: ExpressionCapabilities,
): string {
  const parts: string[] = [presetLabel(presetId)]
  if (cap.pitch && values.pitchSemitones !== 0) parts.push(`음높이 ${fmtPitch(values.pitchSemitones)}`)
  if (cap.speed && values.speed !== 1.0) parts.push(`속도 ${fmtSpeed(values.speed)}`)
  if (cap.sentenceGap && values.sentenceGapMs !== 500) parts.push(`문장 간격 ${fmtSec(values.sentenceGapMs)}`)
  if (parts.length === 1) parts.push('기본값')
  return parts.join(' · ')
}

// ── 컨트롤 메타(한 문장 도움말 + 자세히) ──────────────────────────────────────
interface CtrlMeta { key: keyof ExpressionCapabilities; label: string; help: string; detail: string }
const SUPPORTED_META: CtrlMeta[] = [
  { key: 'pitch', label: '음높이', help: '재합성 없이 결과 음성의 높낮이만 반음 단위로 보정합니다.',
    detail: '크게 옮기면 다른 사람 목소리처럼 들릴 수 있어요. 성별을 바꾸는 기능이 아닙니다.' },
  { key: 'speed', label: '속도', help: '말하는 속도를 조절합니다(음높이는 유지).',
    detail: '너무 빠르거나 느리면 부자연스러울 수 있어요.' },
  { key: 'sentenceGap', label: '문장 간격', help: '문장과 문장 사이에 넣을 쉬는 시간입니다.',
    detail: '감정이 바뀌는 줄 경계에도 적용될 수 있습니다.' },
]
const WITHHELD_META: CtrlMeta[] = [
  { key: 'emotionTransitionGap', label: '감정 전환 간격', help: '감정이 바뀌는 지점의 간격입니다.', detail: '지원 준비 중입니다(현재 사용 불가).' },
  { key: 'tailTrim', label: '말끝 다듬기', help: '문장 끝의 어색한 소리를 다듬습니다.', detail: '지원 준비 중입니다(현재 사용 불가).' },
  { key: 'tailPadding', label: '끝 여백', help: '결과 끝에 여백(무음)을 더합니다.', detail: '지원 준비 중입니다(현재 사용 불가).' },
]

// 로컬 확장(계약 파일 미수정): 전역 '설정 설명 표시' 신호를 셸이 넘긴다.
export interface ExpressionControlsLocalProps extends ExpressionControlsProps {
  showSettingHelp?: boolean
  disabled?: boolean
}

export default function ExpressionControls({
  capabilities,
  presetId,
  fineTuneEnabled,
  values,
  onPreset,
  onToggleFineTune,
  onChange,
  showSettingHelp = false,
  disabled = false,
}: ExpressionControlsLocalProps) {
  const [expanded, setExpanded] = useState(false)
  const [openHelp, setOpenHelp] = useState<Record<string, boolean>>({})
  const [openDetail, setOpenDetail] = useState<Record<string, boolean>>({})

  const helpVisible = (k: string) => showSettingHelp || !!openHelp[k]
  const toggleHelp = (k: string) => setOpenHelp(s => ({ ...s, [k]: !s[k] }))
  const toggleDetail = (k: string) => setOpenDetail(s => ({ ...s, [k]: !s[k] }))

  const summary = summarizeExpression(presetId, values, capabilities)
  const fineDisabled = disabled || !fineTuneEnabled

  return (
    <section className="tts-flow-card" aria-label="표현" style={{ borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
      <header className="tts-flow-head" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
        <span aria-hidden="true" style={flowNum}>3</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>표현</span>
        {/* 축 성격(정보 배지 — 버튼 아님). 재합성 없이 결과에 적용되는 후처리 축. */}
        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--cyan)', background: 'var(--cyan-glow)', padding: '2px 7px', borderRadius: 5, letterSpacing: '0.02em' }}>
          재합성 없이 적용
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 140 }}>{summary}</span>
        <button type="button" onClick={() => setExpanded(e => !e)} aria-expanded={expanded} aria-controls="tts-expr-fine"
          style={btn('var(--bg-elevated)', 'var(--text-secondary)')}>
          {expanded ? '접기' : '펼치기'}
        </button>
      </header>

      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* 프리셋 */}
        <div role="group" aria-label="표현 프리셋" className="tts-expr-row" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 44 }}>프리셋</span>
          {EXPRESSION_PRESETS.map(p => {
            const active = p.id === presetId
            return (
              <button key={p.id} type="button" onClick={() => onPreset(p.id)} disabled={disabled}
                aria-pressed={active}
                style={{ ...btn(active ? 'var(--rose)' : 'var(--bg-elevated)', active ? '#fff' : 'var(--text-secondary)', disabled), fontSize: 11 }}>
                {p.label}
              </button>
            )
          })}
        </div>

        {/* 세부 조절 사용(enable) — 펼치기/접기와 별개 */}
        <div className="tts-expr-row" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: disabled ? 'not-allowed' : 'pointer' }}>
            <input type="checkbox" checked={fineTuneEnabled} disabled={disabled} onChange={(e) => onToggleFineTune(e.target.checked)} />
            세부 조절 사용
          </label>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {fineTuneEnabled ? '세부값이 프리셋을 덮어씁니다' : '프리셋 값만 적용됩니다'}
          </span>
        </div>

        {/* 세부 컨트롤(펼침) */}
        {expanded && (
          <div id="tts-expr-fine" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* pitch */}
            {capabilities.pitch && (
              <SliderRow
                metaKey="pitch" label="음높이" valueText={fmtPitch(values.pitchSemitones)}
                min={-2} max={2} step={0.5} value={values.pitchSemitones} disabled={fineDisabled}
                ariaValueText={fmtPitch(values.pitchSemitones)}
                endLabels={['낮고 묵직함', '높고 가볍게']}
                help={SUPPORTED_META[0].help} detail={SUPPORTED_META[0].detail}
                helpVisible={helpVisible('pitch')} onToggleHelp={() => toggleHelp('pitch')}
                detailVisible={!!openDetail['pitch']} onToggleDetail={() => toggleDetail('pitch')}
                onChange={(v) => onChange({ pitchSemitones: v })}
              />
            )}
            {/* speed */}
            {capabilities.speed && (
              <SliderRow
                metaKey="speed" label="속도" valueText={fmtSpeed(values.speed)}
                min={0.5} max={2.0} step={0.05} value={values.speed} disabled={fineDisabled}
                ariaValueText={fmtSpeed(values.speed)}
                help={SUPPORTED_META[1].help} detail={SUPPORTED_META[1].detail}
                helpVisible={helpVisible('speed')} onToggleHelp={() => toggleHelp('speed')}
                detailVisible={!!openDetail['speed']} onToggleDetail={() => toggleDetail('speed')}
                onChange={(v) => onChange({ speed: v })}
              />
            )}
            {/* sentenceGap */}
            {capabilities.sentenceGap && (
              <SliderRow
                metaKey="sentenceGap" label="문장 간격" valueText={fmtSec(values.sentenceGapMs)}
                min={0} max={2000} step={50} value={values.sentenceGapMs} disabled={fineDisabled}
                ariaValueText={fmtSec(values.sentenceGapMs)}
                help={SUPPORTED_META[2].help} detail={SUPPORTED_META[2].detail}
                helpVisible={helpVisible('sentenceGap')} onToggleHelp={() => toggleHelp('sentenceGap')}
                detailVisible={!!openDetail['sentenceGap']} onToggleDetail={() => toggleDetail('sentenceGap')}
                onChange={(v) => onChange({ sentenceGapMs: v })}
              />
            )}

            {/* 미지원 축(capability=false) — 비활성 안내. 가짜 슬라이더/가짜 값 없음. */}
            {WITHHELD_META.filter(m => !capabilities[m.key]).map(m => (
              <div key={m.key} className="tts-expr-row" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', opacity: 0.5 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 92 }}>{m.label}</span>
                <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--bg-elevated)', padding: '2px 7px', borderRadius: 5 }}>준비 중</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{m.help} {m.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// ── 슬라이더 행(라벨+현재값 항상 노출 · ⓘ 한 문장 · 자세히) ─────────────────
function SliderRow(props: {
  metaKey: string; label: string; valueText: string
  min: number; max: number; step: number; value: number; disabled: boolean
  ariaValueText: string; endLabels?: [string, string]
  help: string; detail: string
  helpVisible: boolean; onToggleHelp: () => void
  detailVisible: boolean; onToggleDetail: () => void
  onChange: (v: number) => void
}) {
  const helpId = `tts-expr-help-${props.metaKey}`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderRadius: 8, background: 'var(--bg-elevated)', padding: '8px 12px', opacity: props.disabled ? 0.6 : 1 }}>
      <div className="tts-expr-row" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 64 }}>{props.label}</span>
        {/* 현재값 항상 노출 */}
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--rose)', fontVariantNumeric: 'tabular-nums', minWidth: 56 }}>{props.valueText}</span>
        <button type="button" onClick={props.onToggleHelp} aria-expanded={props.helpVisible} aria-controls={helpId}
          aria-label={`${props.label} 설명`} style={infoBtn}>i</button>
        <input
          type="range" min={props.min} max={props.max} step={props.step} value={props.value}
          disabled={props.disabled}
          aria-label={props.label} aria-valuetext={props.ariaValueText}
          onChange={(e) => props.onChange(parseFloat(e.target.value))}
          style={{ flex: 1, minWidth: 120, accentColor: 'var(--rose)', cursor: props.disabled ? 'not-allowed' : 'pointer' }}
        />
        <button type="button" onClick={props.onToggleDetail} aria-expanded={props.detailVisible}
          style={{ ...btn('transparent', 'var(--text-muted)'), fontSize: 10, padding: '2px 6px' }}>자세히</button>
      </div>
      {props.endLabels && (
        <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-muted)', padding: '0 2px' }}>
          <span>{props.endLabels[0]}</span><span>{props.endLabels[1]}</span>
        </div>
      )}
      {props.helpVisible && (
        <p id={helpId} style={{ fontSize: 10, lineHeight: 1.5, color: 'var(--text-muted)', margin: 0 }}>{props.help}</p>
      )}
      {props.detailVisible && (
        <p style={{ fontSize: 10, lineHeight: 1.5, color: 'var(--text-secondary)', margin: 0 }}>{props.detail}</p>
      )}
    </div>
  )
}

const flowNum: CSSProperties = {
  width: 22, height: 22, borderRadius: 6, background: 'var(--bg-elevated)',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 11, fontWeight: 700, color: 'var(--accent)', flexShrink: 0,
}
const infoBtn: CSSProperties = {
  width: 16, height: 16, borderRadius: '50%', border: '1px solid var(--text-muted)',
  background: 'transparent', color: 'var(--text-muted)', fontSize: 10, fontStyle: 'italic',
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontFamily: 'inherit',
}
function btn(bg: string, color: string, isDisabled = false): CSSProperties {
  return {
    fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, border: 'none',
    cursor: isDisabled ? 'not-allowed' : 'pointer', background: bg, color, fontFamily: 'inherit',
    opacity: isDisabled ? 0.5 : 1, whiteSpace: 'nowrap',
  }
}
