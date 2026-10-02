/**
 * 낭독 — **듣는 동안 뒤를 만든다.**
 *
 * ★지시 (2026-09-29): 책을 읽어 주는 플레이어. 기본 목소리 또는 고른 목소리로.
 *
 * 이 훅이 맡는 것
 *   · 글을 덩이로 나눈다(`readerChunks` 규칙) — 읽기 시작한 자리의 첫 덩이들은 짧게(첫 소리가 빨리 난다)
 *   · 지금 것을 틀고, 그 동안 **앞선 것부터** 만들어 둔다(`readerQueue` 규칙)
 *   · 다음 덩이는 **미리 불러 둔 두 번째 소리 요소**로 넘어간다 — 덩이 사이가 끊기지 않는다(2026-10-01)
 *   · 소리 안에서 **지금 읽는 구절**을 안다(`readerTiming` — 본체가 만든 소리의 쉼으로 잰다)
 *   · 끝나면 다음으로 넘어간다. 마지막이면 멈춘다
 *   · 목소리가 바뀌면 만들어 둔 것을 버린다 — 옛 목소리 소리를 들려주지 않는다
 *
 * ★소리는 **한 번에 한 곳만.** 공용 규칙에 `reader` 로 참여한다 —
 *   다른 화면이 소리를 가져가면 여기서 멈춘다.
 * ★판단은 전부 `readerChunks`·`readerQueue`·`readerTiming` 이 한다. 여기서는 **잇기만** 한다 —
 *   그래야 규칙을 시계도 GPU도 없이 검사할 수 있다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/stores/app.store'
import { createManagedAudio } from '@/lib/playbackVolume'
import { splitForReading, chunkAt, START_RAMP_SECONDS, type Chunk } from '../../shared/readerChunks'
import { readingPlan, type ReadingPart } from '../../shared/readerText'
import { partAt } from '../../shared/readerTiming'
import { partEmotions, emotionRuns, runSay } from '../../shared/readerEmotion'
import { opLog, nameOnly } from '@/lib/opLog'
import { trace } from '@/lib/readerTrace'
import {
  emptyQueue, nextToMake, canPlayNow, waitReason, markMaking, markReady, markFailed,
  seek, advance, atEnd, changeVoice, acceptResult, retryFailed, DEFAULT_AHEAD, usesGpu, type QueueState,
} from '../../shared/readerQueue'

export interface ReaderVoicePick {
  kind: 'builtin' | 'reference'
  /** 기본 목소리는 모델 파일 자리, 내 목소리는 조각(또는 원본) 자리. ★기본 목소리를 저장본에서 되살릴 때는 목록에서 찾기 전까지 빈 글자다. */
  path: string
  engineId?: string
  /** 기본 목소리의 안정된 이름(엔진 안에서) — 저장·복원은 경로가 아니라 이것으로 찾는다. */
  modelId?: string
  /** 화면에 보일 이름. */
  label: string
}

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

/** 무엇으로 만들었는지 가리키는 지문. 바뀌면 만들어 둔 것을 버린다. */
export function voiceKeyOf(v: ReaderVoicePick | null): string {
  return v ? `${v.kind}:${v.engineId || ''}:${v.path}` : ''
}

/** 지금 읽는 구절 — 원문 글자 자리. 읽지 않을 때는 null. */
export interface ReadingSpot { start: number; end: number }

export interface ReadAloud {
  chunks: Chunk[]
  /** 지금 읽는 덩이 번호. */
  at: number
  playing: boolean
  /** 왜 소리가 안 나는가 — 빈 글이면 아무 문제 없다. */
  wait: string
  /** 만들지 못한 사유 등 사용자에게 보일 한 줄. */
  fault: string
  /**
   * 지금 **소리가 읽고 있는 구절**(원문 자리). 구절 시각을 모르면 덩이 전체.
   * ★2026-10-01 이전에는 늘 덩이 전체였다 — 약 20초 동안 한 자리에 서 있었다(사용자 신고).
   */
  spot: ReadingSpot | null
  /** 지금 소리가 닿은 **글자 하나**의 원문 자리 — 따라가기가 줄을 찾는다. 모르면 -1. 매 화면마다 불러도 가볍다. */
  caret: () => number
  start: () => void
  stop: () => void
  /** 원문 글자 자리로 건너뛴다(본문에서 문단을 눌렀을 때). */
  seekToChar: (charIndex: number) => void
  next: () => void
  prev: () => void
}

