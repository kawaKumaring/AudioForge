/**
 * 생성 카드를 **실제로 돌리는 곳** — 화면 밖.
 *
 * 이 파일이 하는 일은 셋뿐이다.
 *   1. 카드의 원본으로 **목소리를 준비한다**(영상이면 소리를 먼저 꺼낸다).
 *   2. 기존 합성 엔진에 그 카드의 대사·목소리·설정을 **보낸다.**
 *   3. 늦게 온 결과가 **바뀐 카드나 다른 카드에 붙지 않게** 막는다.
 *
 * 판단은 여기에 없다.
 *   · 무엇을 보낼 수 있는가 → `shared/synthesisCardJob`
 *   · 준비 판정                → `shared/voicePreparation`(기존)
 *   · 보낼 옵션의 모양        → `shared/labWorkspace` 의 `synthesisOptions`(기존, 단일 출처)
 *
 * ★기존 화면의 목소리를 건드리지 않는다
 *   파생 클립 자리가 `card:<id>` 다. `default`(고급)·`lab`(일반)·`spk:`(인물)·감정 id 와
 *   겹치지 않으므로, 한 카드의 재확정·삭제·정리가 다른 카드나 기존 작업의 파일을 지우지 않는다.
 *   전역 목소리나 전역 설정을 바꿔 가며 카드별 동작을 흉내 내지 않는다 — 모든 값은 요청에 실어 보낸다.
 */
import {
  decideAfterAnalysis, decideAfterTrim,
  type ReferenceAnalysis,
// @ts-ignore TS5097
} from '../../shared/voicePreparation.ts'
// @ts-ignore TS5097
import { defaultSettings, synthesisOptions } from '../../shared/labWorkspace.ts'
// @ts-ignore TS5097
import { REFERENCE_CONDITIONING_RECOMMENDED } from '../../shared/ttsConfig.ts'
import {
  cardApplied, cardClipKey, cardEventFault, cardGenerateFault, cardRegionFault,
  type CardApplied,
// @ts-ignore TS5097
} from '../../shared/synthesisCardJob.ts'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽으므로 명시 확장자.
import { runVoicePrep, cancelVoicePrep, forgetVoicePrep } from './voicePrepRunner.ts'
import {
  useSynthesisCards, type SynthesisCard, type CardRef, type JoinSettings,
// @ts-ignore TS5097
} from '../stores/synthesisCards.store.ts'
// @ts-ignore TS5097
import type { SavedWork } from '../../shared/synthesisCardSave.ts'
// @ts-ignore TS5097
import { useAppStore } from '../stores/app.store.ts'

/** 카드 설정에 없는 값(엔진·말끝 다듬기 등)은 **제품 기본값**을 쓴다. */
const productDefaults = () => defaultSettings(REFERENCE_CONDITIONING_RECOMMENDED)

/**
 * 이 카드가 실제로 읽을 소리 파일. 영상이면 꺼낸 wav, 소리면 원본 그대로.
 *
 * ★같은 원본을 두 번 꺼내지 않는다 — 본체가 같은 이름으로 돌려주므로 캐시도 그 위에 얹는다.
 */
const resolved = new Map<string, { from: string; audio: string }>()

export async function cardAudioPath(cardId: string, sourcePath: string): Promise<string> {
  const hit = resolved.get(cardId)
  if (hit && hit.from === sourcePath) return hit.audio
  const r = await window.api.cards.extractAudio(cardId, sourcePath) as
    { ok: boolean; data?: string; error?: string }
  if (!r?.ok || !r.data) throw new Error(r?.error || '영상에서 소리를 꺼내지 못했습니다')
  resolved.set(cardId, { from: sourcePath, audio: r.data })
  return r.data
}

/** 이 카드가 소유한 것만 정리한다 — 파생 클립 하나와 꺼내 둔 소리 하나. */
export async function releaseCardOwnership(cardId: string): Promise<void> {
  cancelVoicePrep(cardClipKey(cardId))
  resolved.delete(cardId)
  try { await window.api.audio.releaseReferenceClip(cardClipKey(cardId)) } catch { /* 없으면 그만 */ }
  try { await window.api.cards.releaseMedia(cardId) } catch { /* 없으면 그만 */ }
}

