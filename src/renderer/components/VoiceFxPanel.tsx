/**
 * 음성 처리 설정 — 한 트랙(화자)의 처리 순서대로 켜고 끄고 값을 고른다.
 * 값을 바꾸면 재생 중에도 끊지 않고 바로 들린다(엔진이 연결을 그대로 두고 값만 바꾼다).
 * 설명은 툴팁에 둔다(화면에는 이름·값만 — 사용자 규칙).
 */
import type { CSSProperties } from 'react'
import { VOICE_FX_RANGES, type VoiceFxSettings } from '../../shared/voiceFx/settings'
import { muted } from './kit'

type Section = keyof VoiceFxSettings
interface Knob { key: string; label: string; unit: string; step: number; tip: string; fmt?: (v: number) => string }
const SECTIONS: { id: Section; label: string; tip: string; knobs: Knob[] }[] = [
  { id: 'denoise', label: '잡음 지우기', tip: '마이크 잡음·에어컨 소리 같은 배경 잡음을 지웁니다(RNNoise). 목소리가 조금 뭉개질 수 있으니 들어 보고 쓰세요.', knobs: [] },
  { id: 'highpass', label: '저음 자르기', tip: '책상 쿵쿵거림·웅웅거리는 아주 낮은 소리를 잘라 냅니다. 목소리에는 80Hz 가 보통입니다.', knobs: [
    { key: 'freqHz', label: '기준', unit: 'Hz', step: 5, tip: '이 높이보다 낮은 소리를 줄입니다.' }] },
  { id: 'eq', label: '음색', tip: '목소리의 두께·또렷함·공기감을 조금씩 올리거나 내립니다.', knobs: [
    { key: 'lowDb', label: '두께', unit: 'dB', step: 0.5, tip: '120Hz 근처 — 올리면 묵직, 내리면 가벼움.' },
    { key: 'presenceDb', label: '또렷함', unit: 'dB', step: 0.5, tip: '3kHz 근처 — 올리면 말이 또렷해지고 지나치면 날카로워집니다.' },
    { key: 'airDb', label: '공기감', unit: 'dB', step: 0.5, tip: '10kHz 위 — 올리면 숨결·밝음이 살아납니다.' }] },
  { id: 'compressor', label: '크기 고르게', tip: '들쭉날쭉한 목소리 크기를 고르게 잡아 줍니다(컴프레서).', knobs: [
    { key: 'thresholdDb', label: '문턱', unit: 'dB', step: 1, tip: '이 크기를 넘는 소리부터 줄입니다. 낮출수록 더 많이 고르게 됩니다.' },
    { key: 'ratio', label: '세기', unit: ':1', step: 0.5, tip: '넘은 만큼을 얼마나 줄일지 — 4 면 넘은 4dB 를 1dB 로.' },
    { key: 'makeupDb', label: '되올림', unit: 'dB', step: 0.5, tip: '줄인 만큼 전체를 다시 키웁니다.' }] },
  { id: 'deesser', label: '치찰음 줄이기', tip: "'스'·'츠' 같은 쇳소리가 거슬릴 때 그 대역만 눌러 줍니다. 지지직·전파 같은 소리가 이 대역일 수 있습니다.", knobs: [
    { key: 'freqHz', label: '대역', unit: 'Hz', step: 100, tip: '이 높이 위의 소리를 봅니다. 보통 5~8kHz.' },
    { key: 'thresholdDb', label: '문턱', unit: 'dB', step: 1, tip: '그 대역이 이 크기를 넘으면 줄입니다.' },
    { key: 'rangeDb', label: '최대', unit: 'dB', step: 1, tip: '한 번에 최대 이만큼까지만 줄입니다.' }] },
  { id: 'reverb', label: '울림', tip: '아주 약한 잔향으로 공간감을 더합니다. 2~5% 면 충분합니다.', knobs: [
    { key: 'mix', label: '양', unit: '%', step: 0.005, tip: '잔향을 섞는 양.', fmt: (v) => (v * 100).toFixed(1) },
    { key: 'decaySec', label: '길이', unit: '초', step: 0.1, tip: '잔향이 사라지는 데 걸리는 시간.' }] },
  { id: 'limiter', label: '최대치 보호', tip: '소리가 정한 최대치를 넘지 않게 미리 살짝 줄입니다(깨짐 방지).', knobs: [
    { key: 'ceilingDb', label: '최대치', unit: 'dBTP', step: 0.1, tip: '실제 최대치(샘플 사이 포함)의 상한. 보통 −1.' }] },
]

const rowStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '64px 1fr 72px', alignItems: 'center', gap: 8 }

export default function VoiceFxPanel ({ fx, onChange, reductions, testPrefix = 've-fx' }: {
  fx: VoiceFxSettings
  onChange: (next: VoiceFxSettings) => void
  /** 지금 줄이고 있는 양(dB) — 재생 중에만 온다. */
  reductions?: Partial<Record<'compressor' | 'deesser' | 'limiter', number>>
  testPrefix?: string
}) {
  const set = (sec: Section, key: string, v: unknown): void => onChange({ ...fx, [sec]: { ...fx[sec], [key]: v } } as VoiceFxSettings)
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    {SECTIONS.map((s) => {
      const on = (fx[s.id] as { on: boolean }).on
      const red = reductions?.[s.id as 'compressor' | 'deesser' | 'limiter']
      return <section key={s.id} style={{ border: '1px solid var(--border-subtle)', borderRadius: 9, padding: '9px 11px', background: on ? 'var(--bg-elevated)' : 'transparent' }}>
        <label title={s.tip} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" data-testid={`${testPrefix}-${s.id}-on`} checked={on} onChange={(e) => set(s.id, 'on', e.target.checked)} />
          <span style={{ flex: 1 }}>{s.label}</span>
          {on && red !== undefined && red > 0.1 && <span data-testid={`${testPrefix}-${s.id}-gr`} style={{ ...muted, fontVariantNumeric: 'tabular-nums' }} title="지금 줄이고 있는 양">−{red.toFixed(1)}dB</span>}
        </label>
        {on && s.knobs.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
          {s.knobs.map((k) => {
            const range = (VOICE_FX_RANGES as Record<string, readonly [number, number]>)[`${s.id}.${k.key}`]
            const v = (fx[s.id] as unknown as Record<string, number>)[k.key]
            return <label key={k.key} title={k.tip} style={rowStyle}>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{k.label}</span>
              <input type="range" data-testid={`${testPrefix}-${s.id}-${k.key}`} min={range[0]} max={range[1]} step={k.step} value={v}
                onChange={(e) => set(s.id, k.key, Number(e.target.value))} />
              <span style={{ ...muted, fontSize: 12, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{k.fmt ? k.fmt(v) : (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1))}{k.unit}</span>
            </label>
          })}
        </div>}
      </section>
    })}
  </div>
}
