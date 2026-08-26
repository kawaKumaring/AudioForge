import { useState, useEffect, useRef, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { useAppStore, emotionEffectivePath } from '@/stores/app.store'
import type { TtsReferenceEntry, PitchCapability, TtsEmotionRegion } from '../../shared/ttsConfig'
import { deriveRefMode } from '../../shared/ttsConfig'
import ReferenceRegionPanel from './ReferenceRegionPanel'
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
import { EMOTION_GROUPS, ALL_EMOTIONS, FREQUENT_TAGS, parseUsedEmotionIds } from '@/lib/emotions'
import type { Emotion } from '@/lib/emotions'

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

function previewLocalFile(path: string) {
  if (!path) { emitPreviewError(previewErrorText('source')); return }
  // (1) 새 세대를 먼저 올린다 — 아직 URL/로드를 기다리는 이전 요청은 자기 차례에 stale임을 알고 물러난다.
  _previewSession = beginRequest(_previewSession)
  const gen = _previewSession.gen
  pausePreview()                 // 들리던 소리는 즉시 멈춘다
  emitPreviewError(null)
  // (2) 앞선 요청의 로드가 끝난 뒤에만 다음 로드를 시작한다. 로드를 중간에 끊어 버리면 그 local-file://
  //     요청이 남아 쌓이고, 수십 번 반복하면 이후 모든 미리듣기가 로드되지 않는다(영구 무음).
  _previewChain = _previewChain.then(() => runPreview(gen, path)).catch(() => { /* 다음 요청을 막지 않는다 */ })
}

async function runPreview(gen: number, path: string) {
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
    try { el.currentTime = 0 } catch { /* noop */ }

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
  const { mode, status, fileInfo, ttsEmotionRefState, registerEmotionRef, removeEmotionRef, setEmotionRefState, setTtsRefState, ttsRefReady, ttsRefMessage, ttsPitchCapability, setTtsPitchCapability,
    ttsTailMode, ttsTailPaddingMs, ttsTailFadeMs, ttsEmotionBoundaryMode, ttsEmotionBoundaryPauseMs, setTtsExpression } = useAppStore()
  // 로컬 상태는 store 값으로 초기화 — 빈 값으로 시작하면 아래 동기화 useEffect가 다른 모드에 다녀온 뒤 store를 덮어써 유실시킴
  const [ttsText, setTtsText] = useState(() => useAppStore.getState().ttsText)
  const [ttsSpeed, setTtsSpeed] = useState(() => useAppStore.getState().ttsSpeed)
  const [ttsSilenceGap, setTtsSilenceGap] = useState(() => useAppStore.getState().ttsSilenceGap)
  const [ttsPitch, setTtsPitch] = useState(() => useAppStore.getState().ttsPitch)
  const [ttsEngine, setTtsEngine] = useState(() => useAppStore.getState().ttsEngine)
  const [refPrompts, setRefPrompts] = useState<Record<string, TtsReferenceEntry>>(() => useAppStore.getState().ttsReferencePrompts)
  const [showRefPrompts, setShowRefPrompts] = useState(false)
  const [txLoading, setTxLoading] = useState<string | null>(null)
  const [preflight, setPreflight] = useState<{ available?: boolean; snapshot_ok?: boolean; device_expected?: string; reason?: string } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
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

  // 셸이 파일 선택 다이얼로그를 주입(EmotionReferenceManager는 파일 I/O를 하지 않음).
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* ───────── [1] 목소리 ───────── */}
      <TtsVoiceSection
        referenceReady={ttsRefReady}
        referenceMessage={ttsRefMessage}
        showSettingHelp={showSettingHelp}
        onToggleSettingHelp={setShowSettingHelp}
        emotionManager={
          <>
            <EmotionReferenceManager
              refs={managerRefs}
              onRegister={(id, src) => registerEmotionRef(id, src)}
              onRemove={(id) => removeEmotionRef(id)}
              onPreview={(id) => previewLocalFile(emotionEffectivePath(ttsEmotionRefState[id]) || ttsEmotionRefState[id]?.source || '')}
              onChangeRegion={(id, region) => setEmotionRefState(id, { region })}
              requestSource={requestEmotionSource}
              renderRegionEditor={renderEmotionRegion}
              usedEmotionIds={usedEmotionIdList}
              disabled={disabled}
            />
            {/* 미리듣기 실패는 삼키지 않고 보여준다(사용자 언어·경로 미노출·자동 재시도 없음) */}
            {previewError && (
              <div role="alert" style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--rose)', padding: '6px 10px', borderRadius: 6, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                {previewError}
              </div>
            )}
            {/* 미등록 안내는 관리 목록의 '기본 목소리 사용' 행이 대신한다(같은 사실을 두 곳에 쓰지 않음).
                목록을 열지 않아도 보이도록 요약 한 줄만 남긴다. */}
            {usedUnregistered.length > 0 && (
              <div style={{ fontSize: 10, lineHeight: 1.6, color: 'var(--text-secondary)', padding: '6px 10px', borderRadius: 6, background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                대사에 쓰인 <span style={{ color: 'var(--text-muted)' }}>{usedUnregistered.map(e => e.label).join(', ')}</span> 은(는) <strong style={{ color: 'var(--text-primary)' }}>기본 목소리</strong>로 합성됩니다.
              </div>
            )}
          </>
        }
      >
        {/* 기본 참조 음성 패널(셸 주입) — 단 1회 마운트. */}
        {fileInfo?.path && (
          <ReferenceRegionPanel clipKey="default" path={fileInfo.path} disabled={disabled} onState={setTtsRefState} label="참조 음성" />
        )}
        {/* Guide */}
        <div style={{ borderRadius: 12, padding: '12px 16px', background: 'rgba(251,113,133,0.05)', border: '1px solid rgba(251,113,133,0.12)', fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--rose)' }}>참조 음성</strong> = 위에 올린 파일의 목소리를 흉내 냅니다.
          감정별 음성을 추가 등록하면 대사마다 <code style={{ background: 'var(--bg-elevated)', padding: '1px 4px', borderRadius: 3 }}>[기쁨]</code> 태그로 감정을 지정할 수 있습니다.
          <br />한국어 · 영어 · 일본어 · 중국어 지원. 영어 목소리로 한국어 대사도 가능합니다.
        </div>
        {/* Qwen preflight 배지 */}
        {preflight && (() => {
          const ok = preflight.available === true
          const snapMissing = !ok && preflight.snapshot_ok === false
          const dev = preflight.device_expected
          const msg = ok
            ? (dev === 'gpu' ? 'Qwen3 준비됨 · 완전 로컬 · GPU 예상' : dev === 'cpu' ? 'Qwen3 준비됨 · 완전 로컬 · VRAM 부족으로 CPU 예상' : 'Qwen3 준비됨 · 완전 로컬')
            : (snapMissing ? 'Qwen3 모델 스냅샷 누락 · 자동 선택 시 GPT-SoVITS 사용 예정' : 'Qwen3 미설치 · 자동 선택 시 GPT-SoVITS 사용 예정')
          const color = ok ? 'var(--cyan)' : 'var(--text-muted)'
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color, padding: '2px 2px' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? 'var(--cyan)' : 'var(--text-muted)', flexShrink: 0 }} />
              <span>{msg}</span>
              <span style={{ color: 'var(--text-muted)' }}>· 예상값(실제 결과는 합성 후 표시)</span>
            </div>
          )
        })()}
        {/* 참조 전사(선택 — 수동 입력·언어). 신규 패널에 대응 없어 셸이 그대로 보존(무손실). */}
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
                      <span style={{ flex: 1, fontSize: 10, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ref.path ? ref.path.split(/[/\\]/).pop() : '파일 없음'}</span>
                      <button onClick={() => autoTranscribe(ref.id, ref.path)} disabled={disabled || !ref.path || !!txLoading} style={{ padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 10, fontWeight: 500, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', opacity: (disabled || !ref.path || !!txLoading) ? 0.5 : 1 }}>
                        {txLoading === ref.id ? '전사 중...' : '자동 전사'}
                      </button>
                    </div>
                    {entry.autoStatus === 'ok' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 9, color: 'var(--text-muted)' }}>
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>자동 전사: {entry.autoLang || '?'} · {(entry.autoText || '').length}자 · "{(entry.autoText || '').slice(0, 30)}"</span>
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
      </TtsVoiceSection>

      {/* ───────── [2] 대사 ───────── */}
      <section className="tts-flow-card" aria-label="대사" style={flowCard}>
        <header className="tts-flow-head" style={flowHead}>
          <span aria-hidden="true" style={flowNum}>2</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>대사</span>
          <span style={{ fontSize: 11, color: ttsText.trim() ? 'var(--text-muted)' : 'var(--rose)', flex: 1, minWidth: 100 }}>
            {ttsText.trim() ? `${ttsText.split('\n').filter(l => l.trim()).length}개 문장` : '합성할 대사를 입력하세요'}
          </span>
          {!ttsText.trim() && (
            <button onClick={() => !disabled && setTtsText(EXAMPLE_TEXT)} disabled={disabled} style={{ padding: '3px 10px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--cyan)' }}>예문 불러오기</button>
          )}
        </header>
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* 감정 태그 삽입 팔레트(셸) — **편집기 바로 위**. A의 imperative handle 호출(실제 caret/선택
              삽입·IME·selection/scroll 복원은 전부 A의 기존 구현). 여기서 삽입 알고리즘을 다시 만들지 않는다.
              순서: 대사에 이미 쓰인 감정 우선(첫 등장 순) → 나머지 자주 쓰는 감정.
              색은 감정 '전환' 구간 표시이며 감정 혼합이 아니다. 접근성 권위는 편집기 textarea가 갖는다. */}
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
          {/* A 소유 편집기(caret/IME/overlay/오류 = A). 셸은 value/onChange + 삽입 handle만 배선.
              팔레트가 위로 올라가도 이 편집기가 [2] 대사 섹션의 첫 textarea라는 계약은 유지된다. */}
          <EmotionScriptEditor
            ref={editorRef}
            value={ttsText}
            parsedPreview={null}
            parseErrors={[]}
            onChange={(next) => { if (!disabled) setTtsText(next) }}
            onInsertEmotion={() => { /* A가 caret 삽입까지 수행 — 셸은 추가 배선 불필요(게이팅은 store가 담당) */ }}
            onInsertPause={() => { /* 동일 */ }}
            disabled={disabled}
            refStates={Object.fromEntries(nonDefaultEmotions.map(e => [e.id, { registered: !!ttsEmotionRefState[e.id]?.source, ready: !!ttsEmotionRefState[e.id]?.ready }]))}
          />
        </div>
      </section>

      {/* ───────── [3] 표현 ───────── */}
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
      />
      {/* pitch capability 사유(미지원/미확인) — ExpressionControls는 슬라이더만 숨기므로 사유는 셸이 보존 표시(§6). */}
      {(pitchProbedUnsupported || pitchUnknown) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10, lineHeight: 1.5, color: pitchProbedUnsupported ? 'var(--rose)' : 'var(--text-muted)', padding: '2px 4px' }}>
          <span style={{ flex: 1, minWidth: 180 }}>
            {pitchProbedUnsupported
              ? `이 환경에서는 음높이 보정을 사용할 수 없습니다${pitchCap?.reason ? ` — ${pitchCap.reason}` : ''}. 저장된 음높이 값이 있으면 원본(0)으로 되돌린 뒤 합성하세요.`
              : '음높이 보정 지원 여부를 확인하는 중입니다. 확인 전에는 음높이를 조절할 수 없습니다(원본 0으로 합성됩니다).'}
          </span>
          {/* 기존 '원본(0)' 리셋 보존(§6 계약): capability와 무관하게 저장된 nonzero pitch를 0으로 되돌려 합성 차단을 푼다.
              (미지원 시 ExpressionControls가 슬라이더를 숨겨 리셋 경로가 사라지는 막다른 길 방지.) */}
          {ttsPitch !== 0 && (
            <button onClick={() => !disabled && setTtsPitch(0)} disabled={disabled}
              title="음높이를 원본(0)으로 되돌립니다" style={{ padding: '2px 8px', borderRadius: 4, border: 'none', cursor: disabled ? 'default' : 'pointer', fontSize: 9, fontWeight: 600, fontFamily: 'inherit', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', opacity: disabled ? 0.4 : 1, whiteSpace: 'nowrap' }}>
              음높이 원본(0)으로 ({ttsPitch > 0 ? '+' : ''}{ttsPitch.toFixed(1)}반음)
            </button>
          )}
        </div>
      )}

      {/* 세부 표현(통합 소유 블록) — 말끝 finishing + 감정 전환 경계. ExpressionControls(C) 아래 별도 배치. */}
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

      {/* 고급: 엔진 직접 선택(표현축 아님 → 셸이 별도 배치, 기본 접힘). */}
      <div style={flowCard}>
        <button onClick={() => setShowAdvanced(v => !v)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '10px 16px', border: 'none', cursor: 'pointer', background: 'transparent', fontFamily: 'inherit', outline: 'none' }} aria-expanded={showAdvanced}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>고급 <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(엔진 직접 선택)</span></span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" style={{ transform: showAdvanced ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }}><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        {showAdvanced && (
          <div style={{ padding: '0 16px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', borderRadius: 10, padding: '8px 14px', width: '100%', background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }} title="목소리를 합성하는 AI 엔진 선택">엔진</span>
              {[
                { id: 'auto', label: '자동', hint: '언어에 맞춰 최적 엔진 자동 선택 (한국어는 Qwen3 우선, 미설치 시 GPT-SoVITS) (권장)' },
                { id: 'qwen3', label: 'Qwen3', hint: '한국어 제로샷 발음·운율 우수 (로컬 Qwen3-TTS 0.6B, 별도 venv 필요 — 미설치 시 자동 폴백)' },
                { id: 'gptsovits', label: 'GPT-SoVITS', hint: '한/영/중 지원, 참조 음성으로 목소리 클로닝 (베타)' },
                { id: 'f5tts', label: 'F5', hint: '영어 중심의 고품질 보이스 클로닝' },
                { id: 'kokoro', label: 'Kokoro', hint: '한/일/중/영 다국어 폴백 엔진, 가벼움' },
              ].map(e => (
                <button key={e.id} onClick={() => !disabled && setTtsEngine(e.id)} disabled={disabled} title={e.hint} style={{ padding: '2px 7px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 9, fontWeight: 600, fontFamily: 'inherit', background: ttsEngine === e.id ? 'var(--rose)' : 'transparent', color: ttsEngine === e.id ? '#fff' : 'var(--text-muted)' }}>{e.label}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