/** 이 카드의 준비를 처음부터 다시 할 수 있게 한다(원본·구간이 바뀌었을 때). */
export function forgetCardReference(cardId: string): void {
  forgetVoicePrep(cardClipKey(cardId))
  useSynthesisCards.getState().clearRef(cardId)
}

/**
 * 저장할 모양으로 옮긴다. **카드 순서·대사·설정·생성본·채택을 함께** 남긴다.
 * 준비 상태와 돌고 있는 작업은 담지 않는다 — 그것은 이번 실행에만 속한다.
 */
export function serializeWork(cards: SynthesisCard[], joins: JoinSettings): SavedWork {
  return {
    savedAt: Date.now(),
    joins: { ...joins },
    cards: cards.map((c) => ({
      id: c.id, label: c.label,
      sourcePath: c.source?.path || '', sourceName: c.source?.name || '',
      sourceDuration: c.source?.duration || 0,
      text: c.text, settings: { ...c.settings },
      adoptedId: c.adoptedId,
      takes: c.takes.map((t) => ({
        id: t.id, path: t.path, createdAt: t.createdAt, text: t.text,
        sourcePath: t.source.path, sourceName: t.source.name,
        settings: { ...t.settings }, applied: { ...t.applied },
      })),
    })),
  }
}

/**
 * 저장본을 화면 카드로 되돌린다. **사용자가 '불러오기' 를 고른 뒤에만 불린다.**
 *
 * ★사라진 생성본 파일은 지우지 않고 `missing` 으로 **표시만** 한다 —
 *   조용히 없애면 사용자는 자기 생성본이 몇 개였는지 알 수 없게 된다.
 */
