// 만들어진 소리의 **재생 빠르기** 고르기 — 앱 전체가 한 값을 쓴다(낭독·생성 카드가 같은 값을 본다).
// ★다시 만들지 않는다 — 재생할 때만 빨라지고, 음 높이는 그대로다(2026-09-30 지시).
import { useEffect, useState, type CSSProperties } from 'react'
import { getPlaybackRate, onPlaybackRateChange, savePlaybackRate, setPlaybackRate } from '@/lib/playbackVolume'
import { PLAYBACK_RATES, playbackRateLabel } from '../../shared/playbackRate'

export default function PlaybackRateSelect({ style, testId = 'playback-rate' }: { style?: CSSProperties; testId?: string }) {
  const [rate, setRate] = useState(getPlaybackRate)
  const [saveFailed, setSaveFailed] = useState(false)
  useEffect(() => onPlaybackRateChange(setRate), [])
  return (
    <label title="만들어진 소리를 듣는 빠르기 — 다시 만들지 않고, 목소리 높이는 그대로입니다"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', ...style }}>
      빠르기
      <select data-testid={testId} value={String(rate)}
        onChange={(e) => {
          setPlaybackRate(Number(e.target.value))
          void savePlaybackRate().then((r) => setSaveFailed(!r.ok))
        }}
        style={{ fontSize: 13, padding: '5px 6px', borderRadius: 6, background: 'var(--bg-base)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
        {PLAYBACK_RATES.map((r) => <option key={r} value={String(r)}>{playbackRateLabel(r)}</option>)}
      </select>
      {saveFailed && <span role="alert" style={{ color: 'var(--rose, #fb7185)' }}>저장 못 함 — 다시 켜면 1배</span>}
    </label>
  )
}
