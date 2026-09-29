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
import { speakableText } from '../../shared/readerText'
import { opLog, nameOnly } from '@/lib/opLog'
import {
  emptyQueue, nextToMake, canPlayNow, waitReason, markMaking, markReady, markFailed,
  seek, advance, atEnd, changeVoice, acceptResult, retryFailed, DEFAULT_AHEAD, usesGpu, type QueueState,
} from '../../shared/readerQueue'

export interface ReaderVoicePick {
  kind: 'builtin' | 'reference'
  path: string
  engineId?: string
  /** 화면에 보일 이름. */
  label: string
}

/** 무엇으로 만들었는지 가리키는 지문. 바뀌면 만들어 둔 것을 버린다. */
/**
 * 앞서 몇 덩이를 만들어 둘까.
 * ★기본 목소리는 한 덩이(20초 분량)에 2초다 — **여섯**(약 2분)을 늘 앞서 둔다 (2026-09-30 피드백:
 *   "읽다가 멈추고 다시 생성하고 하는 과정이 갑갑하다"). 예전 둘은 한 번만 늦어도 소리가 끊겼다.
 * ★참조 목소리는 한 덩이에 40~90초 GPU 를 쓴다 — 멀리 앞서 만들면 옮길 때 버리는 것이 크다. 둘 그대로.
 */
export const BUILTIN_AHEAD = 6
function aheadFor(v: ReaderVoicePick | null): number {
  // ★GPU 로 느린 목소리(참조 · Qwen 지정 목소리)는 적게 앞서 둔다 — 멀리 앞서 만들면 옮길 때 버리는 것이 크다.
  return v && !usesGpu(v) ? BUILTIN_AHEAD : DEFAULT_AHEAD
}

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

