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
import {
  cardVoiceOf, needsReferencePrep, voiceGenerateFault, builtinRequestFields, voiceSnapshot,
  type BuiltinVoiceRef, type VoiceSnapshot,
// @ts-ignore TS5097
} from '../../shared/synthesisCardVoice.ts'
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
export function serializeWork(
  cards: SynthesisCard[], joins: JoinSettings,
  importedFrom?: SavedWork['importedFrom'] | null,
): SavedWork {
  return {
    savedAt: Date.now(),
    joins: { ...joins },
    // ★출처는 문서에 속한다. 편집 한 번에 사라지면 '이미 가져온 작업' 을 알아볼 수 없다.
    ...(importedFrom ? { importedFrom: { ...importedFrom } } : {}),
    cards: cards.map((c) => ({
      id: c.id, label: c.label,
      sourcePath: c.source?.path || '', sourceName: c.source?.name || '',
      sourceDuration: c.source?.duration || 0,
      text: c.text, settings: { ...c.settings },
      adoptedId: c.adoptedId,
      // ★기본 목소리 지정을 통째로 남긴다 — 엔진·모델·언어·화자·모델 경로까지.
      //   하나라도 빠지면 되살린 카드가 '목소리 없는 카드' 가 된다(2026-09-27 재현).
      ...(c.builtin ? { builtin: { ...c.builtin } } : {}),
      takes: c.takes.map((t) => ({
        id: t.id, path: t.path, createdAt: t.createdAt, text: t.text,
        sourcePath: t.source.path, sourceName: t.source.name,
        sourceDuration: t.source.duration || 0,
        // ★기록이 없는 생성본은 **비운 채로** 쓴다. 화면이 채워 둔 자리값(카드 설정)을
        //   그대로 저장하면, 다음에 읽을 때는 그것이 '그때 쓴 값' 으로 보인다.
        ...(t.settingsUnknown
          ? { settings: {}, applied: {} }
          : { settings: { ...t.settings }, applied: { ...t.applied } }),
        // 그때의 목소리. **기록이 없으면 넣지 않는다** — 지금 값으로 채우지 않는다.
        ...(t.voice ? { voice: { ...t.voice } } : {}),
        // 기록이 없다는 **사실 자체**를 남긴다 — 왕복하며 슬며시 '지금 것' 이 되지 않게.
        ...(t.settingsUnknown ? { settingsUnknown: true as const } : {}),
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
export async function hydrateWork(w: SavedWork): Promise<{
  cards: SynthesisCard[]; joins: JoinSettings; importedFrom: SavedWork['importedFrom'] | null
}> {
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
      // ★기본 목소리를 되살린다. 모양이 아니면 **자동으로 다른 목소리를 넣지 않는다** —
      //   `builtinFrom` 이 null 을 돌려주고, 화면은 '목소리를 고르세요' 로 남는다.
      ...(builtinFrom(c.builtin) ? { builtin: builtinFrom(c.builtin) } : {}),
      text: c.text, settings, adoptedId: c.adoptedId,
      takes: c.takes.map((t) => ({
        id: t.id, path: t.path, createdAt: t.createdAt, text: t.text,
        source: { path: t.sourcePath, name: t.sourceName, duration: num(t.sourceDuration, 0) },
        // ★기록이 없으면 **카드 설정을 빌려 오지 않는다.** 빌려 온 값은 자리를 채울 뿐
        //   화면에 나오지 않지만, 저장으로 되돌아가면 '그때 쓴 값' 이 되어 버린다.
        settings: t.settingsUnknown
          ? { speed: 0, pitch: 0, emotion: '', reference: 'auto' as const, start: 0, end: 0 }
          : {
            speed: num(t.settings.speed, settings.speed), pitch: num(t.settings.pitch, settings.pitch),
            emotion: text(t.settings.emotion) || settings.emotion,
            reference: t.settings.reference === 'manual' ? 'manual' as const : 'auto' as const,
            start: num(t.settings.start, 0), end: num(t.settings.end, 0),
          },
        // ★**기록이 없으면 비워 둔다.** 예전에는 제품 기본값을 채워 넣어, 재지 않은 값을
        //   "이 속도로 만들었다" 고 말하게 했다(2026-09-27 지적). 화면은 이미 '기록 없음' 을 그린다.
        applied: appliedFrom(t.applied),
        // 그때의 목소리. 옛 생성본에는 없다 — 없는 채로 둔다.
        ...(voiceFrom(t.voice) ? { voice: voiceFrom(t.voice)! } : {}),
        ...(t.settingsUnknown ? { settingsUnknown: true } : {}),
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
    importedFrom: w.importedFrom ? { ...w.importedFrom } : null,
  }
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * 저장된 기본 목소리 지정을 되살린다. **모자라면 null** — 반쯤 채워 쓰지 않는다.
 *
 * ★자동 대체를 하지 않는 이유(2026-09-27 요구): 모델이 사라졌는데 다른 목소리를 슬쩍 넣으면
 *   사용자는 **다른 사람 목소리로 만들어진 것을 모른 채** 쓰게 된다.
 *   여기서는 지정만 되살리고, 그 모델이 실제로 있는지는 화면이 따로 확인한다.
 */
function builtinFrom(raw: unknown): BuiltinVoiceRef | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const engineId = text(b.engineId), modelId = text(b.modelId), path = text(b.path)
  if (!engineId || !modelId || !path) return null       // 이 셋이 없으면 생성에 쓸 수 없다
  const speakerId = text(b.speakerId)
  return {
    engineId, modelId, path,
    label: text(b.label) || modelId,
    language: text(b.language),
    sampleRate: num(b.sampleRate, 0),
    ...(speakerId ? { speakerId } : {}),
  }
}

/** 저장된 생성본 목소리 기록. 종류를 알 수 없으면 null(없는 채로 둔다). */
function voiceFrom(raw: unknown): VoiceSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const kind = text(v.kind)
  if (kind !== 'reference' && kind !== 'builtin' && kind !== 'none') return null
  const keep = (k: string) => (text(v[k]) ? { [k]: text(v[k]) } : {})
  return {
    kind, label: text(v.label),
    ...keep('sourcePath'), ...keep('engineId'), ...keep('modelId'),
    ...keep('language'), ...keep('speakerId'),
  } as VoiceSnapshot
}

/**
 * 저장된 **적용값**. 기록이 있는 것만 담는다.
 *
 * ★없는 값을 기본값으로 채우지 않는다. 채우면 "재지 않았다" 와 "1.0 이었다" 를 구별할 수 없다.
 *   화면의 `appliedOf()` 가 비어 있는 자리를 '기록 없음' 으로 그린다.
 */
function appliedFrom(raw: Record<string, unknown>): CardApplied {
  const a = raw || {}
  const ref = a.reference as { clip?: unknown; region?: unknown } | undefined
  const out: Record<string, unknown> = {
    notes: Array.isArray(a.notes) ? a.notes : [],
  }
  if (typeof a.speed === 'number' && Number.isFinite(a.speed)) out.speed = a.speed
  if (typeof a.pitch === 'number' && Number.isFinite(a.pitch)) out.pitch = a.pitch
  // ★실제로 쓰인 참조 구간 — 자동 확정 구간까지 그대로 되살린다(2026-09-27 재현 대상).
  if (ref && typeof ref === 'object' && typeof ref.clip === 'string') {
    const r = ref.region as { start?: unknown; duration?: unknown } | null | undefined
    const region = r && typeof r === 'object'
      && typeof r.start === 'number' && Number.isFinite(r.start)
      && typeof r.duration === 'number' && Number.isFinite(r.duration)
      ? { start: r.start, duration: r.duration } : null
    out.reference = { clip: ref.clip, region }
  }
  // 타입은 speed·pitch 를 요구하지만, **기록 없음을 표현하려면 비워야 한다.**
  // 읽는 쪽(화면 `appliedOf`, 판정 `takeIsStale`)은 이미 없는 값을 다룬다.
  return out as unknown as CardApplied
}

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
  // ★기본 목소리는 참조가 없다 — 분석도 구간 자르기도 하지 않는다.
  //   준비 상태를 '됐다' 로 적어 두지도 않는다. 애초에 이 길을 타지 않는다.
  if (!needsReferencePrep(cardVoiceOf(card))) return
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
  const voice = cardVoiceOf(card)
  const fault = voiceGenerateFault({
    voice,
    text: card.text,
    refReady: !!(ref && ref.phase === 'ready' && ref.clip),
    refMessage: ref?.message || '',
    busy: app.status === 'processing',
    // 모델 파일이 사라졌는지는 본체가 곧바로 말해 준다 — 여기서 미리 단정하지 않는다.
    builtinUsable: true, builtinWhy: '',
  })
  if (fault) return fault

  // ★적용값에 **실제로 쓰인 참조**까지 남긴다 — 자동 구간은 사람이 고른 값이 아니므로,
  //   남기지 않으면 나중에 '무엇이 달라져 소리가 달라졌나' 를 답할 수 없다(2026-09-27 지적).
  const applied: CardApplied = {
    ...cardApplied(card.settings),
    // 기본 목소리에는 참조가 없다 — 없는 것을 있는 것처럼 적지 않는다.
    ...(voice.kind === 'reference' ? { reference: { clip: ref!.clip, region: ref!.region } } : {}),
  }
  const reqId = newReqId()
  // ★요청 시점의 대사·원본·설정을 **여기서 붙든다.** 도중에 고쳐도 결과에는 이 값이 붙는다.
  st.setJob({
    cardId: card.id, reqId, text: card.text,
    source: card.source ? { ...card.source } : { path: '', name: cardVoiceLabelOf(card), duration: 0 },
    settings: { ...card.settings }, applied, startedAt: Date.now(),
    // ★요청 시점의 목소리를 **여기서 굳힌다.** 예전에는 이 값이 없어서 결과를 받을 때
    //   '지금 카드의 목소리' 로 대신 채웠다 — 만드는 동안 목소리를 바꾸면 그 생성본에
    //   **만들지도 않은 목소리**가 기록됐다(2026-09-27 지적 3).
    voice: voiceSnapshot(voice),
    percent: 0, message: '만드는 중…', cancelling: false,
  })

  const s = { ...productDefaults(), speed: applied.speed, pitch: applied.pitch }
  // ★요청 식별자를 실어 보낸다. 본체가 진행·결과·오류·취소에 그대로 되돌려 주므로
  //   화면이 '내 요청의 응답인가' 를 스스로 가릴 수 있다(2026-09-27 검수 재현 대응).
  const options = {
    ...synthesisOptions(card.text, s, voice.kind === 'reference'
      ? { clip: ref!.clip, region: ref!.region }
      : { clip: '', region: null }),
    // 기본 목소리면 엔진·모델을 명시해 싣는다. 참조 목소리면 아무것도 붙지 않는다.
    ...builtinRequestFields(voice),
    clientRequestId: reqId,
    // ★**사용자가 고른 원본**을 따로 싣는다. 영상이면 아래에서 꺼낸 wav 를 보내는데,
    //   본체가 그 폴더를 결과 자리로 삼으면 C 드라이브 중간 폴더에 쌓인다(2026-09-28 신고).
    //   읽는 파일과 '어디에 쌓을지' 를 정하는 파일은 다른 것이다.
    ...(voice.kind === 'reference' && card.source?.path
      ? { sourceOriginalPath: card.source.path } : {}),
  }

  useAppStore.getState().beginIndependentWork('목소리 만드는 중...')
  try {
    // 기본 목소리는 읽을 원본이 없다. **가짜 파일로 관문을 넘기지 않는다** —
    // 본체가 이 경우를 알고 앱 소유 폴더에 결과를 쌓는다.
    let audio = ''
    if (voice.kind === 'reference') {
      try {
        audio = await cardAudioPath(card.id, card.source!.path)
      } catch (e) {
        throw new Error((e as Error).message)
      }
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
    // ★그때의 목소리 — **요청 시점에 굳힌 값만** 쓴다.
    //   지금 카드의 목소리로 대신 채우지 않는다. 만드는 동안 바꿨다면 그것은 다른 목소리다.
    //   굳힌 값이 없는 경우(옛 경로)는 **비워 둔다** — 모르는 것을 아는 척하지 않는다.
    ...(job.voice ? { voice: job.voice } : {}),
  }
  st.addTake(job.cardId, take)
  endCardJob()
  return { takeId: take.id }
}

/** 카드 이름표 — 기본 목소리면 모델 이름, 참조면 파일 이름. */
function cardVoiceLabelOf(card: SynthesisCard): string {
  const v = cardVoiceOf(card)
  return v.kind === 'builtin' ? v.voice.label : (v.kind === 'reference' ? v.source.name : '')
}