import { useState, useEffect, useRef, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { useAppStore, emotionEffectivePath } from '@/stores/app.store'
import type { TtsReferenceEntry, PitchCapability, TtsEmotionRegion } from '../../shared/ttsConfig'
import { deriveRefMode } from '../../shared/ttsConfig'
import ReferenceRegionPanel from './ReferenceRegionPanel'
import ReferenceAssetLibraryPanel from './ReferenceAssetLibraryPanel'
import EmotionSamplerPanel from './EmotionSamplerPanel'
import { SAMPLER_FAILURE_TEXT } from '../../shared/samplerApi'
import { EMOTION_SAMPLE_ROWS, capabilityForRow, stateForCapability } from '../../shared/emotionSampler'
import type { EmotionSampleEntry } from '../../shared/emotionSampler'
import { EMOTION_PREVIEW_SILENCE_MS } from '../../shared/emotionSamplePreview'
import { createEmotionSamplePreviewPlayer, browserPreviewDeps } from '@/lib/emotionSamplePreviewPlayer'
import { REF_ASSET_FAILURE_TEXT } from './ReferenceAssetLibraryPanel.logic'
import type { ReferenceLibraryItem, ReferenceLibraryStatus } from '../../shared/referenceLibraryApi'
import TtsVoiceSection from './TtsVoiceSection'
import EmotionReferenceManager from './EmotionReferenceManager'
import ExpressionControls from './ExpressionControls'
import { getPresetValues } from './ExpressionControls.logic'
import TtsExpressionDetail from './TtsExpressionDetail'
import { resolveExpressionCapability } from '../../shared/ttsExpressionCapabilities'
import {
  IDLE_SESSION, beginRequest, invalidate, applyEvent, decideAsyncResult, previewErrorText,
  type PreviewSession, type PreviewEvent,
} from '../../shared/previewSession'
import EmotionScriptEditor, { type EmotionScriptEditorHandle } from './EmotionScriptEditor'
import { EMOTION_GROUPS, ALL_EMOTIONS, FREQUENT_TAGS, parseUsedEmotionIds, EMOTION_ID_TO_LABEL } from '@/lib/emotions'
import type { Emotion } from '@/lib/emotions'
import TtsAdvancedSettings, { type TtsAdvancedTab } from './TtsAdvancedSettings'
import TtsEmotionQuickPreview from './TtsEmotionQuickPreview'
import { setTtsAdvancedOpener } from '@/lib/ttsAdvancedOpen'
import InputAnalysisPanel from './InputAnalysisPanel'
import VoiceCastManager from './VoiceCastManager'
import SpeakerEmotionCandidates from './SpeakerEmotionCandidates'
import DialogueTabs, { type DialogueTab } from './DialogueTabs'
import MultiSpeakerDialogue from './MultiSpeakerDialogue'
import { speakerDirectiveSequence } from '../../shared/dialogueSourcePatcher'
import { useDialogueProjection } from '../hooks/useDialogueProjection'
import { normalizeSpeakerId } from '../../shared/ttsGrammar'
import { validateSpeakerLabel } from '../../shared/dialogueSourcePatcher'
import { gateSpeakerEmotionRefs, emotionIdsForSpeaker } from '../../shared/speakerEmotionGate'
import { useVoiceCastRegistry } from '../hooks/useVoiceCastRegistry'
import {
  castRegistry, findVoiceCast, toSpeakerEmotionRefs,
} from '../../shared/emotionCandidateRegistry'
import type { ReferenceDecision, EmotionMatchView } from '../../shared/speakerReference'

/** 계획의 화자 한 명을 화면 상태와 합친 행. 인물 카드·요약·목소리 패널이 같은 행을 본다. */
interface SpeakerRow {
  speakerId: string
  label: string
  utteranceCount: number
  registered: boolean
  ready: boolean
  message: string
  fileName: string
  sharedWith: string[]
  decision: ReferenceDecision
  /** 실제로 모델에 가는 구간(확정 구간). null = 원본 전체. 카드가 그대로 보여 준다. */
  region?: { start: number; duration: number } | null
  emotion?: EmotionMatchView | null
}
import {
  resolveReferenceDecision, sharedReferenceGroups, speakerEmotionKey, readinessFromSlots,
} from '../../shared/speakerReference'
import { speakerRows as planSpeakerRows, defaultSpeakerUtteranceCount } from '../../shared/analysisWording'
import { useInputAnalysis } from '../hooks/useInputAnalysis'

// 기본 화면 감정 미리듣기 3종. 카탈로그(EMOTION_SAMPLE_ROWS)에 이미 있는 행만 쓴다 —
// 새 대본·새 문구를 만들지 않는다(표준 문구 버전 계약을 건드리지 않기 위해서다).
const QUICK_EMOTION_ROW_IDS = ['emotion_happy', 'emotion_angry', 'emotion_sad'] as const

const EXAMPLE_TEXT = "안녕하세요. 오늘 좋은 소식이 있어요.\n[기쁨] 드디어 프로젝트가 완성됐습니다!\n[슬픔] 하지만 아쉽게도 일정이 늦어졌어요."

// 팔레트 '쉼' 버튼이 삽입하는 기본 길이(ms). 허용 범위 0.05~5.0s 안의 흔한 값이며,
// 범위·인접 중복 판정은 순수 helper(insertPauseTag)가 하고 여기서 clamp하지 않는다.
const PALETTE_PAUSE_MS = 300

const PROMPT_LANGS: [string, string][] = [
  ['', '자동'], ['ko', '한국어'], ['ja', '일본어'], ['zh', '중국어'], ['en', '영어'],
]

// I5-a: 감정 참조 미리듣기(신규 어포던스). PHASE 4에서 raw file:// 재생이 webSecurity에 막히는 것을 확인 →
// 앱이 결과 트랙 재생에 쓰는 '기존 안전 경로'(getFileUrl → local-file:// 권한 프로토콜)를 재사용한다.
// webSecurity 완화·임의 경로·외부 전송 없음. 재생 대상은 등록된 감정 참조의 effective(파생 클립/원본) 경로뿐.
//
// 신뢰성(세대 기반): getFileUrl은 비동기라 감정 후보를 빠르게 옮겨 다니면 '이전 요청'의 URL이 뒤늦게
// 도착해 새 Audio를 또 만들고, 이전 Audio는 아무도 참조하지 않은 채 계속 울리며 정지도 되지 않았다.
// 이제 요청마다 세대를 올리고, 늦게 온 이전 세대의 결과는 Audio를 만들기 전에 폐기한다.
let _previewAudio: HTMLAudioElement | null = null
let _previewSession: PreviewSession = IDLE_SESSION
let _previewErrorSink: ((message: string | null) => void) | null = null
// 요청 직렬화 — 동시에 진행 중인 local-file:// 로드를 항상 1개로 제한한다(아래 이유 참고).
let _previewChain: Promise<void> = Promise.resolve()

/** 셸(TTSEditor)이 미리듣기 오류를 화면에 띄우도록 등록한다. 해제는 null. */
export function setReferencePreviewErrorSink(sink: ((message: string | null) => void) | null) {
  _previewErrorSink = sink
}
function emitPreviewError(message: string | null) {
  if (_previewErrorSink) _previewErrorSink(message)
}

// 미리듣기는 요소 하나를 재사용한다. 클릭마다 new Audio를 만들던 이전 구현은 아무도 참조하지 않는
// 요소를 계속 쌓았고(정지 불가·중복 재생), 그 요소들의 로드가 동시에 몰리면 local-file:// 요청이
// 고갈돼 그 뒤로는 어떤 미리듣기도 로드되지 않았다(= 사용자가 겪은 '무음').
function previewElement(): HTMLAudioElement {
  if (!_previewAudio) {
    _previewAudio = new Audio()
    _previewAudio.preload = 'auto'
  }
  return _previewAudio
}
function pausePreview() {
  if (_previewAudio) { try { _previewAudio.pause() } catch { /* noop */ } }
}
// 요소가 로드 불능 상태로 굳으면 버린다 — 다음 '사용자 클릭'이 새 요소로 시작한다(자동 재시도는 하지 않는다).
function discardPreviewElement() {
  const el = _previewAudio
  _previewAudio = null
  if (!el) return
  try { el.pause() } catch { /* noop */ }
  el.removeAttribute('src')
  try { el.load() } catch { /* noop */ }
}

export function stopReferencePreview() {
  _previewSession = invalidate(_previewSession, 'stopped')   // 진행 중이던 요청의 결과를 전부 폐기
  pausePreview()                                             // 로드는 끊지 않는다(끊긴 요청 누적이 무음의 원인)
  emitPreviewError(null)
}

// loadedmetadata/canplay(또는 error/타임아웃)까지 기다린다. 로드가 끝나기 전에 재생을 시작하지 않는다.
// 타임아웃이 반드시 있어야 한다 — 직렬화 큐가 정착하지 않는 로드에 걸려 영원히 막히면 그 뒤 모든 미리듣기가 무음이 된다.
function waitUntilPreviewLoaded(el: HTMLAudioElement, timeoutMs = 4000): Promise<void> {
  if (el.readyState >= 1 /* HAVE_METADATA */) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      el.removeEventListener('loadedmetadata', done)
      el.removeEventListener('canplay', done)
      el.removeEventListener('error', done)
      resolve()
    }
    timer = setTimeout(done, timeoutMs)
    el.addEventListener('loadedmetadata', done)
    el.addEventListener('canplay', done)
    el.addEventListener('error', done)
  })
}

function previewLocalFile(path: string, region?: { start: number; duration: number } | null) {
  if (!path) { emitPreviewError(previewErrorText('source')); return }
  // (1) 새 세대를 먼저 올린다 — 아직 URL/로드를 기다리는 이전 요청은 자기 차례에 stale임을 알고 물러난다.
  _previewSession = beginRequest(_previewSession)
  const gen = _previewSession.gen
  pausePreview()                 // 들리던 소리는 즉시 멈춘다
  emitPreviewError(null)
  // (2) 앞선 요청의 로드가 끝난 뒤에만 다음 로드를 시작한다. 로드를 중간에 끊어 버리면 그 local-file://
  //     요청이 남아 쌓이고, 수십 번 반복하면 이후 모든 미리듣기가 로드되지 않는다(영구 무음).
  _previewChain = _previewChain.then(() => runPreview(gen, path, region ?? undefined)).catch(() => { /* 다음 요청을 막지 않는다 */ })
}

