// 결과 재생기와 결과 스타일 — **음악·대화가 같은 것을 쓴다.**
//
// 예전에는 이 코드가 `TrackList` 안에만 있었고, 대화 작업실은 제 오디오 요소를 따로 들었다.
// 그러면 같은 일이 두 벌이 되고 한쪽만 고쳐진다 — 실제로 대화 쪽은 길이를 모르는
// 재생기라 **막대를 끌어 이동할 수 없었다.**
//
// 이 재생기가 하는 일
//   · 파형을 그리고 **끌어서 이동**할 수 있다(통째로 디코딩하므로 길이를 안다)
//   · 음량은 **공용 값** 하나를 따른다(화면마다 따로 기억하지 않는다)
//   · 원본과 견줄 때 **재생 위치와 재생 여부를 이어받는다**
//   · 재생기는 한 번에 하나다 — 두 소리가 겹치지 않는다
//   · 파일 주소는 **기존 공용 경로**(`audio.getFileUrl`)로만 얻는다
import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { getPlaybackVolume } from '@/lib/playbackVolume'
import { usePlaybackVolume } from '@/hooks/usePlaybackVolume'
import { useAppStore } from '@/stores/app.store'

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${alpha})`
}
export function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// 결과 트랙용 파형 플레이어 (파형 + 시간 + 볼륨 + 드래그 이동). 재생 시에만 지연 생성.
export function ResultPlayer({ path, color, paused, onClose, originalPath, originalLabel }: {
  path: string; color: string; paused: boolean; onClose: () => void
  /** 같은 자리에서 견줘 들을 원본. 없으면 비교 단추를 내지 않는다. */
  originalPath?: string | null; originalLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const wsRef = useRef<WaveSurfer | null>(null)
  const readyRef = useRef(false)
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const [cur, setCur] = useState('0:00')
  const [dur, setDur] = useState('0:00')
  // ★숫자도 들고 있는다 — 화면 바깥(검사·접근성)에서 지금 상태를 읽을 수 있게 한다.
  //   WebAudio 로 트므로 화면에 <audio> 요소가 없다. 이 값이 유일한 관측 지점이다.
  const [curSec, setCurSec] = useState(0)
  const [durSec, setDurSec] = useState(0)
  const [playing, setPlaying] = useState(false)
  // 지금 무엇을 듣고 있는가 — 분리 결과인가 원본인가.
  const [listening, setListening] = useState<'track' | 'original'>('track')
  // 전환할 때 이어받을 것: **그 순간의 재생 위치와 재생/멈춤 상태**.
  //   두 파일 길이가 다를 수 있어, 되돌릴 때 새 파일의 유효 범위로 자른다.
  const handoffRef = useRef<{ time: number; playing: boolean } | null>(null)
  const activePath = listening === 'original' && originalPath ? originalPath : path
  // 원본 파형 슬라이더와 **같은 값**이다(공용·보관됨) — 두 슬라이더가 서로 다른 값을 갖지 않는다.
  const { volume, change: changeVolume, commit: commitVolume, saveFailed: volumeSaveFailed } = usePlaybackVolume()

  /** 이 재생기의 **몇 번째 로딩인가.** 늦게 온 앞 로딩이 소리를 내지 못하게 한다. */
  const loadSeq = useRef(0)
  const claim = useAppStore((st) => st.audioClaim)

  // ★소리는 한 번에 한 곳만 — 다른 자리가 가져가면 여기서 멈춘다.
  useEffect(() => {
    if (claim && claim.owner !== 'result') {
      try { wsRef.current?.pause() } catch { /* noop */ }
    }
  }, [claim])

  useEffect(() => {
    let cancelled = false
    let ws: WaveSurfer | null = null
    const mine = ++loadSeq.current
    useAppStore.getState().claimAudio('result')       // 트는 자리를 가져온다
    ;(async () => {
      const url = await window.api.audio.getFileUrl(activePath)
      // ★늦게 온 앞 로딩은 여기서 끝난다 — 바꾸기 전 소리가 뒤늦게 울리지 않는다.
      if (cancelled || mine !== loadSeq.current || !ref.current) return
      ws = WaveSurfer.create({
        container: ref.current, waveColor: hexToRgba(color, 0.3), progressColor: color,
        cursorColor: color, cursorWidth: 2, barWidth: 2, barGap: 2, barRadius: 4,
        height: 40, normalize: true, backend: 'WebAudio', dragToSeek: true
      })
      // ★ 만들자마자 지금 음량을 건다 — **자동 재생 전에** 해야 한다.
      //   이 플레이어는 파일 주소를 기다린 뒤에 만들어지는데, 음량 effect 는 그 전에 이미 끝난다.
      //   그래서 여기서 걸지 않으면 결과 트랙의 **첫 재생만 최대 음량**으로 나갔다.
      //   지역 상태(volume)가 아니라 소유자의 **지금 값**을 읽는다 — 기다리는 동안 사용자가
      //   슬라이더를 움직였을 수 있고, 그때는 최신 값이 맞다.
      ws.setVolume(getPlaybackVolume())
      ws.on('timeupdate', (t) => { setCur(fmtTime(t)); setCurSec(t) })
      ws.on('decode', (d) => { setDur(fmtTime(d)); setDurSec(d) })
      ws.on('play', () => setPlaying(true))
      ws.on('pause', () => setPlaying(false))
      ws.on('ready', () => {
        readyRef.current = true
        if (!ws) return
        /**
         * ★기다리는 동안 소리 낼 자리가 **다른 곳으로 넘어갔는지** 본다.
         *   파일을 읽어 오는 사이 사용자가 원본 파형이나 다른 화면을 틀었을 수 있다.
         *   그때 여기서 자동으로 틀면 **두 소리가 겹친다** — 늦게 온 쪽이 이긴다.
         *   위치는 이어받되 **소리는 내지 않는다.** 사용자가 다시 누르면 그때 가져온다.
         */
        const mineNow = () => useAppStore.getState().audioClaim?.owner === 'result'
        // ★전환이면 **위치와 상태를 이어받는다.** 길이가 다르면 유효 범위로 자른다.
        const h = handoffRef.current
        handoffRef.current = null
        if (mine !== loadSeq.current) { try { ws.pause() } catch { /* noop */ } return }
        if (h) {
          const total = ws.getDuration() || 0
          const limit = Math.max(0, total - 0.05)
          const at = total > 0 ? Math.min(Math.max(0, h.time), limit) : 0
          // ★자른 경우에는 **이어서 틀지 않는다.** 짧은 쪽의 끝을 넘어간 자리였으니,
          //   그대로 재생하면 0.05초 만에 끝나 재생기가 닫힌다(실측). 그 자리에 멈춰 둔다.
          const clamped = h.time > limit + 0.001
          try { ws.setTime(at) } catch { /* noop */ }
          if (h.playing && !clamped && mineNow()) ws.play()
          return
        }
        if (!pausedRef.current && mineNow()) ws.play()
      })
      ws.on('finish', () => onClose())
      ws.load(url)
      wsRef.current = ws
    })()
    return () => {
      cancelled = true
      const w = ws || wsRef.current
      if (w) { try { w.pause() } catch { /* noop */ } try { w.destroy() } catch { /* noop */ } }
      wsRef.current = null
      readyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath])

  // 이후 슬라이더 변경은 이 effect 가 실시간으로 반영한다(생성 시점 적용과 별개).
  useEffect(() => { wsRef.current?.setVolume(volume) }, [volume])

  // 재생/일시정지 제어는 트랙 행의 버튼(원래 위치)이 담당 — paused prop을 준비된 뒤에만 반영
  useEffect(() => {
    const ws = wsRef.current
    if (!ws || !readyRef.current) return
    // ★사람이 누른 재생이다 — 여기서는 자리를 **가져온다**(늦은 자동 재생과 다르다).
    if (paused) ws.pause()
    else { useAppStore.getState().claimAudio('result'); void ws.play() }
  }, [paused])

  return (
    <div data-testid="result-player" data-playing={playing ? '1' : '0'}
      data-time={curSec.toFixed(2)} data-dur={durSec.toFixed(2)}
      style={{ padding: '8px 14px', borderTop: '1px solid var(--border-subtle)' }}>
      <div ref={ref} style={{ marginBottom: 6 }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)' }}>{cur} / {dur}</span>
        {/* 원본 ↔ 분리 결과 — **같은 자리에서** 견준다. 재생기는 하나뿐이라 소리가 겹치지 않는다.
            듣기만 한다: 저장된 파일을 키우거나 고르거나 다시 쓰지 않는다. */}
        {originalPath && (
          <button data-testid="track-compare" data-listening={listening}
            onClick={() => {
              const ws = wsRef.current
              handoffRef.current = ws
                ? { time: ws.getCurrentTime() || 0, playing: ws.isPlaying() }
                : null
              setListening((v) => (v === 'track' ? 'original' : 'track'))
            }}
            title={"같은 위치에서 원본과 분리 결과를 번갈아 들어 봅니다. 저장된 파일은 바뀌지 않습니다."}
            aria-label={listening === 'track' ? '원본 듣기로 바꾸기' : '분리 결과 듣기로 바꾸기'}
            style={{
              padding: '2px 8px', borderRadius: 5, border: 'none', cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 600,
              background: listening === 'original' ? 'var(--cyan)' : 'var(--bg-elevated)',
              color: listening === 'original' ? '#fff' : 'var(--text-secondary)',
            }}>
            {listening === 'original' ? `원본 듣는 중${originalLabel ? ` · ${originalLabel}` : ''}` : '원본과 비교'}
          </button>
        )}
        <div title={volumeSaveFailed
          ? '재생 볼륨 — 이 값을 기억하지 못했습니다(이번 실행에만 적용됩니다).'
          : '재생 볼륨 (듣기 전용 · 원본 파일에는 영향 없음) — 정한 값이 다음에도 그대로 쓰입니다.'}
          style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            {volume < 0.01
              ? <><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></>
              : <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />}
          </svg>
          <input type="range" min="0" max="1" step="0.05" value={volume}
            data-testid="track-volume" aria-label="재생 볼륨 (듣기 전용, 원본에 영향 없음)"
            onChange={(e) => changeVolume(parseFloat(e.target.value))}
            onPointerUp={commitVolume} onKeyUp={commitVolume} onBlur={commitVolume}
            style={{ width: 56, accentColor: color, cursor: 'pointer', height: 4 }} />
        </div>
        <button onClick={onClose} title="재생 닫기" aria-label="재생 닫기" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, borderRadius: 6, border: 'none', cursor: 'pointer',
          background: 'var(--bg-elevated)', color: 'var(--text-secondary)', flexShrink: 0
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export const TRACK_STYLES: Record<string, { color: string; glow: string }> = {
  vocals:      { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' },
  instrumental:{ color: '#60a5fa', glow: 'rgba(96,165,250,0.12)' },
  drums:     { color: '#fbbf24', glow: 'rgba(251,191,36,0.12)' },
  bass:      { color: '#34d399', glow: 'rgba(52,211,153,0.12)' },
  other:     { color: '#60a5fa', glow: 'rgba(96,165,250,0.12)' },
  // 화자 트랙: 화자 수 선택은 2~5명(Options.tsx)이므로 a~e 를 모두 채운다.
  // c/d/e 가 비어 있으면 DEFAULT_STYLE(= speaker_a 와 같은 보라)로 떨어져
  // 3명 이상일 때 트랙을 색으로 구분할 수 없었다. 결정적 매핑(해시·난수 없음),
  // 색상은 기존 팔레트 규약(400 계열 hex + 같은 색 rgba glow)을 따른다.
  speaker_a: { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' },  // violet
  speaker_b: { color: '#22d3ee', glow: 'rgba(34,211,238,0.15)' },   // cyan
  speaker_c: { color: '#fbbf24', glow: 'rgba(251,191,36,0.15)' },   // amber
  speaker_d: { color: '#4ade80', glow: 'rgba(74,222,128,0.15)' },   // green
  speaker_e: { color: '#f472b6', glow: 'rgba(244,114,182,0.15)' },  // pink
  transcript:{ color: '#34d399', glow: 'rgba(52,211,153,0.12)' },
  translation:{ color: '#22d3ee', glow: 'rgba(34,211,238,0.15)' },
}
export const DEFAULT_STYLE = { color: '#a78bfa', glow: 'rgba(167,139,250,0.15)' }

export const actionBtnStyle = (active: boolean, color: string): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 4, padding: '6px 10px',
  borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600,
  fontFamily: 'inherit', transition: 'all 0.15s',
  background: active ? `${color}20` : 'var(--bg-elevated)',
  color: active ? color : 'var(--text-secondary)'
})


/** 결과 이름에 맞는 색. 모르는 이름이면 기본색(모델마다 트랙이 달라도 무너지지 않는다). */
export function styleOf(name: string): { color: string; glow: string } {
  return TRACK_STYLES[name] || DEFAULT_STYLE
}