export function useReadAloud(
  text: string, voice: ReaderVoicePick | null,
  opts: { skipHanjaInParens?: boolean } = {},
): ReadAloud {
  // ★고른 시작 자리는 **덩이의 경계**가 된다 — 덩이 한가운데를 고르면 그 앞 문단부터 읽었다(2026-09-30 재현).
  //   글이 바뀌면 경계도 처음으로(같은 렌더에서 — 옛 책의 자리를 새 책에 쓰지 않는다).
  const [cut, setCut] = useState<{ text: string; at: number }>({ text, at: 0 })
  const breakAt = cut.text === text ? cut.at : 0
  const chunks = useMemo(() => splitForReading(text, { breakAt }), [text, breakAt])
  const skipHanja = !!opts.skipHanjaInParens
  // ★두 열쇠를 나눈다. 본체의 쌓아 두기는 **목소리 + 실제로 읽은 글**로 이름 붙이므로
  //   목소리만 넘긴다(한자가 없는 덩이는 설정을 바꿔도 다시 만들지 않는다).
  //   큐는 설정까지 본다 — 설정이 바뀌면 만들어 둔 것을 버리고 지금 자리를 다시 읽는다.
  const cacheKey = voiceKeyOf(voice)
  const voiceKey = cacheKey && skipHanja ? `${cacheKey}|괄호한자뺌` : cacheKey
  const [q, setQ] = useState<QueueState>(() => emptyQueue(chunks.length, voiceKey, aheadFor(voice)))
  const [playing, setPlaying] = useState(false)
  const [fault, setFault] = useState('')

  const qRef = useRef(q); qRef.current = q
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const aliveRef = useRef(true)
  /**
   * 지금 가 있는 요청 — **같은 목소리·같은 글이면 그 답을 함께 받는다.** 두 번 보내지 않는다.
   * ★건너뛰지 않고 '함께 받는다' 인 이유: 건너뛰면 그 자리가 '만드는 중' 이 아니게 되어
   *   답이 와도 받을 곳이 없다. 처음엔 건너뛰게 만들었다가 StrictMode 에서 첫 덩이가
   *   '차례를 기다리는 중' 에 멈췄다(실측). 목소리를 A→B→A 로 바꾸는 장면도 같은 구조라
   *   `reader-aloud.component.mjs` 2-1 이 붙든다.
   */
  const asking = useRef(new Map<string, Promise<{ data?: { path: string; cached: boolean }; error?: string }>>())
  const claim = useAppStore((s) => s.audioClaim)

  const stopAudio = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    try { el.pause() } catch { /* 이미 멈춤 */ }
    el.onended = null
    el.onerror = null
  }, [])

  // 글이 바뀌면 처음부터. 목소리가 바뀌면 만들어 둔 것을 버리되 **자리는 지킨다.**
  // ★**정말 바뀌었을 때만** 비운다. 개발 실행(StrictMode)은 효과를 두 번 돌리는데, 그때마다
  //   비우면 막 '만드는 중' 으로 올린 자리가 지워져 답이 와도 받을 곳이 없다.
  const builtFor = useRef(chunks)
  useEffect(() => {
    if (builtFor.current === chunks) return
    builtFor.current = chunks
    // 경계가 바뀐 것이면 그 자리에서, 글이 바뀐 것이면 처음에서.
    const start = Math.max(0, chunkAt(chunks, breakAt))
    setQ({ ...emptyQueue(chunks.length, voiceKey, aheadFor(voice)), at: start }); setFault('')
  }, [chunks])
  // ★목소리를 바꾸면 **곧바로** 적용한다 (2026-09-29 사용자 신고: "선택하면 적용이 되지 않는다").
  //   예전에는 옛 목소리 소리가 그 덩이 끝까지 이어졌다 — 고른 것과 다른 목소리를 들려준 셈이다.
  //   지금 소리를 멈추고, 같은 자리를 새 목소리로 만들어 다시 읽는다.
  const voiceSeen = useRef(voiceKey)
  useEffect(() => {
    if (voiceSeen.current === voiceKey) return
    voiceSeen.current = voiceKey
    if (voice) opLog('reader', `목소리·설정 바꿈 — ${voice.kind}:${nameOnly(voice.path)}${skipHanja ? ' · 괄호 속 한자 뺌' : ''}`)
    stopAudio()
    // 새 목소리는 새 시도다 — 지난 목소리의 오류 문구를 남겨 두지 않는다.
    setFault('')
    setQ((cur) => ({ ...changeVoice(cur, voiceKey), ahead: aheadFor(voice) }))
  }, [voiceKey, stopAudio])

  const stop = useCallback(() => {
    opLog('reader', `멈춤 — 덩이 ${qRef.current.at + 1}/${qRef.current.count}`)
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
  //   누르는 순간 바로 들린다. GPU 목소리(참조 · Qwen 지정 목소리)는 수십 초가 들어 누를 때만 만든다.
  useEffect(() => {
    if (!voice) return
    if (!playing && usesGpu(voice)) return
    const i = nextToMake(q)
    if (i < 0) return
    const chunk = chunks[i]
    if (!chunk) return
    const madeFor = voiceKey
    // ★소리로 보낼 때만 규칙을 탄다 — 보이는 글과 글자 자리는 그대로다.
    const say = speakableText(chunk.text, { skipHanjaInParens: skipHanja })
    if (!say.trim()) {
      // 읽을 것이 남지 않은 덩이(괄호 속 한자뿐) — 소리 없이 지나간다.
      setQ((cur) => markReady(cur, i, ''))
      return
    }
    // ★같은 목소리·같은 글로 **이미 가 있는 요청**이면 새로 보내지 않고 그 답을 받는다.
    //   개발 실행(StrictMode)은 이 효과를 두 번 돌려 같은 요청이 두 번 나갔다(검사로 확인).
    const ask = `${madeFor}\n${say}`
    let run = asking.current.get(ask)
    if (!run) {
      run = window.api.reader.speak(say, { kind: voice.kind, path: voice.path, engineId: voice.engineId }, cacheKey)
      asking.current.set(ask, run)
      void run.finally(() => { asking.current.delete(ask) }).catch(() => { /* 아래에서 받는다 */ })
    }
    setQ((cur) => markMaking(cur, i))
    void run
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
  }, [playing, q, chunks, voice, voiceKey, cacheKey, skipHanja])

  // ── 지금 것을 튼다 ──────────────────────────────────────────────────────
  // ★같은 덩이를 **두 번 틀지 않는다.** 이 효과는 큐가 바뀔 때마다 다시 도는데
  //   (뒤엣것을 만들어 두면 `items` 가 바뀐다), 그때마다 다시 틀면 듣던 것이
  //   처음으로 되돌아간다. 무엇을 틀었는지 기억한다.
  const playedRef = useRef('')
  useEffect(() => {
    if (!playing) { playedRef.current = ''; return }
    const it = q.items[q.at]
    if (!it) { setPlaying(false); return }
    if (it.state === 'failed') {
      const why = it.why || '이 부분을 만들지 못했습니다'
      opLog('reader', `오류로 멈춤 — 덩이 ${q.at + 1}/${q.count}: ${why}`, 'WARN')
      setFault(why); setPlaying(false); return
    }
    if (it.state === 'ready' && !it.path) {
      // 소리 없이 지나가는 덩이 — 멈추지 않고 다음으로. 마지막이면 멈춘다.
      if (atEnd(q)) setPlaying(false)
      else setQ((cur) => advance(cur))
      return
    }
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
      if (atEnd(qRef.current)) { opLog('reader', `끝까지 읽음 — ${qRef.current.count}덩이`); setPlaying(false); return }
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
    }).catch((e) => {
      if (!aliveRef.current) return
      // ★막 시작한 재생을 **멈춤이 끊으면** 브라우저는 AbortError 로 알린다 — 실패가 아니다.
      //   예전에는 이것을 실패로 읽어 낭독을 껐다. 목소리를 바꾸거나 문단을 누르는 순간이
      //   재생 시작과 겹치면 "재생을 시작하지 못했습니다" 로 멈췄다(실측: 10번 중 1~5번).
      //   이미 다른 덩이로 넘어간 뒤의 거절도 지금 것의 실패가 아니다.
      if ((e as { name?: string } | null)?.name === 'AbortError' || playedRef.current !== tag) return
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
    // ★동작 기록 — 글 내용은 적지 않는다. 자리·목소리 종류·파일 이름·설정만.
    opLog('reader', `시작 — 덩이 ${qRef.current.at + 1}/${chunks.length} · 목소리 ${voice.kind}:${nameOnly(voice.path)}${skipHanja ? ' · 괄호 속 한자 뺌' : ''}`)
    setPlaying(true)
  }, [voice, chunks.length, skipHanja])

  const seekToChar = useCallback((charIndex: number) => {
    const c = Math.max(0, charIndex)
    if (chunkAt(chunks, c) < 0) return
    stopAudio()
    setFault('')
    if (c === breakAt) {
      // 이미 그 자리에서 끊겨 있다 — 자리만 옮긴다.
      const i = chunkAt(chunks, c)
      setQ((cur) => seek(cur, i))
      return
    }
    // 새 경계 — 덩이가 다시 나뉘고, 위 효과가 그 자리로 옮긴다.
    setCut({ text, at: c })
  }, [chunks, breakAt, text, stopAudio])

  const next = useCallback(() => { stopAudio(); setQ((cur) => advance(cur)) }, [stopAudio])
  const prev = useCallback(() => { stopAudio(); setQ((cur) => seek(cur, cur.at - 1)) }, [stopAudio])

  return {
    chunks, at: q.at, playing,
    wait: playing && !canPlayNow(q) ? waitReason(q) : '',
    fault, start, stop, seekToChar, next, prev,
  }
}