async function runPreview(gen: number, path: string, region?: { start: number; duration: number }) {
  // 내 차례가 오기 전에 더 새로운 요청이 들어왔다면 아무 것도 하지 않는다(로드조차 시작하지 않음).
  const stale = () => decideAsyncResult(_previewSession, gen) === 'discard'
  if (stale()) return

  const fail = (kind: 'source' | 'load' | 'play') => {
    const v = applyEvent(_previewSession, gen, { kind: 'error', message: previewErrorText(kind) })
    if (!v.apply) return                       // 옛 세대의 실패(새 요청이 끊은 것) → 조용히 폐기
    _previewSession = v.next
    emitPreviewError(v.next.errorMessage)
  }
  const advance = (event: PreviewEvent): boolean => {
    const v = applyEvent(_previewSession, gen, event)
    if (v.apply) _previewSession = v.next
    return v.apply
  }

  try {
    const url = await window.api.audio.getFileUrl(path)   // local-file:// (결과 트랙과 동일 안전 경로)
    if (stale()) return                                   // 늦게 도착한 이전 요청 → 폐기(src를 덮어쓰지 않는다)
    if (!url) { fail('source'); return }
    if (!advance({ kind: 'url' })) return

    const el = previewElement()
    // (3) 소스 교체는 pause() → src 비우기 → 새 src 순서. 직렬화 덕분에 이 시점엔 진행 중인 로드가 없다.
    try { el.pause() } catch { /* noop */ }
    if (el.getAttribute('src') !== url) {
      el.removeAttribute('src')
      try { el.load() } catch { /* noop */ }
      el.src = url
      try { el.load() } catch { /* noop */ }
    }

    // (4) 로드가 끝난 뒤에 재생 위치를 정하고 재생한다.
    await waitUntilPreviewLoaded(el)
    // stale이면 그냥 물러난다 — 요소는 하나뿐이라 여기서 pause() 하면 새 세대의 재생을 죽인다.
    // 정지 책임은 무효화한 쪽(stopReferencePreview·새 요청)이 이미 졌다.
    if (stale()) return
    // 로드가 실패했어도 play()는 반드시 시도한다 — 실패 신호를 한 곳(play 거부)에서 받아 오류로 노출하기 위해.
    if (!advance({ kind: 'ready' })) return
    try { el.currentTime = region ? Math.max(0, region.start) : 0 } catch { /* noop */ }

    // (5) play() 프로미스는 정착하지 않을 수도 있다(로드가 멈춘 요소). 반드시 타임아웃과 경주시켜
    //     직렬화 큐를 풀어 준다 — 그러지 않으면 한 번의 실패가 이후 모든 미리듣기를 영구 무음으로 만든다.
    const result = await Promise.race([
      el.play().then(() => 'ok', (e: unknown) => 'rejected:' + ((e as Error)?.name || '')),
      new Promise<string>((r) => setTimeout(() => r('timeout'), 4000)),
    ])
    if (stale()) return
    if (result !== 'ok') {
      // 거부를 삼키지 않는다. 새 요청이 끊어서 생긴 거부만 stale로 조용히 폐기되고, 나머지는 화면에 뜬다.
      // NotSupportedError = 소스를 못 읽은 것(파일 이동·삭제), 그 밖은 재생 자체가 시작되지 못한 것.
      discardPreviewElement()
      fail(el.error || result.includes('NotSupportedError') ? 'load' : 'play')
      return
    }
    if (region && region.duration > 0) {
      // 구간 재생 — 원본을 구간 시작에서 틀고 구간 길이 뒤에 멈춘다. 임시 클립의 존재·수명에 기대지 않는다.
      const stopGen = gen
      setTimeout(() => { if (decideAsyncResult(_previewSession, stopGen) !== 'discard') pausePreview() },
        Math.round(region.duration * 1000))
    }
    advance({ kind: 'play' })
  } catch {
    if (stale()) return
    discardPreviewElement()
    fail('load')
  }
}

