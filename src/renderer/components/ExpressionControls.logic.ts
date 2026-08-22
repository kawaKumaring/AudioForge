// ExpressionControls 순수 로직 (C 소유). React/JSX 비의존 — node --test가 type-strip해 바로 실행 가능.
// ⚠️ 이 파일에는 JSX/React import를 넣지 않는다(넣으면 node:test 러너가 파싱 못 함). 컴포넌트/JSX는 .tsx.
// ExpressionControls.tsx와 ExpressionControls.test.ts가 모두 이 모듈에서 순수 값을 가져온다.
import type { ExpressionCapabilities } from '../types/ttsExpression'

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

export function fmtPitch(v: number): string { return `${v > 0 ? '+' : ''}${v.toFixed(1)}반음` }
export function fmtSpeed(v: number): string { return `${v.toFixed(2)}x` }
export function fmtSec(ms: number): string { const s = ms / 1000; return `${Number.isInteger(s) ? s.toFixed(1) : String(s)}초` }

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
