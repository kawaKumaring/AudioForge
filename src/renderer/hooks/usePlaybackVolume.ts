// 이미 있는 볼륨 슬라이더를 **기억하는 하나의 값**에 연결한다.
//
// 왜 필요한가(2026-09-10 사용자 보고 "소리가 항상 최대"): 볼륨 슬라이더는 원래 두 곳
// (원본 파형·결과 트랙)에 있었지만, 각각 컴포넌트 지역 상태 `useState(1)` 이었다. 그래서
//   · 파일을 다시 불러오거나 화면이 다시 그려지면 100% 로 되돌아갔고,
//   · 앱을 다시 켜면 당연히 100% 였고,
//   · 두 슬라이더가 서로 다른 값을 가질 수도 있었다.
// 조절 수단을 새로 만드는 대신, 있는 슬라이더가 공용 값을 읽고 쓰게 한다. 그 값은 보관되고,
// 슬라이더가 없는 재생 지점(미리듣기 등)에도 같은 값이 걸린다.
//
// 보관은 **손을 뗀 뒤** 한 번만 한다(끄는 동안 디스크를 두드리지 않는다) — commit 이 그 몫이다.
import { useEffect, useState } from 'react'

// @ts-ignore TS5097: node --test 가 요구하는 명시적 .ts 확장자(app.store 의 같은 관례).
import { getPlaybackVolume, onPlaybackVolumeChange, savePlaybackVolume, setPlaybackVolume } from '../lib/playbackVolume.ts'

export interface PlaybackVolumeControl {
  /** 지금 음량(0~1). 다른 슬라이더에서 바뀌어도 따라온다. */
  volume: number
  /** 끄는 동안 부른다 — 즉시 적용하되 보관하지 않는다. */
  change: (v: number) => void
  /** 손을 뗀 뒤 한 번 부른다 — 이때 보관한다. */
  commit: () => void
  /** 보관에 실패했는가(이 실행에는 적용되지만 다음에는 되돌아간다). */
  saveFailed: boolean
}

export function usePlaybackVolume(): PlaybackVolumeControl {
  const [volume, setVolume] = useState(getPlaybackVolume)
  const [saveFailed, setSaveFailed] = useState(false)
  useEffect(() => onPlaybackVolumeChange(setVolume), [])
  return {
    volume,
    change: (v: number) => { setPlaybackVolume(v) },
    commit: () => { void savePlaybackVolume().then((r) => setSaveFailed(!r.ok)) },
    saveFailed,
  }
}
