/**
 * 낭독 — **듣는 동안 뒤를 만든다.**
 *
 * ★지시 (2026-09-29): 책을 읽어 주는 플레이어. 기본 목소리 또는 고른 목소리로.
 *
 * 이 훅이 맡는 것
 *   · 글을 덩이로 나눈다(`readerChunks` 규칙)
 *   · 지금 것을 틀고, 그 동안 **앞선 것부터** 만들어 둔다(`readerQueue` 규칙)
 *   · 끝나면 다음으로 넘어간다. 마지막이면 멈춘다
 *   · 목소리가 바뀌면 만들어 둔 것을 버린다 — 옛 목소리 소리를 들려주지 않는다
 *
 * ★소리는 **한 번에 한 곳만.** 공용 규칙에 `reader` 로 참여한다 —
 *   다른 화면이 소리를 가져가면 여기서 멈춘다.
 * ★판단은 전부 `readerChunks`·`readerQueue` 가 한다. 여기서는 **잇기만** 한다 —
 *   그래야 규칙을 시계도 GPU도 없이 검사할 수 있다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/stores/app.store'
import { createManagedAudio } from '@/lib/playbackVolume'
import { splitForReading, chunkAt, type Chunk } from '../../shared/readerChunks'
import {
  emptyQueue, nextToMake, canPlayNow, waitReason, markMaking, markReady, markFailed,
  seek, advance, atEnd, changeVoice, acceptResult, retryFailed, type QueueState,
} from '../../shared/readerQueue'

export interface ReaderVoicePick {
  kind: 'builtin' | 'reference'
  path: string
  engineId?: string
  /** 화면에 보일 이름. */
  label: string
}

/** 무엇으로 만들었는지 가리키는 지문. 바뀌면 만들어 둔 것을 버린다. */
export function voiceKeyOf(v: ReaderVoicePick | null): string {
  return v ? `${v.kind}:${v.engineId || ''}:${v.path}` : ''
}

export interface ReadAloud {
  chunks: Chunk[]
  /** 지금 읽는 덩이 번호. */
  at: number
  playing: boolean
  /** 왜 소리가 안 나는가 — 빈 글이면 아무 문제 없다. */
  wait: string
  /** 만들지 못한 사유 등 사용자에게 보일 한 줄. */
  fault: string
  start: () => void
  stop: () => void
  /** 원문 글자 자리로 건너뛴다(본문에서 문단을 눌렀을 때). */
  seekToChar: (charIndex: number) => void
  next: () => void
  prev: () => void
}