export async function hydrateWork(w: SavedWork): Promise<{ cards: SynthesisCard[]; joins: JoinSettings }> {
  const paths = w.cards.flatMap((c) => c.takes.map((t) => t.path))
  let present: Record<string, boolean> = {}
  try { present = await window.api.audio.sourcesPresent(paths) } catch { /* 못 물어보면 표시하지 않는다 */ }
  const fallback = productDefaults()
  const cards: SynthesisCard[] = w.cards.map((c) => {
    const settings = {
      speed: num(c.settings.speed, 1), pitch: num(c.settings.pitch, 0),
      emotion: text(c.settings.emotion) || '자연스럽게',
      reference: c.settings.reference === 'manual' ? 'manual' as const : 'auto' as const,
      start: num(c.settings.start, 0), end: num(c.settings.end, c.sourceDuration),
    }
    return {
      id: c.id, label: c.label,
      source: c.sourcePath ? { path: c.sourcePath, name: c.sourceName, duration: c.sourceDuration } : null,
      text: c.text, settings, adoptedId: c.adoptedId,
      takes: c.takes.map((t) => ({
        id: t.id, path: t.path, createdAt: t.createdAt, text: t.text,
        source: { path: t.sourcePath, name: t.sourceName, duration: 0 },
        settings: {
          speed: num(t.settings.speed, settings.speed), pitch: num(t.settings.pitch, settings.pitch),
          emotion: text(t.settings.emotion) || settings.emotion,
          reference: t.settings.reference === 'manual' ? 'manual' as const : 'auto' as const,
          start: num(t.settings.start, 0), end: num(t.settings.end, 0),
        },
        applied: {
          speed: num(t.applied.speed, fallback.speed), pitch: num(t.applied.pitch, fallback.pitch),
          notes: Array.isArray(t.applied.notes) ? t.applied.notes as CardApplied['notes'] : [],
        },
        missing: present[t.path] === false,
      })),
    }
  })
  const j = w.joins as Partial<JoinSettings>
  return {
    cards,
    joins: {
      gap: num(j.gap, 0.35), level: j.level !== false, edges: j.edges !== false,
      gaps: (j.gaps as Record<string, number>) || {},
    },
  }
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

const newReqId = () => crypto.randomUUID()

/** 늦게 온 보고를 버린다 — 지금 이 카드가 기다리는 요청이 아니면 무시한다. */
function report(cardId: string, reqId: string, patch: Partial<CardRef>): void {
  const st = useSynthesisCards.getState()
  const now = st.refs[cardId]
  if (now && now.reqId && now.reqId !== reqId) return
  st.setRef(cardId, { ...patch, reqId })
}

/**
 * 카드의 목소리를 준비한다.
 *
 * 자동 구간은 기존 실행부(`runVoicePrep`)를 그대로 쓴다 — 추천 구간을 대신 확정한다.
 * 직접 지정은 **사용자가 고른 구간 그대로** 잘라 확정한다(추천으로 바꿔치기하지 않는다).
 */
export async function prepareCardReference(card: SynthesisCard): Promise<void> {
  if (!card.source) return
  const cardId = card.id
  const clipKey = cardClipKey(cardId)
  const reqId = newReqId()
  const s = productDefaults()

  useSynthesisCards.getState().setRef(cardId, {
    phase: 'preparing', clip: '', region: null, message: '목소리를 살펴보는 중입니다…', reqId,
  })

  let audio: string
  try {
    audio = await cardAudioPath(cardId, card.source.path)
    // 화면이 파형·미리듣기에 쓸 수 있게 **실제로 읽는 파일**을 올린다(영상이면 꺼낸 wav).
    report(cardId, reqId, { audio })
  } catch (e) {
    report(cardId, reqId, { phase: 'failed', clip: '', region: null, message: (e as Error).message })
    return
  }

  if (card.settings.reference === 'manual') {
    const fault = cardRegionFault(card.settings, card.source.duration)
    if (fault) {
      report(cardId, reqId, { phase: 'needs_region', clip: '', region: null, message: fault })
      return
    }
    try {
      // 정책(길이 한도 등)은 분석이 정한다 — 직접 지정이라도 같은 잣대를 쓴다.
      const a = await window.api.audio.analyzeReference(audio, clipKey,
        { ttsEngine: s.engine, regionTargetSec: s.refTargetSec }) as ReferenceAnalysis
      if (!a || typeof a.duration_sec !== 'number') throw new Error('참조 분석 결과가 올바르지 않습니다')
      const d = decideAfterAnalysis({ analysis: a, committed: null, autoConfirm: false, plain: true })
      const raw = await window.api.audio.trimReference(
        audio, card.settings.start, card.settings.end - card.settings.start, clipKey,
        { ttsEngine: s.engine }) as Record<string, unknown>
      const t = decideAfterTrim(raw, { hasCommitted: false, policy: d.policy, plain: true })
      if (t.kind === 'ready') {
        report(cardId, reqId, { phase: 'ready', clip: t.clip, region: t.region, message: '' })
        return
      }
      if (t.kind === 'kept') { report(cardId, reqId, { phase: 'ready', message: '' }); return }
      report(cardId, reqId, {
        phase: t.patch.phase === 'needs_region' ? 'needs_region' : 'failed',
        clip: '', region: null, message: t.patch.message || '목소리 구간을 준비하지 못했습니다',
      })
    } catch (e) {
      report(cardId, reqId, {
        phase: 'failed', clip: '', region: null,
        message: `목소리 구간을 준비하지 못했습니다: ${(e as Error)?.message || ''}`,
      })
    }
    return
  }

  // 자동 — 기존 실행부에 맡긴다. 이 자리(card:<id>)의 결과만 이 카드로 온다.
  await runVoicePrep({
    clipKey, path: audio, reqId, engine: s.engine, refTargetSec: s.refTargetSec, plain: true,
    committedNow: () => {
      const r = useSynthesisCards.getState().refs[cardId]
      return r && r.phase === 'ready' && r.clip ? { clip: r.clip, region: r.region } as never : null
    },
    report: (p) => report(cardId, reqId, {
      phase: (p.phase as CardRef['phase']) || 'preparing',
      clip: typeof p.clip === 'string' ? p.clip : '',
      region: (p.region as CardRef['region']) ?? null,
      message: p.message || '',
    }),
  })
}

/**
 * 생성을 시작한다. 시작했으면 빈 문자열, 못 했으면 **그 이유**를 돌려준다.
 *
 * ★한 번에 하나만 돈다 — 파이썬 통로가 하나다. 공용 작업 상태를 함께 쓰므로 기존 합성과
 *   동시에 돌지 않는다. 다중 카드 큐는 이번 범위가 아니다(관리자 지시).
 */
export async function startCardGeneration(card: SynthesisCard): Promise<string> {
  const st = useSynthesisCards.getState()
  if (st.job) return '이미 만드는 중입니다'
  const app = useAppStore.getState()
  const ref = st.refs[card.id]
  const fault = cardGenerateFault({
    hasSource: !!card.source,
    text: card.text,
    refReady: !!(ref && ref.phase === 'ready' && ref.clip),
    refMessage: ref?.message || '',
    busy: app.status === 'processing',
  })
  if (fault) return fault

  // ★적용값에 **실제로 쓰인 참조**까지 남긴다 — 자동 구간은 사람이 고른 값이 아니므로,
  //   남기지 않으면 나중에 '무엇이 달라져 소리가 달라졌나' 를 답할 수 없다(2026-09-27 지적).
  const applied: CardApplied = {
    ...cardApplied(card.settings),
    reference: { clip: ref!.clip, region: ref!.region },
  }
  const reqId = newReqId()
  // ★요청 시점의 대사·원본·설정을 **여기서 붙든다.** 도중에 고쳐도 결과에는 이 값이 붙는다.
  st.setJob({
    cardId: card.id, reqId, text: card.text, source: { ...card.source! },
    settings: { ...card.settings }, applied, startedAt: Date.now(),
    percent: 0, message: '만드는 중…', cancelling: false,
  })

  const s = { ...productDefaults(), speed: applied.speed, pitch: applied.pitch }
  // ★요청 식별자를 실어 보낸다. 본체가 진행·결과·오류·취소에 그대로 되돌려 주므로
  //   화면이 '내 요청의 응답인가' 를 스스로 가릴 수 있다(2026-09-27 검수 재현 대응).
  const options = {
    ...synthesisOptions(card.text, s, { clip: ref!.clip, region: ref!.region }),
    clientRequestId: reqId,
  }

  useAppStore.getState().beginIndependentWork('목소리 만드는 중...')
  try {
    let audio: string
    try {
      audio = await cardAudioPath(card.id, card.source!.path)
    } catch (e) {
      throw new Error((e as Error).message)
    }
    // ★시작 요청의 거절을 버리지 않는다 — 본체는 여러 갈래로 거절할 수 있고
    //   그 경로에는 progress·result·error 어느 알림도 따라오지 않는다.
    await window.api.audio.process(audio, 'tts', options)
    return ''
  } catch (e) {
    useSynthesisCards.getState().setJob(null)
    useAppStore.getState().endIndependentWork()
    return `만들기를 시작하지 못했습니다: ${(e as Error)?.message || e}`
  }
}

/** 지금 돌고 있는 생성을 멈춘다. 여기까지 만든 생성본은 그대로 둔다. */
export function endCardJob(): void {
  useSynthesisCards.getState().setJob(null)
  useAppStore.getState().endIndependentWork()
}

/**
 * 결과가 왔다. **지금 기다리는 요청의 것일 때만** 생성본으로 남긴다.
 *
 * 돌려주는 값: 붙인 생성본의 id, 또는 버린 이유.
 */
export function acceptCardResult(data: unknown): { takeId?: string; dropped?: string } {
  const st = useSynthesisCards.getState()
  const job = st.job
  if (!job) return { dropped: '기다리는 요청이 없습니다' }
  // ★**누구의 응답인가를 먼저 본다.** 예전에는 '작업이 있는가' 만 보아, 지난 요청의 결과 파일이
  //   지금 대사와 묶여 생성본에 붙었다(2026-09-27 격리 재현).
  //   남의 응답으로 이 작업을 끝내지도 않는다 — 내 결과는 아직 오는 중일 수 있다.
  const fault = cardEventFault(data, job.reqId)
  if (fault) return { dropped: fault }
  const path = ((data as { tracks?: { path?: string }[] })?.tracks || [])[0]?.path
  if (!path) { endCardJob(); return { dropped: '결과에 파일이 없습니다' } }
  // 카드가 그 사이에 사라졌으면 붙일 자리가 없다.
  if (!st.cards.some((c) => c.id === job.cardId)) { endCardJob(); return { dropped: '카드가 사라졌습니다' } }

  const take = {
    id: crypto.randomUUID(), path, createdAt: Date.now(),
    text: job.text, source: job.source, settings: job.settings, applied: job.applied,
  }
  st.addTake(job.cardId, take)
  endCardJob()
  return { takeId: take.id }
}