// 4-flow 셸(통합 담당, 정정11). A의 EmotionScriptEditor + C의 TtsVoiceSection·EmotionReferenceManager·
// ExpressionControls를 실제 props 계약으로 배선한다. 편집 알고리즘은 A 컴포넌트가 소유(I5-b는 그 동작 검증).
// 모든 effect/analyze/preflight는 이 단일 컴포넌트에 유지 → 신규 하위 패널 재렌더로 중복 실행되지 않는다.
export default function TTSEditor() {
  const { mode, status, fileInfo, ttsEmotionRefState, ttsSpeakerRefState, ttsSpeakerLabels, ttsSpeakerEmotionRefs,
    ttsSpeakerEmotionEnabled, setSpeakerEmotionEnabled, ttsSpeakerMode, setTtsSpeakerMode,
    registerSpeakerRef, removeSpeakerRef, setSpeakerRefState, setSpeakerInherit, moveSpeakerRef, ttsSpeakerInherit,
    registerEmotionRef, removeEmotionRef, setEmotionRefState, setTtsRefState, ttsRefReady, ttsRefMessage, ttsReferenceClip, ttsPitchCapability, setTtsPitchCapability,
    ttsTailMode, ttsTailPaddingMs, ttsTailFadeMs, ttsEmotionBoundaryMode, ttsEmotionBoundaryPauseMs, setTtsExpression,
    ttsReferenceConditioningMode, setTtsReferenceConditioningMode,
    setSpeakerEmotionRefs } = useAppStore()
  // 로컬 상태는 store 값으로 초기화 — 빈 값으로 시작하면 아래 동기화 useEffect가 다른 모드에 다녀온 뒤 store를 덮어써 유실시킴
  const [ttsText, setTtsText] = useState(() => useAppStore.getState().ttsText)
  const [ttsSpeed, setTtsSpeed] = useState(() => useAppStore.getState().ttsSpeed)
  const [ttsSilenceGap, setTtsSilenceGap] = useState(() => useAppStore.getState().ttsSilenceGap)
  const [ttsPitch, setTtsPitch] = useState(() => useAppStore.getState().ttsPitch)
  const [ttsEngine, setTtsEngine] = useState(() => useAppStore.getState().ttsEngine)
  const [refPrompts, setRefPrompts] = useState<Record<string, TtsReferenceEntry>>(() => useAppStore.getState().ttsReferencePrompts)
  const [showRefPrompts, setShowRefPrompts] = useState(false)

  // ── 참조 목소리 보관함 배선 — renderer 는 논리 ID 만 다룬다(경로는 import 요청에만 실린다). ──
  const ttsReferenceRegion = useAppStore((s) => s.ttsReferenceRegion)
  const [refAssets, setRefAssets] = useState<{ status: ReferenceLibraryStatus; items: ReferenceLibraryItem[] }>(
    { status: 'ok', items: [] }
  )
  const [refAssetBusy, setRefAssetBusy] = useState(false)
  const [refAssetNotice, setRefAssetNotice] = useState<string | null>(null)

  // ── 감정·표현 미리듣기 배선 ──
  // renderer 는 rowId 만 보낸다. cacheKey 는 main 이 계산해 응답으로 돌려준 값만 보관하고,
  // 생성 요청에는 절대 실어 보내지 않는다(권위는 main 이다).
  const [samplerRows, setSamplerRows] = useState<string[]>([])
  const [samplerKeys, setSamplerKeys] = useState<Record<string, string>>({})
  const [samplerBusyRow, setSamplerBusyRow] = useState<string | null>(null)
  const [samplerNotice, setSamplerNotice] = useState<string | null>(null)
  const samplerPlayer = useRef<ReturnType<typeof createEmotionSamplePreviewPlayer> | null>(null)

  const selectedRefId = useMemo(
    () => refAssets.items.find((i) => i.selected) ?? null,
    [refAssets.items]
  )
  const samplerReferenceReady = !!selectedRefId && selectedRefId.ready && selectedRefId.transcript === 'present'

  // 표시용 엔트리. cacheKey 자리는 main 이 돌려준 값이 있을 때만 실제 키이고,
  // 없으면 자리표시자다(어떤 IPC 입력으로도 쓰이지 않는다).
  const samplerEntries: EmotionSampleEntry[] = useMemo(() => samplerRows.map((rowId) => {
    const cap = capabilityForRow(rowId)
    const capState = stateForCapability(cap)
    const key = samplerKeys[rowId]
    const state = key ? 'ready' : capState
    return {
      rowId,
      state: state as EmotionSampleEntry['state'],
      reason: state === 'ready' ? null : cap.reason,
      cacheKey: key ?? '0'.repeat(64),
    }
  }), [samplerRows, samplerKeys])

  const refreshSamplerCache = async (): Promise<void> => {
    const res = await window.api.sampler.inventory()
    // 우리가 아는 행의 키만 남긴다 — 목록에 없는 키는 다른 설정으로 만든 것이다.
    setSamplerKeys((prev) => {
      const alive = new Set(res.keys)
      const next: Record<string, string> = {}
      for (const [rowId, key] of Object.entries(prev)) if (alive.has(key)) next[rowId] = key
      return next
    })
  }

  const stopSamplerPreview = (): void => { samplerPlayer.current?.stop() }

  const generateSample = async (rowId: string): Promise<void> => {
    if (!selectedRefId) { setSamplerNotice(SAMPLER_FAILURE_TEXT.NO_REFERENCE_SELECTED); return }
    setSamplerBusyRow(rowId)
    setSamplerNotice(null)
    try {
      const res = await window.api.sampler.generate({ referenceId: selectedRefId.referenceId, rowId })
      if (res.ok) setSamplerKeys((p) => ({ ...p, [rowId]: res.cacheKey }))
      else setSamplerNotice(SAMPLER_FAILURE_TEXT[res.reason] ?? '샘플을 만들지 못했습니다.')
    } finally {
      setSamplerBusyRow(null)
    }
  }

  const auditionSample = async (rowId: string): Promise<void> => {
    const key = samplerKeys[rowId]
    if (!key) return
    const res = await window.api.sampler.previewUrl({ cacheKey: key })
    if (!res.ok) { setSamplerNotice('저장된 샘플을 찾을 수 없습니다.'); return }
    if (!samplerPlayer.current) {
      samplerPlayer.current = createEmotionSamplePreviewPlayer(
        browserPreviewDeps(EMOTION_PREVIEW_SILENCE_MS, {
          onError: () => setSamplerNotice('미리듣기를 재생하지 못했습니다.'),
        })
      )
    }
    samplerPlayer.current.play(rowId, res.url)
  }

  const deleteSample = async (rowId: string): Promise<void> => {
    const key = samplerKeys[rowId]
    if (!key) return
    stopSamplerPreview()
    const res = await window.api.sampler.remove({ cacheKey: key })
    if (!res.ok) { setSamplerNotice('샘플을 삭제하지 못했습니다.'); return }
    setSamplerKeys((p) => { const next = { ...p }; delete next[rowId]; return next })
  }

  // 언마운트·모드 전환에서 재생을 정리한다(요소·타이머가 남지 않게).
  useEffect(() => () => { samplerPlayer.current?.dispose(); samplerPlayer.current = null }, [])

  const refreshRefAssets = async (): Promise<void> => {
    const res = await window.api.referenceLibrary.list()
    setRefAssets({ status: res.status, items: res.items })
  }

  const importCurrentReference = async (): Promise<void> => {
    if (!fileInfo?.path || !ttsReferenceRegion) return
    setRefAssetBusy(true)
    setRefAssetNotice(null)
    try {
      // 경로가 renderer 를 떠나는 유일한 지점. 응답에는 논리 ID 만 돌아온다.
      const res = await window.api.referenceLibrary.import({
        filePath: fileInfo.path,
        regionStartMs: Math.round(ttsReferenceRegion.start * 1000),
        regionDurationMs: Math.round(ttsReferenceRegion.duration * 1000),
        // 현재 원본·구간에 연결된 확정 전사만 넘긴다. store 는 원본이 바뀌면 prompts 를 비우므로
        // 다른 원본의 전사가 섞이지 않는다. 확정 전사가 없으면 빈 값으로 두고 sidecar 를 만들지 않는다.
        transcript: refPrompts['default']?.manualText ?? '',
        transcriptLanguage: refPrompts['default']?.promptLang ?? '',
      })
      if (!res.ok) setRefAssetNotice(REF_ASSET_FAILURE_TEXT[res.reason] ?? '참조를 저장하지 못했습니다.')
      await refreshRefAssets()
    } finally {
      setRefAssetBusy(false)
    }
  }

  const selectRefAsset = async (referenceId: string): Promise<void> => {
    const res = await window.api.referenceLibrary.select(referenceId)
    // 실패해도 다른 참조로 대신 고르지 않는다 — 사유만 알리고 선택은 그대로 둔다.
    if (!res.ok) setRefAssetNotice(REF_ASSET_FAILURE_TEXT[res.reason] ?? '참조를 사용할 수 없습니다.')
    else setRefAssetNotice(null)
    await refreshRefAssets()
  }

  const removeRefAsset = async (referenceId: string): Promise<void> => {
    const res = await window.api.referenceLibrary.remove(referenceId)
    if (!res.ok) setRefAssetNotice(REF_ASSET_FAILURE_TEXT[res.reason] ?? '참조를 삭제하지 못했습니다.')
    else setRefAssetNotice(null)
    await refreshRefAssets()
  }
  const [txLoading, setTxLoading] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<{ available?: boolean; snapshot_ok?: boolean; device_expected?: string; reason?: string } | null>(null)
  // ── PHASE B 기본 화면 상태 ──
  // 고급 설정(4탭)의 열림·탭은 셸이 소유한다 — 결과 오류 카드가 특정 자리를 열어 달라고 요청할 수 있어야 한다.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [advancedTab, setAdvancedTab] = useState<TtsAdvancedTab>('voice')
  // '사용 구간 바꾸기' — 평소에는 접혀 있고, 앱이 자동으로 고른 구간을 그대로 쓴다.
  const [regionOpen, setRegionOpen] = useState(false)
  const [showRefModeHelp, setShowRefModeHelp] = useState(false)
  // 감정 미리듣기(기본 화면 3종) — 사용자가 버튼을 눌러야 시작하고, 한 번에 하나씩 직렬로 만든다.
  const [quickPreparing, setQuickPreparing] = useState(false)
  const [quickBusyRow, setQuickBusyRow] = useState<string | null>(null)
  const [quickNotice, setQuickNotice] = useState<string | null>(null)
  const [showAllTags, setShowAllTags] = useState(false)
  // I5-a 표현 흐름 UI 상태(셸 로컬 — '고급 기능(세부 조절)'과 '패널 펼치기'는 컴포넌트가 각자 별도 관리, 정정 I5-c).
  const [presetId, setPresetId] = useState('original')
  const [fineTuneEnabled, setFineTuneEnabled] = useState(false)
  const [detailFineTune, setDetailFineTune] = useState(false)   // 세부 표현 '직접 조절'(ExpressionControls fineTune과 별개)
  const [showSettingHelp, setShowSettingHelp] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)   // 감정 참조 미리듣기 실패(사용자 언어)
  const editorRef = useRef<EmotionScriptEditorHandle>(null)
  const pitchCap = ttsPitchCapability
  const disabled = status === 'processing'

  // Sync to store (감정 참조 상태는 store가 단일 소스라 여기서 동기화하지 않는다)
  useEffect(() => {
    useAppStore.setState({ ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, ttsReferencePrompts: refPrompts, ttsEngine })
  }, [ttsText, ttsSpeed, ttsSilenceGap, ttsPitch, refPrompts, ttsEngine])

  // Qwen preflight — 마운트 시 1회(mode 의존). 예상값이며 실행 결과는 결과 화면 metadata가 최종.
  useEffect(() => {
    if (mode !== 'tts') return
    let cancelled = false
    window.api.audio.qwenPreflight()
      .then((p: unknown) => { if (!cancelled) setPreflight(p as typeof preflight) })
      .catch(() => { if (!cancelled) setPreflight(null) })
    return () => { cancelled = true }
  }, [mode])

  // pitch 후처리 capability(§6) — ffmpeg rubberband 지원 여부. 미지원이면 슬라이더 비활성 + 사유 표시.
  useEffect(() => {
    if (mode !== 'tts') return
    let cancelled = false
    window.api.audio.pitchPreflight()
      .then((cap: unknown) => {
        if (cancelled) return
        const c = cap as PitchCapability | null
        setTtsPitchCapability(c && typeof c.probed === 'boolean' ? c : { supported: false, method: 'none', probed: true, reason: 'pitch-probe-failed' })
      })
      .catch(() => { if (!cancelled) setTtsPitchCapability({ supported: false, method: 'none', probed: true, reason: 'pitch-probe-failed' }) })
    return () => { cancelled = true }
  }, [mode])

  // 미리듣기 오류를 화면에 띄우기 위한 sink 등록 + 컴포넌트 해제(모드 전환 등) 시 재생 정지(잔여 재생 방지).
  useEffect(() => {
    setReferencePreviewErrorSink(setPreviewError)
    return () => { setReferencePreviewErrorSink(null); stopReferencePreview() }
  }, [])

  // 결과 오류 카드의 '참조 전사 확인'이 고급 설정 > 음성의 전사 자리를 열 수 있게 한다.
  // (전사 패널이 접힌 고급 안으로 들어가면서 DOM 에 없을 수 있게 됐다 — 막다른 길 방지.)
  useEffect(() => {
    setTtsAdvancedOpener((target) => {
      if (target !== 'referenceTranscript') return
      setAdvancedOpen(true)
      setAdvancedTab('voice')
      setShowRefPrompts(true)
    })
    return () => setTtsAdvancedOpener(null)
  }, [])

  // ── 목소리 교체(기본 화면 '다른 목소리 선택') ────────────────────────────
  // TTS 에서 참조 목소리는 곧 지금 올린 파일이다. 새 IPC 를 만들지 않고 기존 파일 적재 경로를 그대로 쓴다.
  // setFile 이 이전 파생 클립·준비 상태·전사를 정리하므로 다른 원본의 흔적이 새 목소리에 섞이지 않는다.
  const pickAnotherVoice = async (): Promise<void> => {
    if (disabled) return
    const p = await window.api.audio.selectFile()
    if (!p) return
    try {
      const info = await window.api.audio.getFileInfo(p)
      const url = await window.api.audio.getFileUrl(p)
      ensuredReferenceKey.current = ''
      setSamplerKeys({})
      setQuickNotice(null)
      setRegionOpen(false)
      useAppStore.getState().setFile(info, url)
    } catch {
      setQuickNotice('이 파일을 열 수 없습니다. 다른 파일을 골라 주세요.')
    }
  }

  // ── 감정 미리듣기용 목소리 준비(앱 내부 자동 처리) ────────────────────────
  // 샘플러는 '보관함에 저장된 참조 + 그 전사'를 요구한다. 그 저장·해시·재사용은 사용자에게 보일 일이
  // 아니므로(PHASE B) 여기서 조용히 해 둔다. 다만 **사용자가 버튼을 누른 뒤에만** 한다 —
  // 화면에 들어왔다는 이유로 파이썬을 돌리지 않는다.
  const ensuredReferenceKey = useRef<string>('')
  const ensureReferenceForSampler = async (): Promise<{ ok: true; referenceId: string } | { ok: false; message: string }> => {
    if (!fileInfo?.path) return { ok: false, message: '먼저 목소리로 쓸 소리 파일을 올려 주세요.' }
    if (!ttsRefReady) return { ok: false, message: ttsRefMessage || '목소리를 준비하는 중입니다. 잠시 뒤 다시 눌러 주세요.' }

    // 미리듣기가 실제 합성과 **같은 소리**를 쓰게 구간을 명시한다.
    //   · 10초 초과 원본 → 확정된 구간(ttsReferenceRegion)
    //   · 3~10초 원본     → 원본 전체(구간 개념이 없다) = 0부터 파일 길이
    // 구간을 비워 보내면 main 이 자기 기본값으로 다른 데를 자를 수 있어, 들어 본 목소리와 합성 목소리가
    // 어긋난다. 그래서 어느 경우에도 값을 준다.
    const confirmed = useAppStore.getState().ttsReferenceRegion
    const wholeSec = Math.min(10, fileInfo.duration || 0)
    const region = confirmed ?? (wholeSec > 0 ? { start: 0, duration: wholeSec } : null)
    const key = `${fileInfo.path}|${region ? `${region.start.toFixed(3)}:${region.duration.toFixed(3)}` : 'whole'}`

    // 이미 이 목소리로 준비돼 있고 선택도 살아 있으면 다시 저장하지 않는다(중복 파이썬 실행 방지).
    const before = await window.api.referenceLibrary.list()
    setRefAssets({ status: before.status, items: before.items })
    const already = before.items.find((i) => i.selected)
    if (ensuredReferenceKey.current === key && already && already.ready && already.transcript === 'present') {
      return { ok: true, referenceId: already.referenceId }
    }

    // 전사 확보 — 사용자가 직접 확정해 둔 것이 있으면 그것을 쓰고, 없으면 앱이 스스로 인식한다.
    // 인식 결과는 어디에도 표시하지 않는다(내용 미노출). 실패하면 그대로 알리고 멈춘다.
    let transcript = (refPrompts['default']?.manualText || '').trim()
    let transcriptLanguage = refPrompts['default']?.promptLang || ''
    if (!transcript) {
      try {
        const t = await window.api.audio.transcribeReference(ttsReferenceClip || fileInfo.path) as {
          status?: string; text?: string; language?: string
        }
        if (t?.status === 'ok' && (t.text || '').trim()) {
          transcript = (t.text as string).trim()
          transcriptLanguage = t.language || ''
        }
      } catch { /* 아래 공통 실패 문구로 떨어진다 */ }
    }
    if (!transcript) {
      return { ok: false, message: '목소리가 무슨 말을 하는지 확인하지 못해 미리듣기를 만들 수 없습니다. 더 또렷한 구간을 골라 주세요.' }
    }

    const imported = await window.api.referenceLibrary.import({
      filePath: fileInfo.path,
      regionStartMs: region ? Math.round(region.start * 1000) : undefined,
      regionDurationMs: region ? Math.round(region.duration * 1000) : undefined,
      transcript,
      transcriptLanguage,
    })
    if (!imported.ok) {
      return { ok: false, message: REF_ASSET_FAILURE_TEXT[imported.reason] ?? '목소리를 미리듣기에 쓸 수 있게 준비하지 못했습니다.' }
    }
    const selected = await window.api.referenceLibrary.select(imported.referenceId)
    if (!selected.ok) {
      return { ok: false, message: '준비한 목소리를 사용할 수 없습니다. 다른 구간을 골라 주세요.' }
    }
    ensuredReferenceKey.current = key
    await refreshRefAssets()
    return { ok: true, referenceId: imported.referenceId }
  }

  // 기쁨 → 화남 → 슬픔을 **직렬**로 만든다. 하나가 끝나야 다음이 시작한다(동시 실행 없음).
  // 이미 만들어 둔 것(캐시)은 건너뛴다 — '다시 만들기'도 캐시를 지우지 않고 없는 것만 채운다.
  const runQuickEmotionPreview = async (): Promise<void> => {
    if (quickPreparing || quickBusyRow) return
    setQuickNotice(null)
    setQuickPreparing(true)
    const ready = await ensureReferenceForSampler()
    setQuickPreparing(false)
    if (!ready.ok) { setQuickNotice(ready.message); return }

    const made: Record<string, string> = { ...samplerKeys }
    for (const rowId of QUICK_EMOTION_ROW_IDS) {
      if (made[rowId]) continue
      setQuickBusyRow(rowId)
      try {
        const res = await window.api.sampler.generate({ referenceId: ready.referenceId, rowId })
        if (res.ok) {
          made[rowId] = res.cacheKey
          setSamplerKeys((p) => ({ ...p, [rowId]: res.cacheKey }))
        } else {
          setQuickNotice(SAMPLER_FAILURE_TEXT[res.reason] ?? '미리듣기를 만들지 못했습니다.')
          break
        }
      } catch {
        setQuickNotice('미리듣기를 만들지 못했습니다.')
        break
      } finally {
        setQuickBusyRow(null)
      }
    }
    // 고급 설정의 전체 목록에서도 같은 행을 볼 수 있게 목록에 넣어 둔다(같은 캐시를 공유한다).
    setSamplerRows((r) => {
      const next = [...r]
      for (const id of QUICK_EMOTION_ROW_IDS) if (!next.includes(id)) next.push(id)
      return next
    })
  }

  const updateRef = (id: string, patch: Partial<TtsReferenceEntry>) =>
    setRefPrompts(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }))

  // 수동 전사 '확정' 시 그 참조 source의 지문을 stamp(§4 stale 방지).
  const stampFingerprint = async (id: string, sourcePath: string) => {
    if (!sourcePath) return
    try {
      const fp = await window.api.audio.fingerprintReference(sourcePath)
      if (fp) updateRef(id, { sourceFingerprint: fp })
    } catch { /* 지문 실패 시 stamp 생략 — 불변식(4)이 미기록을 '보존'으로 처리 */ }
  }

  const autoTranscribe = async (id: string, path: string) => {
    if (!path || txLoading) return
    setTxLoading(id)
    try {
      const t = await window.api.audio.transcribeReference(path) as {
        status?: string; text?: string; language?: string; error_message?: string
      }
      const ok = t?.status === 'ok'
      updateRef(id, {
        autoStatus: t?.status || 'failed',
        autoText: ok ? (t?.text ?? '') : '',
        autoLang: ok ? (t?.language ?? '') : '',
        autoError: ok ? undefined : (t?.error_message || t?.status || '전사 실패')
      })
    } catch (e) {
      updateRef(id, { autoStatus: 'failed', autoError: (e as Error)?.message || '전사 실패' })
    } finally {
      setTxLoading(null)
    }
  }

  const useAutoAsManual = (id: string, sourcePath: string) => {
    updateRef(id, { manualText: (refPrompts[id]?.autoText || ''), mode: 'manual' })
    void stampFingerprint(id, sourcePath)
  }
  const onManualEdit = (id: string, text: string) =>
    updateRef(id, { manualText: text, mode: text.trim() ? 'manual' : 'auto' })
  const onRefFreeToggle = (id: string, checked: boolean) =>
    updateRef(id, { mode: checked ? 'ref_free' : ((refPrompts[id]?.manualText || '').trim() ? 'manual' : 'auto') })

  // 감정 요약(§1) — 대사에 실제 쓰인 감정 + 미등록 안내(§3).
  const usedIds = useMemo(() => parseUsedEmotionIds(ttsText), [ttsText])
  // 입력 분석(읽기 전용 보조). 실패·지연은 상태일 뿐이고 합성·편집을 막지 않는다.
  const analysis = useInputAnalysis(ttsText, { enabled: !disabled })
  const nonDefaultEmotions = useMemo(() => ALL_EMOTIONS.filter(e => e.id !== 'default'), [])

  // 팔레트 정렬: 대사에 이미 쓰인 감정을 앞으로(첫 등장 순 = parseUsedEmotionIds 순서), 그 뒤 자주 쓰는 감정.
  // 사용 중인 감정이 자주 쓰는 목록 밖이어도 팔레트에서 바로 다시 삽입할 수 있어야 한다.
  // (parseUsedEmotionIds가 Set을 첫 등장 순으로 채우므로 Set 순회가 곧 첫 등장 순이다.)
  const paletteTags = useMemo(() => {
    const byId = new Map(nonDefaultEmotions.map(e => [e.id, e]))
    const used = [...usedIds].map(id => byId.get(id)).filter((e): e is Emotion => !!e)
    return [...used, ...FREQUENT_TAGS.filter(e => !usedIds.has(e.id))]
  }, [usedIds, nonDefaultEmotions])

  if (mode !== 'tts') return null

  // ── EmotionReferenceManager 입력 배선 ──
  const registeredEmotions = nonDefaultEmotions.filter(e => ttsEmotionRefState[e.id]?.source)
  // 대사에 쓰였지만 미등록 → '기본 목소리 사용' 행으로 같은 목록에 실어 보낸다(별도 안내 문단 대체).
  const usedUnregistered = nonDefaultEmotions.filter(e => usedIds.has(e.id) && !ttsEmotionRefState[e.id]?.source)
  const managerRefs = [
    ...registeredEmotions.map(e => {
      const slot = ttsEmotionRefState[e.id]
      return { emotionId: e.id, registered: true, ready: !!slot?.ready, region: slot?.region ?? undefined }
    }),
    ...usedUnregistered.map(e => ({ emotionId: e.id, registered: false, ready: false })),
  ]
  // 목록 상단 우선순위(첫 등장 순). Set 순회 = 첫 등장 순.
  const usedEmotionIdList = [...usedIds]

  // ── 화자별 목소리 ────────────────────────────────────────────────────────
  // 인물 목록·발화 수는 **계획이 센 값**이다(화면이 다시 세지 않는다). 준비 여부는 store,
  // 실제로 어느 목소리가 쓰일지는 공용 판정(Python 권위의 거울)이 정한다.
  // 준비 판정 표 — ProcessButton 의 preflight·전송과 **같은 함수, 같은 슬롯**. 화면이 준비됨이면 config 에도 있다.
  const speakerReadiness = readinessFromSlots({
    defaultReady: !!ttsRefReady,
    speakerSlots: ttsSpeakerRefState,
    emotionSlots: ttsEmotionRefState,
    speakerEmotionRefs: gateSpeakerEmotionRefs(ttsSpeakerEmotionRefs, ttsSpeakerEmotionEnabled),
  })
  const speakerFingerprints = Object.fromEntries(
    Object.entries(ttsSpeakerRefState).map(([id, s]) => [id, s.ready ? (s.clip || s.source) : '']))
  const sharedGroups = sharedReferenceGroups(speakerFingerprints)
  const speakerLabelOf = (id: string) => ttsSpeakerLabels[id] || id
  const speakerUiRows: SpeakerRow[] = planSpeakerRows(analysis.result).map((k) => {
    const slot = ttsSpeakerRefState[k.speakerId]
    const fp = speakerFingerprints[k.speakerId]
    const shared = (fp && sharedGroups[fp] ? sharedGroups[fp] : [])
      .filter((id) => id !== k.speakerId).map(speakerLabelOf)
    return {
      speakerId: k.speakerId,
      label: k.label,
      utteranceCount: k.utteranceCount,
      registered: !!slot,
      ready: !!slot?.ready,
      message: slot?.message || '',
      region: slot?.region ?? null,
      // 폴더는 화면에 내보내지 않는다 — 파일 이름만.
      fileName: (slot?.source || '').split(/[\\/]/).pop() || '',
      sharedWith: shared,
      decision: resolveReferenceDecision(k.speakerId, null, speakerReadiness),
    }
  })
  // ── 한 명 | 여러 명 = 이 작업의 **생성 방식**(speakerMode). 대본 내용이 아니라 라우팅 방식이다. ──
  // 탭 클릭은 store 의 ttsSpeakerMode 만 바꾼다. 원문·인물 설정·목소리 자산은 그대로다(확인창 없음).
  const dialogueTab: DialogueTab = ttsSpeakerMode
  const setDialogueTab = (t: DialogueTab) => { if (!disabled) setTtsSpeakerMode(t) }
  const speakerDirectives = useMemo(() => speakerDirectiveSequence(ttsText), [ttsText])
  // 한 명 편집기는 제한이 없다. 화자 표기를 지우거나 바꿔도 막지 않는다 — 오류가 아닌 알림 한 줄과
  // 되돌리기만 둔다. 되돌리기는 그 한 번의 편집 직전 원문으로 돌리고, 다음 편집이 오면 알림은 사라진다
  // (뒤에 이어 친 글자까지 삼키지 않기 위해). 목소리 자산·목소리 구성은 어느 경우에도 건드리지 않는다.
  const [structureNotice, setStructureNotice] = useState<{ prevText: string } | null>(null)
  // 여러 명 화면의 원문 직접 편집(고급). 열려 있는 동안 발화 카드는 숨긴다 — 두 편집기를 동시에 고치지 않는다.
  // 닫으면 현재 ttsText 의 분석 결과가 그대로 카드로 보인다(별도 변환 없음).
  const [directEditOpen, setDirectEditOpen] = useState(false)
  const onSingleEditorChange = (next: string) => {
    if (disabled) return
    const nextSeq = speakerDirectiveSequence(next)
    const changed = speakerDirectives.length !== nextSeq.length
      || speakerDirectives.some((d, i) => d !== nextSeq[i])
    setStructureNotice(changed ? { prevText: ttsText } : null)
    setTtsText(next)
  }
  const undoStructureChange = () => {
    if (disabled || !structureNotice) return
    setTtsText(structureNotice.prevText)
    setStructureNotice(null)
  }
  // 권위는 ttsText 하나. 이 훅은 계획을 projection 으로 보여 주고 명령을 patcher 로 되쓴다.
  const dialogue = useDialogueProjection(ttsText, (next) => { if (!disabled) setTtsText(next) },
    analysis.result)
  const emotionTagOf = (id: string) => '[' + (EMOTION_ID_TO_LABEL[id] ?? id) + ']'
  // 원문 편집기가 보이는 때: 한 명 | 여러 명의 직접 편집 열림 | 구조화할 수 없는 대본(이유와 함께).
  const showRawEditor = dialogueTab === 'single' || directEditOpen || !dialogue.editingAllowed
  // 구조화할 수 없는 대본이 되면(직접 편집 details 가 사라지면) 열림 상태도 접는다 — 다시 구조화되면 카드가 바로 보인다.
  useEffect(() => { if (!dialogue.editingAllowed) setDirectEditOpen(false) }, [dialogue.editingAllowed])
  // 이 인물의 어떤 감정에 목소리 구성이 다른 음원을 지정했는가(감정 라벨). 'default' 는 표기 없는
  // 대사까지 전부 덮는다는 뜻이라 따로 말한다.
  const emotionLabelOf = (eid: string) => (eid === 'default' ? '기본(표기 없는 대사 전부)' : (EMOTION_ID_TO_LABEL[eid] ?? eid))
  // 구성이 이 인물에 대해 가진 감정(켜짐 무관) / 실제 생성으로 나가는 감정(켠 인물만).
  const emotionVoiceAvailableOf = (speakerId: string): string[] =>
    emotionIdsForSpeaker(ttsSpeakerEmotionRefs, speakerId).map(emotionLabelOf)
  const emotionOverridesOf = (speakerId: string): string[] =>
    emotionIdsForSpeaker(gateSpeakerEmotionRefs(ttsSpeakerEmotionRefs, ttsSpeakerEmotionEnabled), speakerId).map(emotionLabelOf)
  const speakerVoiceOf = (speakerId: string) => {
    const row = speakerUiRows.find((r) => r.speakerId === speakerId)
    if (row) {
      return { registered: row.registered, ready: row.ready, fileName: row.fileName, decision: row.decision,
        region: row.region ?? null, message: row.message,
        sharedWith: row.sharedWith, emotionOverrides: emotionOverridesOf(speakerId),
        emotionVoiceAvailable: emotionVoiceAvailableOf(speakerId),
        emotionVoiceEnabled: ttsSpeakerEmotionEnabled[speakerId] === true }
    }
    // 원문에 아직 없는 인물(pending)도 같은 store 슬롯을 본다.
    const slot = ttsSpeakerRefState[speakerId]
    if (!slot) return null
    const fp = speakerFingerprints[speakerId]
    return {
      registered: true, ready: !!slot.ready,
      region: slot.region ?? null, message: slot.message,
      fileName: (slot.source || '').split(/[\\/]/).pop() || '',
      decision: resolveReferenceDecision(speakerId, null, speakerReadiness),
      sharedWith: (fp && sharedGroups[fp] ? sharedGroups[fp] : []).filter((id) => id !== speakerId).map(speakerLabelOf),
      emotionOverrides: emotionOverridesOf(speakerId),
      emotionVoiceAvailable: emotionVoiceAvailableOf(speakerId),
      emotionVoiceEnabled: ttsSpeakerEmotionEnabled[speakerId] === true,
    }
  }

  // ── 여러 명 첫 인물의 초기 목소리 — 처음 불러온 음성(기본 목소리)을 **명시적으로 이어받는다** ──
  // 사용자 순서: 파일 불러오기 → 합성 → 기본 목소리 준비(구간 자동 확정) → 여러 명 전환.
  //   · 첫 인물(계획의 1번 인물, 빈 대본이면 시작 카드 '인물1')에 store 슬롯을 만들고 이어받기 플래그를 세운다.
  //   · 아래 동기화 effect 가 기본 목소리의 **원본·확정 구간·유효 참조**를 그 슬롯으로 옮긴다. 확정 클립은 main 이
  //     인물 key 로 복사(adopt)해 소유권을 분리한다 — 기본 목소리를 다시 확정/해제해도 인물의 참조는 남는다.
  //   · 이미 준비된 참조를 다시 고르거나 다시 확정하게 하지 않는다. 준비 도중 전환했으면 완료 시 같은 결과로 갱신한다.
  //   · 어느 인물이든 이미 목소리가 있으면 개입하지 않는다. 한 파일·한 인물 id 당 한 번. 2번 이후 인물은 자동 연결 없음.
  //   · 사용자가 그 인물의 목소리를 바꾸거나 해제하면 플래그가 지워져(store) 이 effect 들이 덮어쓰지 않는다.
  //     그 뒤 한 명 기본 목소리와 여러 명 인물 목소리는 독립이다(슬롯이 다르다).
  const firstDialogueSpeaker = dialogue.speakers[0]
  const firstSpeakerVoiceId = !firstDialogueSpeaker ? ''
    : (firstDialogueSpeaker.pending
      ? (validateSpeakerLabel(firstDialogueSpeaker.label.trim()).ok ? normalizeSpeakerId(firstDialogueSpeaker.label.trim()) : '')
      : firstDialogueSpeaker.speakerId)
  const initialSpeakerBind = useRef<string>('')
  useEffect(() => {
    if (ttsSpeakerMode !== 'multi' || !fileInfo?.path || !firstSpeakerVoiceId) return
    if (Object.keys(ttsSpeakerRefState).length > 0) return
    const key = `${fileInfo.path}|${firstSpeakerVoiceId}`
    if (initialSpeakerBind.current === key) return
    initialSpeakerBind.current = key
    registerSpeakerRef(firstSpeakerVoiceId, fileInfo.path, firstDialogueSpeaker?.label)
    setSpeakerInherit({ speakerId: firstSpeakerVoiceId, filePath: fileInfo.path })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsSpeakerMode, fileInfo?.path, firstSpeakerVoiceId, Object.keys(ttsSpeakerRefState).length])
  // 동기화: 기본 목소리가 준비되는 순간(또는 이미 준비돼 있으면 즉시) 같은 준비 결과를 첫 인물 슬롯에 옮긴다.
  const inheritSlotSource = ttsSpeakerInherit ? (ttsSpeakerRefState[ttsSpeakerInherit.speakerId]?.source ?? '') : ''
  useEffect(() => {
    const inh = ttsSpeakerInherit
    if (!inh || !fileInfo?.path || inh.filePath !== fileInfo.path) return
    if (!inheritSlotSource || inheritSlotSource !== inh.filePath) return   // 사용자가 다른 원본을 골랐다 → 개입하지 않음
    const id = inh.speakerId
    if (!ttsRefReady) {
      // 기본 목소리 준비 중 — 같은 사유를 보여 주고, 완료되면 아래 분기가 갱신한다. 실제 실패 사유만 그대로.
      setSpeakerRefState(id, { ready: false, message: ttsRefMessage || '목소리 확인 중' })
      return
    }
    if (!ttsReferenceClip) {
      // 원본 전체가 유효 — 같은 원본을 그대로 유효 참조로.
      setSpeakerRefState(id, { clip: '', region: null, ready: true, message: '' })
      setSpeakerInherit(null)
      return
    }
    let cancelled = false
    void (async () => {
      let adopted = ''
      try { adopted = String((await window.api.audio.adoptReferenceClip('default', 'spk:' + id)) || '') } catch { adopted = '' }
      if (cancelled) return
      if (adopted) {
        setSpeakerRefState(id, { clip: adopted, region: ttsReferenceRegion ?? null, ready: true, message: '' })
        setSpeakerInherit(null)
      } else {
        setSpeakerRefState(id, { ready: false, message: '기본 목소리의 구간을 이어받지 못했습니다 — 인물 카드에서 구간을 확정해 주세요' })
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsSpeakerInherit, fileInfo?.path, inheritSlotSource, ttsRefReady, ttsReferenceClip, ttsReferenceRegion, ttsRefMessage])

  const requestSpeakerSource = async (): Promise<string | null> => {
    const p = await window.api.audio.selectFile()
    return p || null
  }
  // 구간 편집기는 감정과 **같은 것**을 쓴다(clipKey 만 화자용으로 분리).
  const renderSpeakerRegion = (speakerId: string, open = true) => {
    const src = ttsSpeakerRefState[speakerId]?.source || ''
    if (!src) return null
    return (
      <ReferenceRegionPanel
        key={src}
        clipKey={'spk:' + speakerId}
        path={src}
        disabled={disabled}
        committed={ttsSpeakerRefState[speakerId]?.ready
          ? { clip: ttsSpeakerRefState[speakerId].clip, region: ttsSpeakerRefState[speakerId].region } : null}
        onState={(s) => setSpeakerRefState(speakerId, s)}
        label={`${speakerLabelOf(speakerId)} 목소리`}
        open={open}
        plainStatus={!open}
      />
    )
  }

  // 셸이 파일 선택 다이얼로그를 주입(EmotionReferenceManager는 파일 I/O를 하지 않음).
  // ── 배역 세트(R2-b) ──────────────────────────────────────────────────
  // 상태·저장·전이는 훅이 소유한다. 셸은 파일 선택 다이얼로그와 미리듣기만 잇는다.
  const voiceCast = useVoiceCastRegistry()
  const castEmotions = useMemo(
    () => ALL_EMOTIONS.map((e) => ({ id: e.id, label: e.label })), [])

  // 활성 배역에서 **고른 하나씩만** 생성 설정으로 흘린다. 후보·자산 목록은 가지 않는다.
  useEffect(() => {
    const active = findVoiceCast(voiceCast.casts, voiceCast.activeVoiceCastId)
    if (!active) {
      setSpeakerEmotionRefs({})   // 활성 배역이 없으면 기존 계약 그대로다
      return
    }
    const reg = castRegistry(active, voiceCast.assets)
    setSpeakerEmotionRefs(
      toSpeakerEmotionRefs(reg, active.selections, {}, () => undefined))
  }, [voiceCast.casts, voiceCast.assets, voiceCast.activeVoiceCastId, setSpeakerEmotionRefs])

  const addCastFiles = async (castId: string, speakerId: string, emotionId: string) => {
    const picked = await window.api.audio.selectFile(true) as string[] | string | null
    const paths = Array.isArray(picked) ? picked : (picked ? [picked] : [])
    if (paths.length) await voiceCast.addCandidateFiles(castId, speakerId, emotionId, paths)
  }

  const previewCastCandidate = (candidateId: string) => {
    const active = findVoiceCast(voiceCast.casts, voiceCast.activeVoiceCastId)
    const cand = active?.candidates.find((c) => c.candidateId === candidateId)
    const path = cand ? voiceCast.assets[cand.assetId]?.sourcePath : ''
    if (path) previewLocalFile(path)
  }

  const requestEmotionSource = async (): Promise<string | null> => {
    const p = await window.api.audio.selectFile()
    return p || null
  }
  // 감정별 구간 편집기 = 기존 ReferenceRegionPanel 재사용(중복 마운트 없음: 감정당 1개, 행 펼침 시).
  const renderEmotionRegion = (emotionId: string, onChangeRegion: (r: TtsEmotionRegion) => void) => {
    const src = ttsEmotionRefState[emotionId]?.source || ''
    if (!src) return null
    return (
      <ReferenceRegionPanel
        key={src}
        clipKey={emotionId}
        path={src}
        disabled={disabled}
        committed={ttsEmotionRefState[emotionId]?.ready
          ? { clip: ttsEmotionRefState[emotionId].clip, region: ttsEmotionRefState[emotionId].region } : null}
        onState={(s) => {
          setEmotionRefState(emotionId, s)              // store가 단일 소스(clip/ready/message/region)
          if (s.region) onChangeRegion(s.region)         // 관리자 표시 콜백 계약 충족
        }}
        label={`${nonDefaultEmotions.find(e => e.id === emotionId)?.label || emotionId} 참조`}
      />
    )
  }

  // ── ExpressionControls 입력 배선(후처리 축) ──
  const pitchSupported = !!pitchCap && pitchCap.supported
  const pitchProbedUnsupported = !!pitchCap && pitchCap.probed && !pitchCap.supported
  const pitchUnknown = !pitchSupported && !pitchProbedUnsupported
  const capabilities = {
    pitch: pitchSupported, speed: true, sentenceGap: true,
    // tail/감정경계는 I3로 실제 구현됨(supported=true). 단 C 소유 ExpressionControls엔 아직 슬라이더가 없어
    // 사용자 제어 UI가 부재(기본값 auto/pause로 동작). 슬라이더 추가는 C 컴포넌트 확장 사안 → 보고.
    emotionTransitionGap: true, tailTrim: true, tailPadding: true,
  }
  const exprValues = {
    pitchSemitones: ttsPitch,
    speed: ttsSpeed,
    sentenceGapMs: Math.round(ttsSilenceGap * 1000),
  }
  const onExprChange = (patch: Partial<{ pitchSemitones: number; speed: number; sentenceGapMs: number }>) => {
    // 기본 화면의 음높이·속도는 '세부 조절 사용' 체크 없이 바로 움직인다(PHASE B).
    // 값을 손대는 순간 그 스위치를 켜 두어야 고급 설정의 '프리셋 값만 적용' 표시와 실제 값이 어긋나지 않는다.
    if (!fineTuneEnabled) setFineTuneEnabled(true)
    if (patch.pitchSemitones !== undefined) setTtsPitch(patch.pitchSemitones)
    if (patch.speed !== undefined) setTtsSpeed(patch.speed)
    if (patch.sentenceGapMs !== undefined) setTtsSilenceGap(patch.sentenceGapMs / 1000)
  }
  const onPreset = (id: string) => {
    setPresetId(id)
    const v = getPresetValues(id)
    if (v) { setTtsPitch(v.pitchSemitones); setTtsSpeed(v.speed); setTtsSilenceGap(v.sentenceGapMs / 1000) }
  }

  const flowCard: CSSProperties = { borderRadius: 12, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }
  const flowHead: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 16px', borderBottom: '1px solid var(--border-subtle)' }
  const flowNum: CSSProperties = { width: 22, height: 22, borderRadius: 6, background: 'var(--bg-elevated)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: 'var(--accent)', flexShrink: 0 }
  const plainBtn = (bg: string, color: string, off = false): CSSProperties => ({
    fontSize: 11, fontWeight: 600, padding: '6px 12px', borderRadius: 6, border: 'none',
    cursor: off ? 'not-allowed' : 'pointer', background: bg, color, fontFamily: 'inherit',
    opacity: off ? 0.45 : 1, whiteSpace: 'nowrap',
  })

  // ── 기본 화면이 보여 줄 목소리 상태 ──────────────────────────────────────
  // 내부 용어(requested/effective region · snap · ready · capability)는 여기 오지 않는다.
  // 실제 안전 오류(너무 짧음/긺 · 말 도중 절단 · 전사 실패 · 대사 불일치)는 ReferenceRegionPanel /
  // trim 계약이 만든 사용자 문구가 ttsRefMessage 로 그대로 올라온다 — 그 문장을 그대로 보여 준다.
  // 아직 아무 문구도 오지 않은 순간(분석 시작 직전)도 '준비 중'이다 — 빈 상태를 문제처럼 보이게 하지 않는다.
  const voicePreparing = !ttsRefReady && (!ttsRefMessage || /중입니다|중\.\.\.|고르는 중/.test(ttsRefMessage))
  const voiceProblem = !ttsRefReady && !voicePreparing
  const voiceStatusText = ttsRefReady ? '준비됨' : (voicePreparing ? '준비하는 중…' : ttsRefMessage)
  const voiceStatusColor = ttsRefReady ? 'var(--cyan)' : (voiceProblem ? 'var(--rose)' : 'var(--text-muted)')

  // ── 감정 미리듣기(기본 3종) ──────────────────────────────────────────────
  const quickRows = QUICK_EMOTION_ROW_IDS.map((rowId) => ({
    rowId,
    label: EMOTION_SAMPLE_ROWS.find((r) => r.rowId === rowId)?.label ?? rowId,
    ready: !!samplerKeys[rowId],
  }))

  // ── 음높이 막다른 길 방지 ────────────────────────────────────────────────
  // 음높이를 못 쓰는 환경에서는 슬라이더가 숨겨진다. 그런데 저장된 값이 0이 아니면 합성이 막힌다
  // (ProcessButton gate). 되돌릴 수단까지 고급 안으로 숨기면 빠져나올 길이 없어지므로,
  // '실제로 막혔을 때만' 되돌리기 버튼을 기본 화면에 남긴다.
  const pitchDeadEnd = !pitchSupported && ttsPitch !== 0

  const engineLabel = ({ auto: '자동', qwen3: 'Qwen3', gptsovits: 'GPT-SoVITS', f5tts: 'F5', kokoro: 'Kokoro' } as Record<string, string>)[ttsEngine] || ttsEngine
  const refModeLabel = ttsReferenceConditioningMode === 'safe_xvector' ? '안정 우선' : '자동(추천)'

  // 참조 전사 패널(고급 설정 > 음성) — 기존 구현 그대로. id 는 오류 카드의 스크롤 대상이라 유지한다.
  const referenceTranscriptPanel = (
    <div id="tts-reference-transcript" style={flowCard}>
      <button onClick={() => setShowRefPrompts(!showRefPrompts)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', outline: 'none' }} aria-expanded={showRefPrompts}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>참조 전사 <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(선택 — 수동 입력·언어)</span></span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ transform: showRefPrompts ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      {showRefPrompts && (
        <div style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            참조 음성이 무슨 말을 하는지 적어두면 목소리를 더 정확히 흉내 냅니다. 자동 전사가 틀리면 직접 고치거나 입력하세요.
            비워두면 자동 전사를 사용합니다. (10초 초과 파일은 확정한 구간만 전사합니다.)
          </div>
          {[
            { id: 'default', label: '기본 참조', path: fileInfo?.path || '', sourcePath: fileInfo?.path || '' },
            ...ALL_EMOTIONS.filter(e => e.id !== 'default' && ttsEmotionRefState[e.id]?.source)
              .map(e => ({ id: e.id, label: e.label, path: ttsEmotionRefState[e.id].clip || ttsEmotionRefState[e.id].source, sourcePath: ttsEmotionRefState[e.id].source }))
          ].map(ref => {
            const entry = refPrompts[ref.id] || {}
            const effMode = deriveRefMode(entry)
            const refFree = effMode === 'ref_free'
            const eff = refFree ? '화자 특성만' : (effMode === 'manual' ? '직접 입력' : '자동 전사')
            const effColor = refFree ? 'var(--text-muted)' : (effMode === 'manual' ? 'var(--rose)' : 'var(--cyan)')
            return (
              <div key={ref.id} style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', minWidth: 62 }}>{ref.label}</span>
                  <span style={{ fontSize: 9, fontWeight: 600, color: effColor, padding: '1px 6px', borderRadius: 4, background: 'var(--bg-elevated)' }}>{eff}</span>
                  <button onClick={() => autoTranscribe(ref.id, ref.path)} disabled={disabled || !ref.path || !!txLoading} style={{ padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 500, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', opacity: (disabled || !ref.path || !!txLoading) ? 0.5 : 1, marginLeft: 'auto' }}>
                    {txLoading === ref.id ? '전사 중...' : '자동 전사'}
                  </button>
                </div>
                {entry.autoStatus === 'ok' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9, color: 'var(--text-muted)' }}>
                    <span style={{ flex: 1 }}>자동 전사 완료: {entry.autoLang || '?'} · {(entry.autoText || '').length}자</span>
                    <button onClick={() => useAutoAsManual(ref.id, ref.sourcePath)} disabled={disabled || refFree || !entry.autoText} style={{ padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 9, fontWeight: 600, fontFamily: 'inherit', background: 'var(--accent-glow, rgba(56,189,248,0.15))', color: 'var(--cyan)', opacity: (disabled || refFree || !entry.autoText) ? 0.5 : 1 }}>수정하여 사용</button>
                  </div>
                )}
                {entry.autoStatus && entry.autoStatus !== 'ok' && (
                  <div style={{ fontSize: 9, color: 'var(--rose)' }}>자동 전사 실패({entry.autoStatus}): {entry.autoError || '알 수 없는 오류'}</div>
                )}
                <textarea value={entry.manualText || ''} onChange={(e) => onManualEdit(ref.id, e.target.value)}
                  onBlur={() => { if ((entry.manualText || '').trim() && !refFree) void stampFingerprint(ref.id, ref.sourcePath) }}
                  disabled={disabled || refFree}
                  placeholder="수동 전사문 (비우면 자동 전사 사용). '자동 전사' 후 '수정하여 사용'으로 불러올 수 있습니다."
                  style={{ width: '100%', height: 42, resize: 'vertical', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: "'Inter', sans-serif", fontSize: 11, outline: 'none', opacity: (disabled || refFree) ? 0.5 : 1 }} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>언어</span>
                  <select value={entry.promptLang || ''} onChange={(e) => updateRef(ref.id, { promptLang: e.target.value })} disabled={disabled} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--border-subtle)', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', fontFamily: 'inherit' }}>
                    {PROMPT_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-muted)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={refFree} disabled={disabled} onChange={(e) => onRefFreeToggle(ref.id, e.target.checked)} />
                    화자 특성만 사용 (전사문 없이 · 유사도 저하 가능)
                  </label>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )

  // 참조 사용 방식(자동/안정) — 공통 생성 옵션. 한 명은 목소리 섹션 안에, 여러 명은 공통 옵션 카드에 **한 번만** 그린다.
  const refModeControl = (
    <>
        {/* 참조 사용 방식 — 화면에 나오는 것은 두 가지 이름뿐이다.
            ICL·x-vector·ASR 정렬 같은 기술 명칭은 ⓘ 한 줄과 '고급 설정 > 엔진·진단'에만 있다. */}
        <div role="radiogroup" aria-label="참조 사용 방식" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0, borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>참조 방식</span>
          {[
            { id: 'auto' as const, label: '자동(추천)', tip: '목소리 느낌을 최대한 살려 보고, 잘 안 되면 안정 방식으로 자동 전환합니다. 합성 시간이 늘어납니다.' },
            // ⚠️ 이 문구는 metadata 의 품질 제약(CONSTRAINT_EMOTION_MAY_FLATTEN)과 같은 사실을 말해야 한다 —
            //    python/test_reference_conditioning_mode.py 가 '감정 표현은 다소 평탄할 수 있음' 을 대조한다.
            { id: 'safe_xvector' as const, label: '안정 우선', tip: '참조 대사 섞임 없음 · 감정 표현은 다소 평탄할 수 있음 (가장 빠름)' },
          ].map((opt) => {
            const selected = ttsReferenceConditioningMode === opt.id
            return (
              <button key={opt.id} type="button" role="radio" aria-checked={selected} disabled={disabled}
                title={opt.tip}
                onClick={() => !disabled && setTtsReferenceConditioningMode(opt.id)}
                style={plainBtn(selected ? 'var(--rose)' : 'var(--bg-elevated)', selected ? '#fff' : 'var(--text-secondary)', disabled)}>
                {opt.label}
              </button>
            )
          })}
          <button type="button" onClick={() => setShowRefModeHelp(v => !v)} aria-expanded={showRefModeHelp}
            aria-label="참조 방식 설명" aria-controls="tts-refmode-help"
            style={{ width: 18, height: 18, borderRadius: '50%', border: '1px solid var(--text-muted)', background: 'transparent', color: 'var(--text-muted)', fontSize: 11, fontStyle: 'italic', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontFamily: 'inherit' }}>i</button>
        </div>
        {(showRefModeHelp || showSettingHelp) && (
          <p id="tts-refmode-help" style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--text-muted)', margin: 0 }}>
            자동은 목소리 느낌을 더 살려 보고, 실패하면 같은 작업 안에서 안정 방식으로 한 번만 바꿔 만듭니다.
            바뀌면 완료 화면에 그 사실을 알려 드립니다.
          </p>
        )}
    </>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ───────── 한 명 | 여러 명 — 합성 화면 전체를 전환하는 탭(합성 메뉴 바로 아래, 전체 폭). 대사 편집기의 옵션이 아니다. */}
      <DialogueTabs tab={dialogueTab} onTab={setDialogueTab} disabled={disabled} />

      {/* ───────── [1] 목소리 ───────── (한 명 전용)
          기본 화면에 남는 것은 셋뿐이다: 선택한 목소리(+재생) / 다른 목소리 선택 / 사용 구간 바꾸기.
          보관함·감정별 목소리·참조 전사는 '고급 설정 > 음성'으로 옮겼다(숨긴 것이지 없앤 것이 아니다). */}
      {dialogueTab === 'single' && (
      <TtsVoiceSection
        referenceReady={ttsRefReady}
        referenceMessage={ttsRefMessage}
        showSettingHelp={showSettingHelp}
        onToggleSettingHelp={setShowSettingHelp}
        showHelpToggle={false}
        statusSlot={
          <span role="status" aria-live="polite" style={{ fontSize: 11, color: voiceStatusColor, flex: 1, minWidth: 140 }}>
            {voiceStatusText}
          </span>
        }
      >
        {/* 선택한 목소리 + 세 가지 조작 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0, padding: '8px 12px', borderRadius: 8, background: 'var(--bg-elevated)' }}>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 0 }}>
            지금 쓰는 목소리 — <strong style={{ color: 'var(--text-primary)' }}>올린 파일의 목소리</strong>
          </span>
          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }}>
            <button type="button" onClick={() => previewLocalFile(fileInfo?.path || '', ttsReferenceRegion)}
              disabled={disabled || !fileInfo?.path} aria-label="지금 쓰는 목소리 재생"
              style={plainBtn('var(--bg-card)', 'var(--text-secondary)', disabled || !fileInfo?.path)}>▶ 재생</button>
            <button type="button" onClick={() => { void pickAnotherVoice() }} disabled={disabled}
              aria-label="다른 목소리 선택"
              style={plainBtn('var(--bg-card)', 'var(--cyan)', disabled)}>다른 목소리 선택</button>
            <button type="button" onClick={() => setRegionOpen(v => !v)} disabled={disabled || !fileInfo?.path}
              aria-expanded={regionOpen} aria-label="사용 구간 바꾸기"
              style={plainBtn('var(--bg-card)', 'var(--text-secondary)', disabled || !fileInfo?.path)}>
              {regionOpen ? '구간 편집 닫기' : '사용 구간 바꾸기'}
            </button>
          </span>
        </div>

        {/* 미리듣기 실패는 삼키지 않고 보여준다(사용자 언어·경로 미노출·자동 재시도 없음) */}
        {previewError && (
          <div role="alert" style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--rose)', padding: '6px 10px', borderRadius: 6, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
            {previewError}
          </div>
        )}

        {/* 기본 참조 음성 패널(셸 주입) — 단 1회 마운트.
            접혀 있어도 분석과 '추천 구간 자동 확정'은 계속 돈다(길이 조건은 엔진 정책이 정한다). 펼치면 예전 파형·슬라이더가 그대로 나온다. */}
        {fileInfo?.path && (
          <ReferenceRegionPanel
            clipKey="default"
            path={fileInfo.path}
            disabled={disabled}
            committed={ttsRefReady ? { clip: ttsReferenceClip, region: ttsReferenceRegion } : null}
            onState={setTtsRefState}
            label="참조 음성"
            open={regionOpen}
            autoConfirm
            plainStatus={!regionOpen}
          />
        )}

        {refModeControl}
      </TtsVoiceSection>
      )}
      {/* 여러 명: 단일용 목소리 영역은 그리지 않는다. 기본 목소리(처음 불러온 음성)의 분석·추천 구간 자동 확정은 보이지 않게
          계속 돌아야 첫 인물이 그 결과를 이어받는다(open=false 는 도구를 그리지 않고 준비만 한다). */}
      {dialogueTab === 'multi' && fileInfo?.path && (
        <div hidden data-testid="default-voice-driver">
          <ReferenceRegionPanel
            clipKey="default"
            path={fileInfo.path}
            disabled={disabled}
            committed={ttsRefReady ? { clip: ttsReferenceClip, region: ttsReferenceRegion } : null}
            onState={setTtsRefState}
            label="참조 음성"
            open={false}
            autoConfirm
            plainStatus
          />
        </div>
      )}

      {/* ───────── [2] 대사(한 명) / [1] 인물과 대사(여러 명) ─────────
          여러 명에서는 인물·목소리·대사가 카드 하나에 있으므로 단일 화면의 번호 체계를 끌고 오지 않는다. */}
      <section className="tts-flow-card" aria-label={dialogueTab === 'multi' ? '인물과 대사' : '대사'} style={flowCard}>
        <header className="tts-flow-head" style={flowHead}>
          <span aria-hidden="true" style={flowNum}>{dialogueTab === 'multi' ? 1 : 2}</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>{dialogueTab === 'multi' ? '인물과 대사' : '대사'}</span>
          {dialogueTab === 'single' && (
            <span style={{ fontSize: 11, color: ttsText.trim() ? 'var(--text-muted)' : 'var(--rose)', flex: 1, minWidth: 100 }}>
              {ttsText.trim() ? `${ttsText.split('\n').filter(l => l.trim()).length}개 문장` : '합성할 대사를 입력하세요'}
            </span>
          )}
          {dialogueTab === 'multi' && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 100 }}>인물마다 목소리와 대사를 카드에서 설정합니다</span>
          )}
          {dialogueTab === 'single' && !ttsText.trim() && (
            <button onClick={() => !disabled && setTtsText(EXAMPLE_TEXT)} disabled={disabled} style={{ padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--cyan)' }}>예문 불러오기</button>
          )}
        </header>
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* 감정 태그 삽입 팔레트(셸) — **편집기 바로 위**. A의 imperative handle 호출(실제 caret/선택
              삽입·IME·selection/scroll 복원은 전부 A의 기존 구현). 여기서 삽입 알고리즘을 다시 만들지 않는다.
              순서: 대사에 이미 쓰인 감정 우선(첫 등장 순) → 나머지 자주 쓰는 감정.
              색은 감정 '전환' 구간 표시이며 감정 혼합이 아니다. 접근성 권위는 편집기 textarea가 갖는다. */}
          {dialogueTab === 'single' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>감정 태그 삽입 <span style={{ fontSize: 9 }}>(색은 감정 전환 구간 표시 · 혼합 아님)</span>:</span>
              <button onClick={() => setShowAllTags(v => !v)} style={{ padding: '1px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }} aria-expanded={showAllTags}>{showAllTags ? '접기' : '더보기(전체)'}</button>
            </div>
            {!showAllTags ? (
              <div role="group" aria-label="감정 태그 팔레트" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {paletteTags.map((e) => {
                  const used = usedIds.has(e.id)
                  return (
                    <button key={e.id} onClick={() => editorRef.current?.insertEmotion(e.id)} disabled={disabled}
                      aria-label={used ? `${e.label} 태그 삽입 (대사에 사용 중)` : `${e.label} 태그 삽입`}
                      title={used ? '대사에 사용 중' : undefined}
                      style={{ padding: '3px 9px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', background: `${e.color}15`, color: e.color, border: used ? `1px solid ${e.color}` : '1px solid transparent' }}>
                      {e.label}
                    </button>
                  )
                })}
                {/* 쉼 삽입 — 편집기의 기존 insertPause handle을 그대로 호출한다(범위·인접중복 판정은 순수 helper). */}
                <button onClick={() => editorRef.current?.insertPause(PALETTE_PAUSE_MS)} disabled={disabled}
                  aria-label={`쉼 ${PALETTE_PAUSE_MS / 1000}초 삽입`}
                  style={{ padding: '3px 9px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-subtle)' }}>
                  쉼 {PALETTE_PAUSE_MS / 1000}초
                </button>
              </div>
            ) : (
              EMOTION_GROUPS.filter(g => g.name !== '기본').map((group) => (
                <div key={group.name} style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginBottom: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 44 }}>{group.name}</span>
                  {group.emotions.filter(e => e.id !== 'default').map((e) => (
                    <button key={e.id} onClick={() => editorRef.current?.insertEmotion(e.id)} disabled={disabled} style={{ padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: 'inherit', background: `${e.color}15`, color: e.color }}>{e.label}</button>
                  ))}
                </div>
              ))
            )}
          </div>
          )}
          {/* 여러 명 — 원문 위의 projection. 표현 불가면 이유만 말하고 아래 원문 편집기가 그대로 남는다.
              한 명 탭에서는 아예 그리지 않는다(기존 화면 불변). */}
          {dialogueTab === 'multi' && !directEditOpen && (
            <MultiSpeakerDialogue
              projection={dialogue}
              emotions={ALL_EMOTIONS.map((e) => ({ id: e.id, label: e.label }))}
              emotionTagOf={emotionTagOf}
              speakerIdOf={normalizeSpeakerId}
              voiceOf={speakerVoiceOf}
              onAssignVoice={(id, label) => { void (async () => {
                const src = await requestSpeakerSource()
                if (src) registerSpeakerRef(id, src, label)
              })() }}
              onRemoveVoice={(id) => removeSpeakerRef(id)}
              onSpeakerIdChanged={(from, to) => moveSpeakerRef(from, to)}
              onToggleEmotionVoice={(id, on) => setSpeakerEmotionEnabled(id, on)}
              renderEmotionVoiceEditor={(id, label) => {
                // 감정별 후보는 적용된 목소리 구성 안에 산다. 편집 위치는 이 카드 하나 — 고급 설정에는 없다.
                const active = findVoiceCast(voiceCast.casts, voiceCast.activeVoiceCastId)
                if (!active) {
                  return (
                    <span data-testid="emotion-voice-needs-config" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      감정별 목소리를 쓰려면 먼저 목소리 구성을 만들어 적용하세요 (고급 설정 › 목소리 구성 저장/불러오기).
                    </span>
                  )
                }
                return (
                  <SpeakerEmotionCandidates
                    speakerId={id} speakerLabel={label} cast={active} assets={voiceCast.assets}
                    emotions={castEmotions} disabled={disabled || voiceCast.analyzing}
                    onAddFiles={(sid, eid) => { void addCastFiles(active.voiceCastId, sid, eid) }}
                    onPreview={previewCastCandidate}
                    onSelect={(sid, eid, choice) => { void voiceCast.selectCandidate(active.voiceCastId, sid, eid, choice) }}
                    onUnregister={(sid, eid, cid) => { void voiceCast.unregisterCandidate(active.voiceCastId, sid, eid, cid) }}
                  />
                )
              }}
              onPreviewVoice={(id) => {
                // 원본 음성의 사용 중인 구간을 튼다 — 임시 클립이 아니라 원본이 재생 대상이다.
                const s = ttsSpeakerRefState[id]
                previewLocalFile(s?.source || '', s?.region ?? null)
              }}
              renderRegionEditor={renderSpeakerRegion}
              disabled={disabled}
            />
          )}
          {/* 한 명 = 모든 대사를 한 목소리로. 화자 표기가 있어도 막지 않고 중립 안내 한 줄만 둔다. */}
          {dialogueTab === 'single' && speakerDirectives.length > 0 && (
            <div data-testid="single-mode-note" role="note"
              style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              모든 대사를 한 목소리로 생성합니다. 인물 표기 {speakerDirectives.length}개는 여러 명에서만 쓰입니다.
            </div>
          )}
          {/* 화자 표기가 바뀐 편집 뒤의 비차단 알림 — 오류가 아니다. 되돌리기는 직전 원문으로. */}
          {structureNotice && (
            <div data-testid="speaker-structure-notice" role="status" aria-live="polite"
              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: 'var(--text-secondary)' }}>
              <span>인물 구분이 변경되었습니다</span>
              <button type="button" data-testid="speaker-structure-undo" onClick={undoStructureChange} disabled={disabled}
                style={{ padding: '2px 8px', borderRadius: 5, border: 'none', fontSize: 11, fontFamily: 'inherit',
                  cursor: 'pointer', background: 'var(--bg-elevated)', color: 'var(--cyan)' }}>되돌리기</button>
            </div>
          )}
          {/* A 소유 편집기(caret/IME/overlay/오류 = A). 셸은 value/onChange + 삽입 handle만 배선.
              팔레트가 위로 올라가도 이 편집기가 [2] 대사 섹션의 첫 textarea라는 계약은 유지된다. */}
          {/* IME 조합 판정 범위. 이 안쪽 composition 만 분석을 억제한다
              (편집기 컴포넌트 자체는 건드리지 않는다). */}
          {/* 여러 명에서는 원문 직접 편집을 접어 둔다(고급). 구조화할 수 없는 대본이면 그대로 보여 준다. */}
          {dialogueTab === 'multi' && dialogue.editingAllowed && (
            <div data-testid="direct-edit" data-open={directEditOpen ? 'true' : 'false'}
              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, color: 'var(--text-muted)' }}>
              <button type="button" data-testid="direct-edit-toggle" aria-expanded={directEditOpen}
                onClick={() => setDirectEditOpen((o) => !o)}
                style={{ padding: '3px 10px', borderRadius: 5, border: 'none', fontSize: 11, fontFamily: 'inherit',
                  cursor: 'pointer', background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
                {directEditOpen ? '대본 표기 직접 편집 닫기' : '고급 · 대본 표기 직접 편집'}
              </button>
              {directEditOpen && <span>열려 있는 동안 발화 카드는 숨겨집니다. 닫으면 카드로 돌아옵니다.</span>}
            </div>
          )}
          {showRawEditor && (<>
          <div data-af-tts-editor="">
          <EmotionScriptEditor
            ref={editorRef}
            value={ttsText}
            parsedPreview={null}
            parseErrors={[]}
            onChange={onSingleEditorChange}
            onInsertEmotion={() => { /* A가 caret 삽입까지 수행 — 셸은 추가 배선 불필요(게이팅은 store가 담당) */ }}
            onInsertPause={() => { /* 동일 */ }}
            disabled={disabled}
            refStates={Object.fromEntries(nonDefaultEmotions.map(e => [e.id, { registered: !!ttsEmotionRefState[e.id]?.source, ready: !!ttsEmotionRefState[e.id]?.ready }]))}
          />
          </div>
          </>)}
          {/* 대사 작성 보조 — 읽기 전용. textarea 내부를 건드리지 않고 별도 목록으로만 보여 준다. */}
          <InputAnalysisPanel status={analysis.status} result={analysis.result} sourceText={ttsText} />
          {/* 대사에 쓴 감정 중 전용 목소리가 없는 것 — 짧은 사실 한 줄(등록은 고급 설정 > 음성). */}
          {usedUnregistered.length > 0 && (
            <div style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--text-secondary)' }}>
              대사에 쓴 <span style={{ color: 'var(--text-muted)' }}>{usedUnregistered.map(e => e.label).join(', ')}</span> 은(는) <strong style={{ color: 'var(--text-primary)' }}>기본 목소리</strong>로 만들어집니다.
            </div>
          )}
        </div>
      </section>

      {/* 여러 명: 모든 인물에 함께 적용되는 생성 옵션 — 한 번만. 목소리별 설정은 인물 카드에 있다. */}
      {dialogueTab === 'multi' && (
        <section className="tts-flow-card" aria-label="공통 생성 옵션" style={flowCard} data-testid="common-options">
          <div style={{ padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>모든 인물에 함께 적용되는 생성 옵션</span>
            {refModeControl}
          </div>
        </section>
      )}

      {/* ───────── [3] 말하는 느낌(한 명) / [2](여러 명) ─────────
          프리셋 + 음높이·속도만. 문장 간격·말끝·감정 전환은 고급 설정으로 옮겼다. */}
      <ExpressionControls
        capabilities={capabilities}
        presetId={presetId}
        fineTuneEnabled={fineTuneEnabled}
        values={exprValues}
        onPreset={onPreset}
        onToggleFineTune={setFineTuneEnabled}
        onChange={onExprChange}
        showSettingHelp={showSettingHelp}
        disabled={disabled}
        section="basic"
        flowNumber={dialogueTab === 'multi' ? 2 : 3}
      >
        <TtsEmotionQuickPreview
          rows={quickRows}
          enabled={ttsRefReady && !disabled}
          preparing={quickPreparing}
          busyRowId={quickBusyRow}
          notice={quickNotice}
          disabledNotice={ttsRefReady ? null : '목소리가 준비되면 만들 수 있습니다.'}
          onGenerate={() => { void runQuickEmotionPreview() }}
          onPlay={(rowId) => { void auditionSample(rowId) }}
        />
      </ExpressionControls>

      {/* 음높이를 못 쓰는 환경 + 저장된 값이 0이 아님 = 합성이 막힌 상태. 빠져나올 버튼만 남긴다.
          (지원 여부의 자세한 사유는 고급 설정 > 엔진·진단에 있다.) */}
      {pitchDeadEnd && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--rose)', padding: '8px 12px', borderRadius: 8, background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
          <span style={{ flex: 1, minWidth: 200 }}>
            {pitchProbedUnsupported
              ? '이 컴퓨터에서는 음높이 조절을 쓸 수 없어 지금 설정으로는 만들 수 없습니다.'
              : '음높이 조절을 쓸 수 있는지 확인하는 중이라 지금 설정으로는 만들 수 없습니다.'}
          </span>
          <button onClick={() => !disabled && setTtsPitch(0)} disabled={disabled}
            aria-label="음높이를 원래대로 되돌리기"
            style={plainBtn('var(--rose)', '#fff', disabled)}>음높이 원래대로</button>
        </div>
      )}

      {/* ───────── 고급 설정(4탭) ───────── */}
      <TtsAdvancedSettings
        open={advancedOpen}
        onToggle={setAdvancedOpen}
        tab={advancedTab}
        onTab={setAdvancedTab}
        summary={`참조 방식 ${refModeLabel} · 엔진 ${engineLabel}`}
        showSettingHelp={showSettingHelp}
        onToggleSettingHelp={setShowSettingHelp}
        voice={
          <>
            {/* 목소리 구성 저장/불러오기 — 선택 기능. 기본 절차에서는 접혀 있고, 배역 세트는
                사용자가 이 안에서 저장을 누를 때만 만들어진다. */}
            <details data-testid="voice-config-save-load" style={{ minWidth: 0 }}>
              <summary style={{ fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}>
                목소리 구성 저장/불러오기
              </summary>
            <VoiceCastManager
              casts={voiceCast.casts}
              assets={voiceCast.assets}
              activeVoiceCastId={voiceCast.activeVoiceCastId}
              saveState={voiceCast.saveState}
              saveErrorCode={voiceCast.saveErrorCode}
              speakers={speakerUiRows.map((s) => ({
                speakerId: s.speakerId, label: s.label,
              }))}
              emotions={castEmotions}
              hideSpeakerCandidates
              disabled={disabled || voiceCast.analyzing}
              onCreate={(name) => { void voiceCast.createCast(name) }}
              onRename={(id, name) => { void voiceCast.renameCast(id, name) }}
              onRemove={(id) => { void voiceCast.removeCast(id) }}
              onApply={voiceCast.applyCast}
              onUnapply={voiceCast.unapplyCast}
              onAddFiles={(castId, sid, eid) => { void addCastFiles(castId, sid, eid) }}
              onPreview={previewCastCandidate}
              onSelect={(castId, sid, eid, choice) => {
                void voiceCast.selectCandidate(castId, sid, eid, choice)
              }}
              onUnregister={(castId, sid, eid, cid) => {
                void voiceCast.unregisterCandidate(castId, sid, eid, cid)
              }}
            />
            </details>
            {/* 인물별 목소리의 편집 위치는 여러 명 화면의 인물 카드 하나뿐이다. 여기서는 읽기 전용 안내만. */}
            {speakerUiRows.length > 0 && (
              <div data-testid="speaker-voice-elsewhere" style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                인물별 목소리는 여러 명 화면의 각 인물 카드에서 설정합니다.
              </div>
            )}
            {/* 감정별 전용 목소리 등록·구간·삭제 (기존 EmotionReferenceManager 그대로) */}
            <EmotionReferenceManager
              refs={managerRefs}
              onRegister={(id, src) => registerEmotionRef(id, src)}
              onRemove={(id) => removeEmotionRef(id)}
              onPreview={(id) => previewLocalFile(ttsEmotionRefState[id]?.source || '', ttsEmotionRefState[id]?.region ?? null)}
              onChangeRegion={(id, region) => setEmotionRefState(id, { region })}
              requestSource={requestEmotionSource}
              renderRegionEditor={renderEmotionRegion}
              usedEmotionIds={usedEmotionIdList}
              disabled={disabled}
            />
            {/* 참조 목소리 보관함 — 저장해 둔 참조 자산 관리. 감정 참조 등록·구간 편집과 별개 섹션이다. */}
            <ReferenceAssetLibraryPanel
              status={refAssets.status}
              items={refAssets.items}
              hasConfirmedRegion={!!fileInfo?.path && !!ttsReferenceRegion}
              busy={disabled}
              importing={refAssetBusy}
              disabled={disabled}
              notice={refAssetNotice}
              onRefresh={refreshRefAssets}
              onImport={importCurrentReference}
              onSelect={selectRefAsset}
              onRemove={removeRefAsset}
            />
            {referenceTranscriptPanel}
            <div style={{ borderRadius: 12, padding: '12px 16px', background: 'rgba(251,113,133,0.05)', border: '1px solid rgba(251,113,133,0.12)', fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--rose)' }}>참조 음성</strong> = 위에 올린 파일의 목소리를 흉내 냅니다.
              감정별 음성을 추가 등록하면 대사마다 <code style={{ background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>[기쁨]</code> 태그로 감정을 지정할 수 있습니다.
              <br />한국어 · 영어 · 일본어 · 중국어 지원. 영어 목소리로 한국어 대사도 가능합니다.
            </div>
          </>
        }
        expression={
          <>
            <ExpressionControls
              capabilities={capabilities}
              presetId={presetId}
              fineTuneEnabled={fineTuneEnabled}
              values={exprValues}
              onPreset={onPreset}
              onToggleFineTune={setFineTuneEnabled}
              onChange={onExprChange}
              showSettingHelp={showSettingHelp}
              disabled={disabled}
              section="advanced"
            />
            {/* 감정·표현 미리듣기 전체 목록 — 지원 안 됨/미검증 상태와 사유는 여기에 그대로 있다. */}
            <EmotionSamplerPanel
              rows={samplerEntries}
              cachedFileRowIds={Object.keys(samplerKeys)}
              defaultVoiceReady={samplerReferenceReady}
              disabled={disabled || samplerBusyRow !== null}
              onGenerate={generateSample}
              onAudition={auditionSample}
              onDelete={deleteSample}
              onAddRow={(rowId) => { setSamplerRows((r) => (r.includes(rowId) ? r : [...r, rowId])); void refreshSamplerCache() }}
              onRemoveRow={(rowId) => { stopSamplerPreview(); setSamplerRows((r) => r.filter((x) => x !== rowId)) }}
            />
            {samplerNotice && (
              <p style={{ fontSize: 11, color: 'var(--rose)', margin: 0, overflowWrap: 'anywhere' }}>{samplerNotice}</p>
            )}
          </>
        }
        output={
          <>
            {/* 말끝 다듬기 · 끝 여백 · 페이드 · 감정 전환 간격 — 결과 소리의 끝맺음과 사이 */}
            <TtsExpressionDetail
              capability={resolveExpressionCapability()}
              tailMode={ttsTailMode}
              tailPaddingMs={ttsTailPaddingMs}
              tailFadeMs={ttsTailFadeMs}
              emotionMode={ttsEmotionBoundaryMode}
              emotionPauseMs={ttsEmotionBoundaryPauseMs}
              fineTune={detailFineTune}
              showSettingHelp={showSettingHelp}
              disabled={disabled}
              onChange={(patch) => setTtsExpression(patch)}
              onToggleFineTune={setDetailFineTune}
            />
            <p style={{ fontSize: 11, lineHeight: 1.6, color: 'var(--text-muted)', margin: 0 }}>
              합성 결과는 WAV로 저장됩니다. 음성 합성에서는 파일 형식 변환을 제공하지 않습니다 —
              실제 샘플레이트 등 결과 수치는 만든 뒤 결과 아래 <strong>상세 정보</strong>에서 확인할 수 있습니다.
            </p>
          </>
        }
        engine={
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', borderRadius: 10, padding: '8px 14px', width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="목소리를 합성하는 AI 엔진 선택">엔진</span>
              {[
                { id: 'auto', label: '자동', hint: '언어에 맞춰 최적 엔진 자동 선택 (한국어는 Qwen3 우선, 미설치 시 GPT-SoVITS) (권장)' },
                { id: 'qwen3', label: 'Qwen3', hint: '한국어 제로샷 발음·운율 우수 (로컬 Qwen3-TTS 0.6B, 별도 venv 필요 — 미설치 시 자동 폴백)' },
                { id: 'gptsovits', label: 'GPT-SoVITS', hint: '한/영/중 지원, 참조 음성으로 목소리 클로닝 (베타)' },
                { id: 'f5tts', label: 'F5', hint: '영어 중심의 고품질 보이스 클로닝' },
                { id: 'kokoro', label: 'Kokoro', hint: '한/일/중/영 다국어 폴백 엔진, 가벼움' },
              ].map(e => (
                <button key={e.id} onClick={() => !disabled && setTtsEngine(e.id)} disabled={disabled} title={e.hint} style={{ padding: '3px 9px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: 'inherit', background: ttsEngine === e.id ? 'var(--rose)' : 'transparent', color: ttsEngine === e.id ? '#fff' : 'var(--text-muted)' }}>{e.label}</button>
              ))}
            </div>

            {/* Qwen preflight 배지 — 예상값(실행 결과는 결과 화면 metadata가 최종) */}
            {preflight && (() => {
              const ok = preflight.available === true
              const snapMissing = !ok && preflight.snapshot_ok === false
              const dev = preflight.device_expected
              const msg = ok
                ? (dev === 'gpu' ? 'Qwen3 준비됨 · 완전 로컬 · GPU 예상' : dev === 'cpu' ? 'Qwen3 준비됨 · 완전 로컬 · VRAM 부족으로 CPU 예상' : 'Qwen3 준비됨 · 완전 로컬')
                : (snapMissing ? 'Qwen3 모델 스냅샷 누락 · 자동 선택 시 GPT-SoVITS 사용 예정' : 'Qwen3 미설치 · 자동 선택 시 GPT-SoVITS 사용 예정')
              const color = ok ? 'var(--cyan)' : 'var(--text-muted)'
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, color }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? 'var(--cyan)' : 'var(--text-muted)', flexShrink: 0 }} />
                  <span>{msg}</span>
                  <span style={{ color: 'var(--text-muted)' }}>· 예상값(실제 결과는 합성 후 표시)</span>
                </div>
              )
            })()}

            {/* pitch capability 사유(미지원/미확인) — 기본 화면에서는 '막혔을 때 되돌리기'만 남기고 사유는 여기에 둔다(§6). */}
            {(pitchProbedUnsupported || pitchUnknown) && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11, lineHeight: 1.5, color: pitchProbedUnsupported ? 'var(--rose)' : 'var(--text-muted)' }}>
                <span style={{ flex: 1, minWidth: 200 }}>
                  {pitchProbedUnsupported
                    ? `이 환경에서는 음높이 보정을 사용할 수 없습니다${pitchCap?.reason ? ` — ${pitchCap.reason}` : ''}. 저장된 음높이 값이 있으면 원본(0)으로 되돌린 뒤 합성하세요.`
                    : '음높이 보정 지원 여부를 확인하는 중입니다. 확인 전에는 음높이를 조절할 수 없습니다(원본 0으로 합성됩니다).'}
                </span>
                {ttsPitch !== 0 && (
                  <button onClick={() => !disabled && setTtsPitch(0)} disabled={disabled}
                    title="음높이를 원본(0)으로 되돌립니다"
                    style={plainBtn('var(--bg-elevated)', 'var(--text-secondary)', disabled)}>
                    음높이 원본(0)으로 ({ttsPitch > 0 ? '+' : ''}{ttsPitch.toFixed(1)}반음)
                  </button>
                )}
              </div>
            )}

            {/* 참조 사용 방식의 내부 동작 — 기본 화면에서 덜어낸 긴 설명이 여기 그대로 있다. */}
            <div style={{ fontSize: 11, lineHeight: 1.7, color: 'var(--text-secondary)', borderTop: '1px solid var(--border-subtle)', paddingTop: 10 }}>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>참조 사용 방식: {refModeLabel}</div>
              자동은 참조 억양 반영(ICL)을 먼저 시도합니다 — 참조 대사를 일부러 먼저 만들게 한 뒤 그 부분을 잘라냅니다.
              잘라낼 지점을 ASR 정렬로 찾지 못하면 그 결과는 발행하지 않고 <strong>안정 방식(x-vector)으로 한 번만</strong> 바꿔 결과를 만듭니다.
              전환 여부·사유 코드(예: 정렬 실패)와 requested→effective 값은 합성 후 결과 아래 <strong>상세 정보</strong>에 남습니다.
            </div>
          </>
        }
      />

      {/* ───────── [4] 음성 만들기 ─────────
          실제 버튼은 바로 아래 ProcessButton(App 이 항상 같은 자리에 그린다). 여기서는 단계 표시만 한다 —
          버튼을 두 곳에 두면 '어느 것을 눌러야 하는가'가 생긴다. */}
      <section aria-label="음성 만들기" style={flowCard}>
        <header className="tts-flow-head" style={{ ...flowHead, borderBottom: 'none' }}>
          <span aria-hidden="true" style={flowNum}>4</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>음성 만들기</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', flex: 1, minWidth: 140 }}>아래 버튼을 누르면 시작합니다</span>
        </header>
      </section>
    </div>
  )
}