export function useReadAloud(text: string, voice: ReaderVoicePick | null): ReadAloud {
  const chunks = useMemo(() => splitForReading(text), [text])
  const voiceKey = voiceKeyOf(voice)
  const [q, setQ] = useState<QueueState>(() => emptyQueue(chunks.length, voiceKey))
  const [playing, setPlaying] = useState(false)
  const [fault, setFault] = useState('')

  const qRef = useRef(q); qRef.current = q
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const aliveRef = useRef(true)
  const claim = useAppStore((s) => s.audioClaim)

  const stopAudio = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    try { el.pause() } catch { /* 이미 멈춤 */ }
    el.onended = null
    el.onerror = null
  }, [])

  // 글이 바뀌면 처음부터. 목소리가 바뀌면 만들어 둔 것을 버리되 **자리는 지킨다.**
  useEffect(() => { setQ(emptyQueue(chunks.length, voiceKey)); setFault('') }, [chunks])
  // ★목소리를 바꾸면 **곧바로** 적용한다 (2026-09-29 사용자 신고: "선택하면 적용이 되지 않는다").
  //   예전에는 옛 목소리 소리가 그 덩이 끝까지 이어졌다 — 고른 것과 다른 목소리를 들려준 셈이다.
  //   지금 소리를 멈추고, 같은 자리를 새 목소리로 만들어 다시 읽는다.
  const voiceSeen = useRef(voiceKey)
  useEffect(() => {
    if (voiceSeen.current === voiceKey) return
    voiceSeen.current = voiceKey
    stopAudio()
    setQ((cur) => changeVoice(cur, voiceKey))
  }, [voiceKey, stopAudio])

  const stop = useCallback(() => {
    setPlaying(false)
    stopAudio()
  }, [stopAudio])

  // ★소리는 한 번에 한 곳만. 다른 화면이 가져가면 여기서 멈춘다.
  useEffect(() => {
    if (playing && claim && claim.owner !== 'reader') stop()
  }, [claim, playing, stop])

  // ★붙을 때마다 **다시 살린다** (2026-09-29 사용자 신고: "첫 줄만 읽고 꺼진다").
  //   개발 실행은 StrictMode 라 React 가 화면을 붙였다 떼었다 다시 붙인다. 예전에는
  //   뗄 때 끄기만 하고 다시 켜지 않아서, **만든 소리를 받아도 전부 버렸다** —
  //   재현: StrictMode 안 재생 0회 · 밖 8회. 검사는 배포 빌드로만 돌아 보지 못했다.
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false; stopAudio() }
  }, [stopAudio])

  // ── 앞서 만들어 둔다 ────────────────────────────────────────────────────
  // ★기본 목소리는 **누르기 전에도** 지금 자리부터 만들어 둔다 (2026-09-29 지시:
  //   "텍스트를 읽어오면 빠르게 낭독 음성을 만들어서"). 한 덩이에 2초라 부담이 작고,
  //   누르는 순간 바로 들린다. 참조 목소리는 GPU 로 수십 초가 들어 누를 때만 만든다.
  useEffect(() => {
    if (!voice) return
    if (!playing && voice.kind !== 'builtin') return
    const i = nextToMake(q)
    if (i < 0) return
    const chunk = chunks[i]
    if (!chunk) return
    const madeFor = voiceKey
    setQ((cur) => markMaking(cur, i))
    void window.api.reader.speak(chunk.text, { kind: voice.kind, path: voice.path, engineId: voice.engineId }, madeFor)
      .then((r) => {
        if (!aliveRef.current) return
        // ★늦게 온 결과가 새 목소리의 자리를 덮지 않는다.
        if (!acceptResult(qRef.current, i, madeFor)) return
        if (r.error || !r.data?.path) {
          setQ((cur) => markFailed(cur, i, r.error || '이 부분을 만들지 못했습니다'))
          return
        }
        setQ((cur) => markReady(cur, i, r.data!.path))
      })
      .catch((e) => {
        if (!aliveRef.current) return
        if (!acceptResult(qRef.current, i, madeFor)) return
        setQ((cur) => markFailed(cur, i, (e as Error)?.message || '이 부분을 만들지 못했습니다'))
      })
  }, [playing, q, chunks, voice, voiceKey])

  // ── 지금 것을 튼다 ──────────────────────────────────────────────────────
  // ★같은 덩이를 **두 번 틀지 않는다.** 이 효과는 큐가 바뀔 때마다 다시 도는데
  //   (뒤엣것을 만들어 두면 `items` 가 바뀐다), 그때마다 다시 틀면 듣던 것이
  //   처음으로 되돌아간다. 무엇을 틀었는지 기억한다.
  const playedRef = useRef('')
  useEffect(() => {
    if (!playing) { playedRef.current = ''; return }
    const it = q.items[q.at]
    if (!it) { setPlaying(false); return }
    if (it.state === 'failed') { setFault(it.why || '이 부분을 만들지 못했습니다'); setPlaying(false); return }
    if (it.state !== 'ready' || !it.path) return
    const tag = `${q.at}:${it.path}`
    if (playedRef.current === tag) return
    playedRef.current = tag

    const el = audioRef.current || createManagedAudio()
    audioRef.current = el
    useAppStore.getState().claimAudio('reader')
    el.onended = () => {
      if (!aliveRef.current) return
      // 마지막이면 멈춘다 — 조용히 처음으로 돌아가지 않는다.
      if (atEnd(qRef.current)) { setPlaying(false); return }
      setQ((cur) => advance(cur))
    }
    el.onerror = () => {
      if (!aliveRef.current) return
      setFault('만들어 둔 소리를 열지 못했습니다')
      setPlaying(false)
    }
    // ★주소는 **본체에게 묻는다.** 화면이 직접 만들면 규칙이 갈리고, 자리가 바뀐 날
    //   조용히 열지 못한다 — 2026-09-29 에 실제로 그랬다(소리는 만들었는데 안 났다).
    void window.api.audio.getFileUrl(it.path).then((url) => {
      if (!aliveRef.current || playedRef.current !== tag) return
      if (el.src !== url) el.src = url
      return el.play()
    }).catch(() => {
      if (!aliveRef.current) return
      setFault('재생을 시작하지 못했습니다')
      setPlaying(false)
    })
  }, [playing, q.at, q.items])

  const start = useCallback(() => {
    if (!voice) { setFault('먼저 목소리를 고르세요'); return }
    if (!chunks.length) { setFault('읽을 글이 없습니다'); return }
    setFault('')
    // ★다시 누르는 것은 "이제 될 것 같다" 는 뜻이다. 거절당해 굳은 것을 풀어 준다 —
    //   풀지 않으면 다른 작업이 끝나도 그 자리에 갇힌다.
    setQ((cur) => retryFailed(cur))
    setPlaying(true)
  }, [voice, chunks.length])

  const seekToChar = useCallback((charIndex: number) => {
    const i = chunkAt(chunks, Math.max(0, charIndex))
    if (i < 0) return
    stopAudio()
    setFault('')
    setQ((cur) => seek(cur, i))
  }, [chunks, stopAudio])

  const next = useCallback(() => { stopAudio(); setQ((cur) => advance(cur)) }, [stopAudio])
  const prev = useCallback(() => { stopAudio(); setQ((cur) => seek(cur, cur.at - 1)) }, [stopAudio])

  return {
    chunks, at: q.at, playing,
    wait: playing && !canPlayNow(q) ? waitReason(q) : '',
    fault, start, stop, seekToChar, next, prev,
  }
}