type Plan = { say: string; parts: ReadingPart[] }
/** 본체가 함께 돌려주는 단계 길이(본체 단조 시계, ms) — 관측 전용. */
type SpeakTrace = { cached?: boolean; shared?: boolean; waitMs?: number; makeMs?: number; modelOpened?: boolean | null; engine?: string }
/** 소리 요소에 붙여 두는 관측 표 — 어느 덩이를 어떤 길로 틀었나. */
type TraceTag = { chunk: number; gen: number; via: 'normal' | 'preloaded'; reported?: boolean }

export function useReadAloud(
  text: string, voice: ReaderVoicePick | null,
  opts: {
    skipHanjaInParens?: boolean
    /** 대사에 감정을 담아 읽는다 — 부르는 쪽이 'Qwen 지정 목소리 + 1.7B' 일 때만 켠다(2026-10-01). */
    emotion?: boolean
  } = {},
): ReadAloud {
  // ★고른 시작 자리는 **덩이의 경계**가 된다 — 덩이 한가운데를 고르면 그 앞 문단부터 읽었다(2026-09-30 재현).
  //   글이 바뀌면 경계도 처음으로(같은 렌더에서 — 옛 책의 자리를 새 책에 쓰지 않는다).
  const [cut, setCut] = useState<{ text: string; at: number }>({ text, at: 0 })
  const breakAt = cut.text === text ? cut.at : 0
  const chunks = useMemo(() => splitForReading(text, { breakAt, ramp: START_RAMP_SECONDS }), [text, breakAt])
  const skipHanja = !!opts.skipHanjaInParens
  // ★덩이마다 **구절 나누기와 소리로 보낼 글**(readerText.readingPlan). 큰 책은 덩이가 수천 개라 필요할 때만 만든다.
  const plans = useRef<{ chunks: Chunk[]; skip: boolean; map: Map<number, Plan> }>({ chunks, skip: skipHanja, map: new Map() })
  if (plans.current.chunks !== chunks || plans.current.skip !== skipHanja) plans.current = { chunks, skip: skipHanja, map: new Map() }
  const planOf = useCallback((i: number): Plan => {
    const m = plans.current.map
    let p = m.get(i)
    if (!p) { p = readingPlan(chunks[i]?.text || '', { skipHanjaInParens: skipHanja }); m.set(i, p) }
    return p
  }, [chunks, skipHanja])
  // ★두 열쇠를 나눈다. 본체의 쌓아 두기는 **목소리 + 실제로 읽은 글**로 이름 붙이므로
  //   목소리만 넘긴다(한자가 없는 덩이는 설정을 바꿔도 다시 만들지 않는다).
  //   큐는 설정까지 본다 — 설정이 바뀌면 만들어 둔 것을 버리고 지금 자리를 다시 읽는다.
  const cacheKey = voiceKeyOf(voice)
  const withEmotion = !!opts.emotion
  // 감정을 켜고 끄면 다른 소리다 — 큐가 만들어 둔 것을 버리고 지금 자리를 다시 읽는다.
  const voiceKey = (cacheKey && skipHanja ? `${cacheKey}|괄호한자뺌` : cacheKey) + (cacheKey && withEmotion ? '|감정' : '')
  const [q, setQ] = useState<QueueState>(() => emptyQueue(chunks.length, voiceKey, aheadFor(voice)))
  const [playing, setPlaying] = useState(false)
  const [fault, setFault] = useState('')
  /** 덩이마다 구절 시각(초) — 본체가 만든 소리에서 잰 것. 큐와 따로 둔다(큐 규칙을 건드리지 않는다). */
  const timings = useRef(new Map<number, Array<[number, number]>>())
  /** 지금 칠하는 구절 번호(덩이 안). 소리가 구절을 넘어갈 때만 바뀐다. */
  const [part, setPart] = useState(-1)

  const qRef = useRef(q); qRef.current = q
  const chunksRef = useRef(chunks); chunksRef.current = chunks
  /**
   * **낭독 세대** — 덩이를 다시 나누거나 목소리를 바꿀 때마다 하나 오른다. 요청 이름표 = `세대.번호`.
   * ★결과는 그 자리로 보낸 바로 그 요청이고, 세대와 글이 그대로일 때만 받는다(2026-10-03 — 다시 나눈 뒤 늦은 앞 답이 새 자리에 들어갔다).
   */
  const gen = useRef(0)
  const reqSeq = useRef(0)
  // ── 관측(재기만 한다 — lib/readerTrace) ──
  /** 마지막 '시작'·'문단 이동' 누름 — 다음 실제 재생 시작까지의 시간을 잰다. */
  const askedAt = useRef<{ t: number; kind: 'start' | 'seek' } | null>(null)
  /** 앞 덩이가 끝난 순간 — 다음 덩이 재생 시작까지의 틈. */
  const endedAt = useRef<number | null>(null)
  /** 재생 중 지금 덩이가 준비 안 된 상태가 시작된 때. */
  const lowSince = useRef<number | null>(null)
  const tags = useRef(new WeakMap<HTMLAudioElement, TraceTag>())
  const onPlayingTrace = (el: HTMLAudioElement) => {
    const tag = tags.current.get(el)
    if (!tag) return
    const now = performance.now()
    const first = !tag.reported
    tag.reported = true
    const asked = askedAt.current
    const gap = endedAt.current
    trace('play-start', {
      chunk: tag.chunk, gen: tag.gen, via: tag.via, first,
      sinceRequestMs: asked && first ? Math.round(now - asked.t) : undefined, after: asked && first ? asked.kind : undefined,
      gapMs: gap != null && first ? Math.round(now - gap) : undefined,
    }, now)
    if (first) { askedAt.current = null; endedAt.current = null }
    if (lowSince.current != null) { trace('buffer-low-end', { chunk: tag.chunk, lowMs: Math.round(now - lowSince.current) }, now); lowSince.current = null }
  }
  /** 소리 요소 둘 — 하나가 울리는 동안 다른 하나에 다음 덩이를 불러 둔다. */
  const els = useRef<HTMLAudioElement[]>([])
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** 미리 불러 둔 것 — `${덩이}:${파일}`. 비면 없다. */
  const preloaded = useRef('')
  const aliveRef = useRef(true)
  /**
   * 지금 가 있는 요청 — **같은 목소리·같은 글이면 그 답을 함께 받는다.** 두 번 보내지 않는다.
   * ★건너뛰지 않고 '함께 받는다' 인 이유: 건너뛰면 그 자리가 '만드는 중' 이 아니게 되어
   *   답이 와도 받을 곳이 없다. 처음엔 건너뛰게 만들었다가 StrictMode 에서 첫 덩이가
   *   '차례를 기다리는 중' 에 멈췄다(실측). 목소리를 A→B→A 로 바꾸는 장면도 같은 구조라
   *   `reader-aloud.component.mjs` 2-1 이 붙든다.
   */
  const asking = useRef(new Map<string, Promise<{ data?: { path: string; cached: boolean; timing?: Array<[number, number]>; trace?: SpeakTrace }; error?: string; trace?: SpeakTrace }>>())
  const claim = useAppStore((s) => s.audioClaim)

  const element = (k: 0 | 1): HTMLAudioElement => {
    // 재생 빠르기를 따른다(낭독 전용 — playbackVolume).
    if (!els.current[k]) {
      const el = createManagedAudio(undefined, { readAloud: true })
      // ★관측 전용 — 소리가 **실제로 흐르기 시작한** 순간(playing). 동작은 이것을 읽지 않는다.
      el.addEventListener('playing', () => onPlayingTrace(el))
      els.current[k] = el
    }
    return els.current[k]
  }
  const stopAudio = useCallback(() => {
    for (const el of els.current) {
      if (!el) continue
      try { el.pause() } catch { /* 이미 멈춤 */ }
      el.onended = null
      el.onerror = null
    }
    preloaded.current = ''
  }, [])

  // 글이 바뀌면 처음부터. 목소리가 바뀌면 만들어 둔 것을 버리되 **자리는 지킨다.**
  // ★**정말 바뀌었을 때만** 비운다. 개발 실행(StrictMode)은 효과를 두 번 돌리는데, 그때마다
  //   비우면 막 '만드는 중' 으로 올린 자리가 지워져 답이 와도 받을 곳이 없다.
  const builtFor = useRef(chunks)
  useEffect(() => {
    if (builtFor.current === chunks) return
    builtFor.current = chunks
    gen.current++
    timings.current = new Map()
    // 경계가 바뀐 것이면 그 자리에서, 글이 바뀐 것이면 처음에서.
    const start = Math.max(0, chunkAt(chunks, breakAt))
    trace('resplit', { gen: gen.current, chunk: start, count: chunks.length })
    setQ({ ...emptyQueue(chunks.length, voiceKey, aheadFor(voice)), at: start }); setFault('')
  }, [chunks])
  // ★목소리를 바꾸면 **곧바로** 적용한다 (2026-09-29 사용자 신고: "선택하면 적용이 되지 않는다").
  //   예전에는 옛 목소리 소리가 그 덩이 끝까지 이어졌다 — 고른 것과 다른 목소리를 들려준 셈이다.
  //   지금 소리를 멈추고, 같은 자리를 새 목소리로 만들어 다시 읽는다.
  const voiceSeen = useRef(voiceKey)
  useEffect(() => {
    if (voiceSeen.current === voiceKey) return
    voiceSeen.current = voiceKey
    gen.current++
    trace('voice-change', { gen: gen.current, kind: voice?.kind, engine: voice?.engineId || '' })
    if (voice) opLog('reader', `목소리·설정 바꿈 — ${voice.kind}:${nameOnly(voice.path)}${skipHanja ? ' · 괄호 속 한자 뺌' : ''}`)
    stopAudio()
    timings.current = new Map()
    // 새 목소리는 새 시도다 — 지난 목소리의 오류 문구를 남겨 두지 않는다.
    setFault('')
    setQ((cur) => ({ ...changeVoice(cur, voiceKey), ahead: aheadFor(voice) }))
  }, [voiceKey, stopAudio])
  // ★기본 목소리(CPU)는 **고르자마자 미리 연다** — 첫 조각이 모델 열기를 기다리지 않는다(2026-10-01).
  //   GPU 목소리는 여기서 열지 않는다(그래픽카드 메모리를 잡는다) — 사용자가 고를 때 화면이 따로 부른다.
  useEffect(() => {
    if (!voice || voice.kind !== 'builtin' || usesGpu(voice)) return
    void window.api.reader.warm?.({ kind: voice.kind, path: voice.path, engineId: voice.engineId })?.catch(() => { /* 누를 때 연다 */ })
  }, [cacheKey])

  const stop = useCallback(() => {
    opLog('reader', `멈춤 — 덩이 ${qRef.current.at + 1}/${qRef.current.count}`)
    trace('stop', { chunk: qRef.current.at, gen: gen.current })
    askedAt.current = null; lowSince.current = null
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
    // ★소리로 보낼 때만 규칙을 탄다 — 보이는 글과 글자 자리는 그대로다. 구절 무게도 함께 보낸다(따라가기).
    const plan = planOf(i)
    const say = plan.say
    if (!say.trim()) {
      // 읽을 것이 남지 않은 덩이(괄호 속 한자뿐) — 소리 없이 지나간다.
      setQ((cur) => markReady(cur, i, ''))
      return
    }
    // ★같은 목소리·같은 글로 **이미 가 있는 요청**이면 새로 보내지 않고 그 답을 받는다.
    //   개발 실행(StrictMode)은 이 효과를 두 번 돌려 같은 요청이 두 번 나갔다(검사로 확인).
    const ask = `${madeFor}\n${withEmotion ? '감정|' : ''}${say}`
    let run = asking.current.get(ask)
    const shared = !!run
    if (!run) {
      // ★감정 담아 읽기 — 같은 감정의 이웃 구절을 덩어리로 묶어 덩어리마다 보낸다(감정이 없어도 보낸다 — 덩이 전체가 같은 모델이 되게).
      const segments = withEmotion
        ? emotionRuns(plan.parts, partEmotions(chunk.text, plan.parts,
          // 앞뒤 덩이의 끝·처음 — 덩이 경계에서 대사와 그 서술이 갈려도 단서를 잃지 않게
          { before: chunks[i - 1]?.text.slice(-200), after: chunks[i + 1]?.text.slice(0, 200) })).map((r) => ({ text: runSay(chunk.text, plan.parts, r), emotion: r.emotion }))
        : undefined
      run = window.api.reader.speak(say, { kind: voice.kind, path: voice.path, engineId: voice.engineId }, cacheKey,
        plan.parts.map((p) => ({ weight: p.weight, strong: p.strong })), segments)
      asking.current.set(ask, run)
      void run.finally(() => { asking.current.delete(ask) }).catch(() => { /* 아래에서 받는다 */ })
    }
    const madeGen = gen.current
    const req = `${madeGen}.${++reqSeq.current}`
    const madeText = chunk.text
    // ★받는 조건 — 같은 목소리 · 이 자리로 보낸 **바로 이 요청** · 같은 세대 · 같은 글. 하나라도 다르면 성공도 오류도 버린다.
    const mine = () => acceptResult(qRef.current, i, madeFor, req) && gen.current === madeGen && chunksRef.current[i]?.text === madeText
    trace('gen-request', { req, gen: madeGen, chunk: i, chars: say.length, kind: voice.kind, engine: voice.engineId || '', shared })
    setQ((cur) => markMaking(cur, i, req))
    void run
      .then((r) => {
        // 관측 — 받아들였는지와 본체 단계 길이. 생성 시작은 응답 시각에서 생성 길이를 뺀 이 창의 시각(derived).
        const now = performance.now()
        const tr: SpeakTrace = r.data?.trace || r.trace || {}
        const accepted = aliveRef.current && mine()
        if (tr.makeMs && !tr.cached) trace('gen-start', { req, gen: madeGen, chunk: i, derived: true }, now - tr.makeMs)
        trace('gen-done', { req, gen: madeGen, chunk: i, ok: !r.error && !!r.data?.path, cached: !!tr.cached, shared: !!tr.shared || shared,
          modelOpened: tr.modelOpened ?? null, waitMs: tr.waitMs, makeMs: tr.makeMs, engine: tr.engine, accepted }, now)
        if (!aliveRef.current) return
        // ★늦게 온 결과가 새 목소리·새 덩이의 자리를 덮지 않는다.
        if (!mine()) return
        if (r.error || !r.data?.path) {
          setQ((cur) => markFailed(cur, i, r.error || '이 부분을 만들지 못했습니다'))
          return
        }
        const t = r.data.timing
        if (Array.isArray(t) && t.length === plan.parts.length) timings.current.set(i, t)
        setQ((cur) => markReady(cur, i, r.data!.path))
      })
      .catch((e) => {
        trace('gen-done', { req, gen: madeGen, chunk: i, ok: false, accepted: aliveRef.current && mine() })
        if (!aliveRef.current) return
        if (!mine()) return
        setQ((cur) => markFailed(cur, i, (e as Error)?.message || '이 부분을 만들지 못했습니다'))
      })
  }, [playing, q, chunks, voice, voiceKey, cacheKey, planOf, withEmotion])

  /** 이 소리 요소가 덩이 at 을 틀 때의 끝·오류 처리. */
  const attach = useCallback((el: HTMLAudioElement) => {
    el.onended = () => {
      if (!aliveRef.current) return
      endedAt.current = performance.now()
      const cur = qRef.current
      // 마지막이면 멈춘다 — 조용히 처음으로 돌아가지 않는다.
      if (atEnd(cur)) { opLog('reader', `끝까지 읽음 — ${cur.count}덩이`); setPlaying(false); return }
      // ★다음 덩이를 미리 불러 둔 요소가 있으면 **곧바로** 튼다 — 화면이 다시 그려지기를 기다리지 않는다.
      const nx = cur.items[cur.at + 1]
      const tag = nx?.path ? `${cur.at + 1}:${nx.path}` : ''
      if (tag && preloaded.current === tag) {
        const other = els.current.find((x) => x && x !== el)
        if (other) {
          preloaded.current = ''
          audioRef.current = other
          playedRef.current = tag
          tags.current.set(other, { chunk: cur.at + 1, gen: gen.current, via: 'preloaded' })
          attach(other)
          void other.play().catch((e) => {
            if ((e as { name?: string } | null)?.name === 'AbortError') return
            playedRef.current = ''           // 아래 재생 효과가 보통 길로 다시 튼다
          })
        }
      }
      setQ((c) => advance(c))
    }
    el.onerror = () => {
      if (!aliveRef.current) return
      setFault('만들어 둔 소리를 열지 못했습니다')
      setPlaying(false)
    }
  }, [])

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

    const el = audioRef.current || element(0)
    audioRef.current = el
    tags.current.set(el, { chunk: q.at, gen: gen.current, via: 'normal' })
    useAppStore.getState().claimAudio('reader')
    attach(el)
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

  // 관측 — 재생 중인데 지금 덩이가 준비되지 않았다(버퍼 부족). 끝은 다음 실제 재생 시작(onPlayingTrace).
  const short = playing && !canPlayNow(q) && q.items[q.at]?.state !== 'failed'
  useEffect(() => {
    if (!short || lowSince.current != null) return
    lowSince.current = performance.now()
    // 시작·이동 직후의 기다림은 '첫 소리 대기' 다 — 재생 도중의 부족과 구분한다(initial).
    trace('buffer-low-start', { chunk: q.at, gen: gen.current, initial: !!askedAt.current, state: q.items[q.at]?.state || '' }, lowSince.current)
  }, [short, q.at])

  // ── 다음 덩이를 미리 불러 둔다(끊김 없이 넘어가기) ─────────────────────────
  // ★덩이 사이에서 예전에는 [끝 → 화면 다시 그림 → 본체에 주소 묻기 → 불러오기 → 틀기] 를 차례로 했다.
  //   다른 소리 요소에 미리 불러 두면 끝나는 순간 곧바로 이어진다.
  useEffect(() => {
    if (!playing) return
    const nx = q.items[q.at + 1]
    if (!nx || nx.state !== 'ready' || !nx.path) return
    const tag = `${q.at + 1}:${nx.path}`
    if (preloaded.current === tag) return
    const cur = audioRef.current
    const other = (cur === els.current[0] ? element(1) : cur === els.current[1] ? element(0) : element(1))
    if (other === cur) return
    void window.api.audio.getFileUrl(nx.path).then((url) => {
      if (!aliveRef.current) return
      const now = qRef.current
      if (now.at + 1 !== Number(tag.split(':')[0])) return      // 그 사이 자리가 옮겨졌다
      try { other.pause() } catch { /* 이미 멈춤 */ }
      other.onended = null; other.onerror = null
      other.preload = 'auto'
      if (other.src !== url) other.src = url
      try { other.currentTime = 0 } catch { /* 아직 못 불렀다 */ }
      preloaded.current = tag
    }).catch(() => { /* 넘어갈 때 보통 길로 튼다 */ })
  }, [playing, q.at, q.items])

  // ── 지금 읽는 구절 ──────────────────────────────────────────────────────
  // 소리 요소의 시각을 구절 시각에 대 본다. 구절이 바뀔 때만 화면을 다시 그린다.
  const caretRef = useRef<() => number>(() => -1)
  const posNow = (): { part: number; frac: number } | null => {
    const el = audioRef.current
    const spans = timings.current.get(qRef.current.at)
    if (!el || !spans?.length) return null
    return partAt(spans, el.currentTime)
  }
  caretRef.current = () => {
    const c = chunks[qRef.current.at]
    if (!c) return -1
    const p = posNow()
    if (!p) return c.start
    const pr = planOf(qRef.current.at).parts[p.part]
    if (!pr) return c.start
    return c.start + pr.from + Math.min(pr.to - pr.from - 1, Math.max(0, Math.floor((pr.to - pr.from) * p.frac)))
  }
  useEffect(() => {
    if (!playing) { setPart(-1); return }
    let raf = 0
    const tick = () => {
      const p = posNow()
      const k = p ? p.part : -1
      setPart((cur) => cur === k ? cur : k)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, q.at])

  const start = useCallback(() => {
    if (!voice) { setFault('먼저 목소리를 고르세요'); return }
    if (!chunks.length) { setFault('읽을 글이 없습니다'); return }
    setFault('')
    // ★다시 누르는 것은 "이제 될 것 같다" 는 뜻이다. 거절당해 굳은 것을 풀어 준다 —
    //   풀지 않으면 다른 작업이 끝나도 그 자리에 갇힌다.
    setQ((cur) => retryFailed(cur))
    // ★동작 기록 — 글 내용은 적지 않는다. 자리·목소리 종류·파일 이름·설정만.
    opLog('reader', `시작 — 덩이 ${qRef.current.at + 1}/${chunks.length} · 목소리 ${voice.kind}:${nameOnly(voice.path)}${skipHanja ? ' · 괄호 속 한자 뺌' : ''}`)
    askedAt.current = { t: performance.now(), kind: 'start' }; endedAt.current = null
    // readyAtRequest — 누르기 전에 이미 만들어 둔 자리(큐가 들고 있음 — 요청도 캐시 조회도 없다)인가.
    trace('play-request', { chunk: qRef.current.at, gen: gen.current, kind: voice.kind, engine: voice.engineId || '', readyAtRequest: qRef.current.items[qRef.current.at]?.state === 'ready' }, askedAt.current.t)
    setPlaying(true)
  }, [voice, chunks.length, skipHanja])

  const seekToChar = useCallback((charIndex: number) => {
    const c = Math.max(0, charIndex)
    if (chunkAt(chunks, c) < 0) return
    stopAudio()
    setFault('')
    // 관측 — 이동 요청. 다음 play-start 의 sinceRequestMs 가 '이동 후 첫 소리'.
    askedAt.current = { t: performance.now(), kind: 'seek' }; endedAt.current = null; lowSince.current = null
    trace('seek-request', { fromChunk: qRef.current.at, gen: gen.current, sameCut: c === breakAt }, askedAt.current.t)
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

  const chunk = chunks[q.at]
  let spot: ReadingSpot | null = null
  // ★소리가 아직 없으면(만드는 중) 칠하지 않는다 — 예전에는 만드는 동안에도 덩이를 칠해 소리 없이 '읽는 중' 으로 보였다(2026-10-01 실측 약 4초).
  if (playing && chunk && q.items[q.at]?.state === 'ready') {
    const pr = part >= 0 ? planOf(q.at).parts[part] : undefined
    spot = pr ? { start: chunk.start + pr.from, end: chunk.start + pr.to } : { start: chunk.start, end: chunk.end }
  }
  const caret = useCallback(() => caretRef.current(), [])
  return {
    chunks, at: q.at, playing,
    wait: playing && !canPlayNow(q) ? waitReason(q) : '',
    fault, spot, caret, start, stop, seekToChar, next, prev,
  }
}
