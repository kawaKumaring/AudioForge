import { create } from 'zustand'
import type { SeparationMode, Track, FileInfo } from '../../shared/types'
import type { TtsReferenceEntry, PitchCapability } from '../../shared/ttsConfig'
// 취소 계약(C2-P0.1)의 순수 술어 — store/UI/테스트가 같은 판정을 공유해 갈라지지 않게 한다.
// 확장자(.ts)를 명시하는 이유: app.store.ts는 node --test(ESM, 확장자 필수)가 직접 로드하는 유일한 store 파일이라
// 확장자 없는 상대 경로는 런타임에 ERR_MODULE_NOT_FOUND가 된다. tsconfig의 allowImportingTsExtensions는
// 이 작업 범위 밖(공유 설정)이므로 TS5097만 국소 억제한다 — 모듈 해석·타입 검사는 그대로 살아 있다.
// @ts-ignore TS5097: node --test가 요구하는 명시적 .ts 확장자(위 주석 참고).
import { CANCEL_FAILED_CODE, canBeginCancelling, isCancelCleanupBusy } from '../../shared/cancelContract.ts'
// 표현형 모드 해석 권위(계약 §10) — 기본값·유효성 규칙을 store 가 따로 쓰지 않는다.
// @ts-ignore TS5097: node --test가 요구하는 명시적 .ts 확장자(위 cancelContract import 주석과 같은 이유).
import { EXPRESSIVE_DEFAULT_MODE, resolveExpressiveMode, type ExpressiveMode } from '../../shared/expressiveTimeline.ts'

// 감정별 참조 상태 — 하나의 slot이 통합 브랜치의 config 3필드(§1.2 계약)로 직렬화된다:
//   source  → ttsEmotionRefSources[id] (사용자 등록 원본 경로, 영속·세션 재현 기준)
//   clip    → ttsEmotionRefs[id]        (effective: 확정 3~10초 파생 클립. 임시일 수 있음)
//   region  → ttsEmotionRefRegions[id]  (source→effective를 만든 구간, 초)
// 유효한 ≤10초 원본은 파생 클립 없이 source 자체가 effective(clip='' + ready=true).
// 완전 재현은 source+region 조합이 담당(effective 임시 경로에 의존 금지).
export interface EmotionRefState {
  source: string
  clip: string
  region: { start: number; duration: number } | null
  ready: boolean
  message: string
}

// slot에서 실제 합성에 전달할 effective 경로. 미준비면 '' (전송/게이팅에서 제외 판단).
export function emotionEffectivePath(s: EmotionRefState | undefined): string {
  if (!s || !s.ready) return ''
  return s.clip || s.source
}

// 이전 결과(session.json) 복원용 — 재분리 없이 설정+트랙 되살리기.
// options는 session.json의 직렬화 config 전체(스냅샷). TTS 필드는 Python-facing 형태(prompts는 snake_case).
export interface RestorableSession {
  mode?: SeparationMode
  source?: string
  metadata?: Record<string, unknown> | null
  // 참조 source 존재 여부 맵('default' + 감정 id). main 프로세스가 fs로 판정해 전달(렌더러는 fs 불가).
  refLiveness?: Record<string, boolean>
  options?: Partial<{
    model: 'htdemucs' | 'htdemucs_ft' | 'roformer' | 'roformer_melband' | 'roformer_ensemble'
    trimSilence: boolean
    silenceGap: number
    transcribe: boolean
    translate: boolean
    srt: boolean
    outputFormat: 'wav' | 'mp3' | 'flac'
    whisperModel: 'small' | 'medium' | 'large-v3' | 'large-v3-turbo'
    whisperLang: string
    translateModel: '600m' | '1.3b' | 'llm' | 'google'
    nSpeakers: number
    // TTS 스냅샷(있을 때만) — 재분리 없이 합성 설정 복원
    ttsText: string
    ttsSpeed: number
    ttsSilenceGap: number
    ttsPitch: number
    ttsEngine: string
    ttsEmotionRefs: Record<string, string>          // effective(파생 클립/유효 원본) — 재시작 후 파생은 소실
    ttsEmotionRefSources: Record<string, string>    // 등록 원본(영속·복원 기준)
    ttsEmotionRefRegions: Record<string, { start: number; duration: number }>
    ttsReferenceOverride: string                    // 기본 참조 파생 클립(temp — 재시작 후 소실)
    ttsReferencePrompts: Record<string, { manual_text?: string; prompt_lang?: string; mode?: string }>
    // I3: 말끝/감정경계 스냅샷. legacy 세션은 이 필드가 없어 복원 시 off/현행으로 강등(정정8, 자동 마이그레이션 없음).
    ttsTailMode: 'off' | 'auto'
    ttsTailPaddingMs: number
    ttsTailFadeMs: number
    ttsEmotionBoundaryMode: 'immediate' | 'pause'
    ttsEmotionBoundaryPauseMs: number
    // 표현형 모드 스냅샷. 필드 부재(legacy 세션)=legacy_v2 → 구 세션을 여는 것만으로 재현이 바뀌지 않는다.
    ttsExpressiveMode: ExpressiveMode
  }>
  tracks?: Track[]
}

// 세션 config(snake_case prompts) → store TtsReferenceEntry(camelCase)로 역변환.
// 살아있는 source(refLiveness[id]===true)의 전사만 복원 — 사라진 source의 전사는 stale이므로 버린다(§4).
export function reconstructReferencePrompts(
  cfgPrompts: Record<string, { manual_text?: string; prompt_lang?: string; mode?: string }> | undefined,
  refLiveness: Record<string, boolean>
): Record<string, TtsReferenceEntry> {
  const out: Record<string, TtsReferenceEntry> = {}
  if (!cfgPrompts) return out
  for (const [id, p] of Object.entries(cfgPrompts)) {
    if (refLiveness[id] !== true) continue  // source 소실/미상 → 전사 폐기
    const mode = (p?.mode === 'manual' || p?.mode === 'ref_free' || p?.mode === 'auto') ? p.mode : undefined
    const entry: TtsReferenceEntry = {}
    if (p?.manual_text) entry.manualText = p.manual_text
    if (p?.prompt_lang) entry.promptLang = p.prompt_lang
    if (mode) entry.mode = mode
    out[id] = entry
  }
  return out
}

// 감정 참조 slot 복원 — source 존재 여부 + 파생 클립 소실을 반영.
//   source 소실 → ready:false, '원본 다시 지정 필요'
//   source 존재 + 파생 클립을 썼었음(effective≠source) → ready:false, '구간 재확정 필요'(temp 클립 소실)
//   source 존재 + 원본을 직접 썼음(effective===source, ≤10초 유효) → ready:true, clip:''
export function reconstructEmotionRefState(
  sources: Record<string, string> | undefined,
  regions: Record<string, { start: number; duration: number }> | undefined,
  effective: Record<string, string> | undefined,
  refLiveness: Record<string, boolean>
): Record<string, EmotionRefState> {
  const out: Record<string, EmotionRefState> = {}
  if (!sources) return out
  const regs = regions || {}
  const effs = effective || {}
  for (const [id, source] of Object.entries(sources)) {
    if (!source) continue
    const region = regs[id] ?? null
    const alive = refLiveness[id] === true
    if (!alive) {
      out[id] = { source, clip: '', region, ready: false, message: '원본 다시 지정 필요' }
    } else if (effs[id] && effs[id] === source) {
      out[id] = { source, clip: '', region, ready: true, message: '' }
    } else {
      out[id] = { source, clip: '', region, ready: false, message: '구간 재확정 필요' }
    }
  }
  return out
}

interface AppState {
  fileInfo: FileInfo | null
  fileUrl: string | null
  mode: SeparationMode
  trimSilence: boolean
  silenceGap: number
  silencePreview: boolean
  transcribe: boolean
  translate: boolean
  exportSrt: boolean
  outputFormat: 'wav' | 'mp3' | 'flac'
  whisperModel: 'small' | 'medium' | 'large-v3' | 'large-v3-turbo'
  whisperLang: string
  translateModel: '600m' | '1.3b' | 'llm' | 'google'
  demucsModel: 'htdemucs' | 'htdemucs_ft' | 'roformer' | 'roformer_melband' | 'roformer_ensemble'
  nSpeakers: number
  status: 'idle' | 'loading' | 'processing' | 'cancelling' | 'done' | 'error'
  progress: number
  progressMessage: string
  error: string | null
  // 구조화 오류 정보(오류 UX 분기용). code + (취소 실패 시) childAlive만 — GENERATION_LIMIT_EXCEEDED/CANCEL_FAILED 분기.
  // 전사·문장·전체경로·스택은 담지 않는다(§미디어 정책).
  // rawType: 계약 밖 값의 '타입 이름'만(원시값·대사·경로는 절대 담지 않는다 — 비민감 payload 규칙).
  errorInfo: { code?: string; childAlive?: boolean; rawType?: string | null } | null
  // 사용자 명시 재시도 트리거(단조 증가). ProcessButton이 이 값 변화에서만 재합성 1회 실행.
  retryNonce: number
  tracks: Track[]
  outputDir: string | null
  playingTrack: string | null
  restorable: { dir: string; session: RestorableSession } | null
  splitMarkers: number[]
  splitLabels: string[]
  ttsText: string
  ttsSpeed: number
  ttsSilenceGap: number
  // 음높이 보정(반음, -2.0~+2.0). 후처리 축(최종 WAV) — 0이면 무후처리. 정규화 권위는 Python.
  ttsPitch: number
  // pitch 후처리 capability(rubberband) — TTSEditor가 probe해 기록하고 ProcessButton이 합성 gate에 소비(단일 소스).
  ttsPitchCapability: PitchCapability | null
  // 감정별 참조 상태(source/clip/region/ready). 통합 브랜치가 config 3필드로 직렬화.
  ttsEmotionRefState: Record<string, EmotionRefState>
  ttsReferencePrompts: Record<string, TtsReferenceEntry>
  ttsEngine: string
  // 참조 준비 상태(합성 버튼 게이팅 + 사유 표시). ttsReferenceClip이 있으면 그 파생 클립을 참조로 전달.
  ttsReferenceClip: string
  ttsRefReady: boolean
  ttsRefMessage: string
  ttsReferenceRegion: { start: number; duration: number } | null
  // I3: 말끝 finishing + 감정 전환 경계. fresh=auto(새 세션), 복원 시 필드 부재=off(legacy 보존, 자동 마이그레이션 없음).
  ttsTailMode: 'off' | 'auto'
  ttsTailPaddingMs: number
  ttsTailFadeMs: number
  ttsEmotionBoundaryMode: 'immediate' | 'pause'
  ttsEmotionBoundaryPauseMs: number
  // 표현형 파서 모드. ⚠️ setter 를 의도적으로 두지 않는다 — v3 합성 경로가 없는 동안
  // 사용자가 v3 를 고를 방법이 있으면 안 되기 때문이다(죽은 스위치 금지).
  // 값이 바뀌는 경로는 '세션 복원' 하나뿐이며, 그때도 계약 밖 값은 조용히 고치지 않고 크게 실패시킨다.
  ttsExpressiveMode: ExpressiveMode
  resultMetadata: Record<string, unknown> | null

  setFile: (info: FileInfo, url: string) => void
  setMode: (mode: SeparationMode) => void
  setTrimSilence: (v: boolean) => void
  setSilenceGap: (v: number) => void
  setSilencePreview: (v: boolean) => void
  setTranscribe: (v: boolean) => void
  setTranslate: (v: boolean) => void
  setExportSrt: (v: boolean) => void
  setOutputFormat: (v: 'wav' | 'mp3' | 'flac') => void
  setWhisperModel: (v: 'small' | 'medium' | 'large-v3' | 'large-v3-turbo') => void
  setWhisperLang: (v: string) => void
  setTranslateModel: (v: '600m' | '1.3b' | 'llm' | 'google') => void
  setDemucsModel: (v: 'htdemucs' | 'htdemucs_ft' | 'roformer' | 'roformer_melband' | 'roformer_ensemble') => void
  setNSpeakers: (v: number) => void
  setTtsReferencePrompts: (v: Record<string, TtsReferenceEntry>) => void
  setTtsRefState: (v: { clip?: string; ready?: boolean; message?: string; region?: { start: number; duration: number } | null }) => void
  // 감정 참조: 원본 등록/변경(파생 클립 초기화 + 그 clipKey 정리), 삭제(그 clipKey 정리), 상태 패치(패널 onChange).
  registerEmotionRef: (emotionId: string, source: string) => void
  removeEmotionRef: (emotionId: string) => void
  setEmotionRefState: (emotionId: string, patch: { clip?: string; ready?: boolean; message?: string; region?: { start: number; duration: number } | null }) => void
  setProcessing: () => void
  setProgress: (percent: number, message: string) => void
  setResult: (tracks: Track[], outputDir: string, metadata?: Record<string, unknown> | null) => void
  setError: (error: string, info?: { code?: string; childAlive?: boolean } | null) => void
  // 오류 카드 '닫기' — 오류만 해제하고 idle로. 디스크의 synthesized.wav·재시도 nonce는 건드리지 않는다.
  clearError: () => void
  // 오류 카드 '다시 시도' — 오류 해제 + retryNonce 증가(= 재합성 1회 트리거). 자동/타이머 재시도 아님.
  bumpRetry: () => void
  // 취소 lifecycle(공용 마감 K): 취소 요청 표시 / 취소 완료(idle) / 취소 실패(error+childAlive).
  beginCancelling: () => void
  finishCancelled: () => void
  setCancelFailed: (childAlive: boolean) => void
  setPlayingTrack: (name: string | null) => void
  setRestorable: (v: { dir: string; session: RestorableSession } | null) => void
  restoreSession: (dir: string, session: RestorableSession) => void
  setTtsPitchCapability: (c: PitchCapability | null) => void
  // I3: 표현(말끝/감정경계) 옵션 부분 갱신 — I5에서 ExpressionControls UI가 바인딩한다.
  setTtsExpression: (patch: Partial<{
    ttsTailMode: 'off' | 'auto'
    ttsTailPaddingMs: number
    ttsTailFadeMs: number
    ttsEmotionBoundaryMode: 'immediate' | 'pause'
    ttsEmotionBoundaryPauseMs: number
  }>) => void
  reset: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  fileInfo: null,
  fileUrl: null,
  mode: 'music',
  trimSilence: false,
  silenceGap: 0.5,
  silencePreview: false,
  transcribe: true,
  translate: false,
  exportSrt: false,
  outputFormat: 'wav' as const,
  whisperModel: 'large-v3' as const,
  whisperLang: 'auto',
  translateModel: '600m' as const,
  demucsModel: 'htdemucs' as const,
  nSpeakers: 2,
  status: 'idle',
  progress: 0,
  progressMessage: '',
  error: null,
  errorInfo: null,
  retryNonce: 0,
  tracks: [],
  outputDir: null,
  playingTrack: null,
  restorable: null,
  splitMarkers: [],
  splitLabels: [],
  ttsText: '',
  ttsSpeed: 1.0,
  ttsSilenceGap: 0.5,
  ttsPitch: 0.0,
  ttsPitchCapability: null,
  ttsEmotionRefState: {} as Record<string, EmotionRefState>,
  ttsReferencePrompts: {} as Record<string, TtsReferenceEntry>,
  ttsEngine: 'auto',
  // I3: 새(fresh) 세션 기본 = auto(계약 정정8 "new session"). 복원 시 legacy(필드 부재)는 off로 강등.
  ttsTailMode: 'auto' as 'off' | 'auto',
  ttsTailPaddingMs: 120,
  ttsTailFadeMs: 8,
  ttsEmotionBoundaryMode: 'pause' as 'immediate' | 'pause',
  ttsEmotionBoundaryPauseMs: 200,
  // fresh 세션도 legacy_v2 — v3 는 '명시적으로' 골라야 하고, 아직 고를 방법이 없다.
  ttsExpressiveMode: EXPRESSIVE_DEFAULT_MODE,
  ttsReferenceClip: '',
  ttsRefReady: false,
  ttsRefMessage: '',
  ttsReferenceRegion: null,
  resultMetadata: null,

  // 새 파일 → 이전 파생 참조/준비 상태 무효화(다른 원본의 클립을 재사용하지 않도록) + 임시 클립 폴더 정리.
  // 새 기본 참조 = 새 파일이므로 이전 전사(default + 감정 전부)는 새 음성에 결합되면 안 된다 →
  // ttsReferencePrompts 전량 비움(불변식 3·4: stale 전사 ↔ 새 음성 결합 방지).
  setFile: (info, url) => {
    if (isCancelCleanupBusy(get().status)) return  // 취소 정리 중 새 파일 처리 차단(worker 종료 확인 전 상태 교체 방지)
    try { window.api?.audio?.releaseReferenceClip?.() } catch { /* noop */ }  // 전체 파생 클립(기본+감정) 정리
    // 분할 마커는 파일에 종속이다. 비우지 않으면 이전 파일의 경계가 새 파일에 그대로 적용돼
    // (더 긴 파일에서는 오류조차 없이) 완전히 틀린 지점에서 잘린다 — 감사 R2.
    set({ fileInfo: info, fileUrl: url, status: 'idle', tracks: [], error: null, errorInfo: null, progress: 0, outputDir: null, restorable: null, playingTrack: null, splitMarkers: [], splitLabels: [], ttsReferenceClip: '', ttsRefReady: false, ttsRefMessage: '', ttsReferenceRegion: null, ttsEmotionRefState: {}, ttsReferencePrompts: {} })
  },
  setMode: (mode) => set({ mode }),
  setTrimSilence: (v) => set({ trimSilence: v }),
  setSilenceGap: (v) => set({ silenceGap: v }),
  setSilencePreview: (v) => set({ silencePreview: v }),
  setTranscribe: (v) => set({ transcribe: v }),
  setTranslate: (v) => set({ translate: v }),
  setExportSrt: (v) => set({ exportSrt: v }),
  setOutputFormat: (v) => set({ outputFormat: v }),
  setWhisperModel: (v) => set({ whisperModel: v }),
  setWhisperLang: (v) => set({ whisperLang: v }),
  setTranslateModel: (v) => set({ translateModel: v }),
  setDemucsModel: (v) => set({ demucsModel: v }),
  setNSpeakers: (v) => set({ nSpeakers: v }),
  setTtsReferencePrompts: (v) => set({ ttsReferencePrompts: v }),
  setTtsPitchCapability: (c) => set({ ttsPitchCapability: c }),
  // ⚠️ patch 를 그대로 흘리지 않고 허용 키만 통과시킨다. 타입은 컴파일 때만 막아 주는데,
  //    이 setter 로 ttsExpressiveMode 를 밀어 넣을 수 있으면 'UI 스위치 없음' 보장이 런타임에서 뚫린다
  //    (v3 합성 경로가 없는 동안 v3 를 켜는 경로가 하나라도 있으면 죽은 스위치가 된다).
  setTtsExpression: (patch) => set(() => {
    const allowed = ['ttsTailMode', 'ttsTailPaddingMs', 'ttsTailFadeMs',
      'ttsEmotionBoundaryMode', 'ttsEmotionBoundaryPauseMs'] as const
    const out: Record<string, unknown> = {}
    const src = (patch ?? {}) as Record<string, unknown>
    for (const k of allowed) if (src[k] !== undefined) out[k] = src[k]
    return out
  }),
  setTtsRefState: (v) => set((s) => ({
    ttsReferenceClip: v.clip !== undefined ? v.clip : s.ttsReferenceClip,
    ttsRefReady: v.ready !== undefined ? v.ready : s.ttsRefReady,
    ttsRefMessage: v.message !== undefined ? v.message : s.ttsRefMessage,
    ttsReferenceRegion: v.region !== undefined ? v.region : s.ttsReferenceRegion,
  })),
  // 감정 원본 등록/변경: source만 설정하고 파생 상태 초기화(재분석 필요) + 그 clipKey의 이전 파생 클립 정리.
  // source가 바뀌면 그 감정의 이전 전사(ttsReferencePrompts[id])는 옛 음성 것이므로 함께 제거 —
  // 새 source에 stale 전사가 결합되는 것을 막는다(불변식 3·4). 타 감정 전사는 불변.
  registerEmotionRef: (emotionId, source) => {
    try { window.api?.audio?.releaseReferenceClip?.(emotionId) } catch { /* noop */ }
    set((s) => {
      const nextPrompts = { ...s.ttsReferencePrompts }
      delete nextPrompts[emotionId]
      return {
        ttsEmotionRefState: {
          ...s.ttsEmotionRefState,
          [emotionId]: { source, clip: '', region: null, ready: false, message: '' },
        },
        ttsReferencePrompts: nextPrompts,
      }
    })
  },
  // 감정 삭제: slot 제거 + 그 감정의 전사 제거 + 그 clipKey 파생 클립만 정리(타 감정 불변).
  removeEmotionRef: (emotionId) => {
    try { window.api?.audio?.releaseReferenceClip?.(emotionId) } catch { /* noop */ }
    set((s) => {
      const next = { ...s.ttsEmotionRefState }
      delete next[emotionId]
      const nextPrompts = { ...s.ttsReferencePrompts }
      delete nextPrompts[emotionId]
      return { ttsEmotionRefState: next, ttsReferencePrompts: nextPrompts }
    })
  },
  // 감정 참조 구간 패널 onChange — clip/region/ready/message만 패치(source 불변).
  setEmotionRefState: (emotionId, patch) => set((s) => {
    const prev = s.ttsEmotionRefState[emotionId]
    if (!prev) return {}  // 등록되지 않은 감정에는 패치하지 않음(방어)
    return {
      ttsEmotionRefState: {
        ...s.ttsEmotionRefState,
        [emotionId]: {
          ...prev,
          clip: patch.clip !== undefined ? patch.clip : prev.clip,
          ready: patch.ready !== undefined ? patch.ready : prev.ready,
          message: patch.message !== undefined ? patch.message : prev.message,
          region: patch.region !== undefined ? patch.region : prev.region,
        },
      },
    }
  }),
  setProcessing: () => set({ status: 'processing', progress: 0, progressMessage: '파일 준비 중...', error: null, errorInfo: null, tracks: [], resultMetadata: null }),
  setProgress: (percent, message) => set({ progress: percent, progressMessage: message }),
  setResult: (tracks, outputDir, metadata) => set({ status: 'done', progress: 100, progressMessage: '완료', tracks, outputDir, resultMetadata: metadata ?? null }),
  setError: (error, info) => set({ status: 'error', error, errorInfo: info ?? null, progressMessage: '' }),
  clearError: () => set({ status: 'idle', error: null, errorInfo: null, progressMessage: '' }),
  // 오류 해제 + 재시도 트리거. idle로 되돌려 ProcessButton effect가 재합성 1회 실행하도록.
  // processing/cancelling 중이면 무시(재진입 방지 — 중복 클릭에도 1회만, 진행/취소 중 상태를 뒤엎지 않음).
  bumpRetry: () => set((s) => (s.status === 'processing' || isCancelCleanupBusy(s.status))
    ? {}
    : { retryNonce: s.retryNonce + 1, status: 'idle', error: null, errorInfo: null, progressMessage: '' }),
  // 취소 정리 표시 — 오직 main의 audio:cancelling 이벤트를 받았을 때만 호출한다(계약 C2-P0.1 §4).
  // 클릭 시점의 낙관적 전환은 금지: main이 no-op으로 끝내면 어떤 터미널 이벤트도 오지 않아 UI가 영구
  // 'cancelling'에 갇히고, 그 사이 도착한 result/error까지 폐기됐다(이 결함의 원인).
  // processing에서, 또는 취소 실패(CANCEL_FAILED)에서 '다시 취소'로 재진입할 때만 전환(canBeginCancelling).
  beginCancelling: () => set((s) => canBeginCancelling(s.status, s.errorInfo?.code)
    ? { status: 'cancelling', progressMessage: '작업을 취소하고 정리하는 중…', error: null, errorInfo: null }
    : {}),
  // 취소 완료(main audio:cancelled) → idle. 부분 결과 미채택.
  finishCancelled: () => set({ status: 'idle', progress: 0, progressMessage: '', error: null, errorInfo: null, tracks: [], resultMetadata: null }),
  // 취소 실패(main audio:cancel-failed) → 조용한 idle 금지. error + childAlive(재취소 게이팅용).
  setCancelFailed: (childAlive) => set({
    status: 'error',
    error: '작업을 취소하지 못했습니다. 프로세스 상태를 확인하거나 앱을 종료하세요.',
    errorInfo: { code: CANCEL_FAILED_CODE, childAlive: !!childAlive },
    progressMessage: ''
  }),
  setPlayingTrack: (name) => set({ playingTrack: name }),
  setRestorable: (v) => set({ restorable: v }),
  restoreSession: (dir, session) => set(() => {
    const o = session.options || {}
    const liveness = session.refLiveness || {}
    const md = session.metadata || null
    // TTS 스냅샷 복원 — source가 사라진 감정만 재지정 필요로 표시, 나머지는 source+region 보존.
    const emotionState = reconstructEmotionRefState(o.ttsEmotionRefSources, o.ttsEmotionRefRegions, o.ttsEmotionRefs, liveness)
    const prompts = reconstructReferencePrompts(o.ttsReferencePrompts, liveness)
    // 표현형 모드 복원 — 해석 권위는 계약 함수 하나뿐(store 가 규칙을 다시 쓰지 않는다).
    //   필드 부재(legacy 세션) → legacy_v2, 조용히 복원해도 무방하다(오늘과 같은 동작).
    //   값이 있는데 계약 밖(손상·수기편집 session.json) → 조용한 강등 금지. mode 는 안전한 legacy_v2 로
    //   두되 errorCode 를 그대로 드러내, 세션을 여는 것만으로 재현이 몰래 바뀌지 않게 한다.
    const expressive = resolveExpressiveMode(o.ttsExpressiveMode)
    // 기본 참조: 파생 override는 temp라 재시작 후 소실 → 항상 clip='' 로 복원.
    //   default source 소실 → 재지정 필요. 원본 직접 사용(override 없음)이었고 살아있음 → 준비됨.
    const defaultAlive = liveness.default === true
    const defaultUsedDerived = !!o.ttsReferenceOverride  // 파생 클립을 썼었음(현재 소실)
    const defaultRegion = (md && typeof md === 'object' && (md as Record<string, unknown>).reference_region)
      ? (md as { reference_region?: { start: number; duration: number } }).reference_region ?? null
      : null
    const defaultReady = defaultAlive && !defaultUsedDerived
    const defaultMessage = !defaultAlive ? '원본 다시 지정 필요' : (defaultUsedDerived ? '구간 재확정 필요' : '')
    return {
      mode: session.mode || 'music',
      demucsModel: o.model || 'htdemucs',
      trimSilence: !!o.trimSilence,
      silenceGap: o.silenceGap ?? 0.5,
      transcribe: o.transcribe ?? true,
      translate: !!o.translate,
      exportSrt: !!o.srt,
      outputFormat: o.outputFormat || 'wav',
      whisperModel: o.whisperModel || 'large-v3',
      whisperLang: o.whisperLang || 'auto',
      translateModel: o.translateModel || '600m',
      nSpeakers: o.nSpeakers ?? 2,
      // TTS 설정 복원(스냅샷에 있을 때만 유의미; 없으면 기본값)
      ttsText: o.ttsText ?? '',
      ttsSpeed: o.ttsSpeed ?? 1.0,
      ttsSilenceGap: o.ttsSilenceGap ?? 0.5,
      ttsPitch: o.ttsPitch ?? 0.0,
      ttsEngine: o.ttsEngine ?? 'auto',
      // I3: legacy 세션(필드 부재)은 off/현행으로 복원 — 구 세션을 여는 것만으로 재현이 조용히 바뀌지 않는다
      // (정정8, 자동 마이그레이션 없음). new 세션은 저장된 값(off|auto) 그대로.
      ttsTailMode: o.ttsTailMode === 'auto' || o.ttsTailMode === 'off' ? o.ttsTailMode : 'off',
      ttsTailPaddingMs: o.ttsTailPaddingMs ?? 120,
      ttsTailFadeMs: o.ttsTailFadeMs ?? 8,
      ttsEmotionBoundaryMode: o.ttsEmotionBoundaryMode === 'immediate' || o.ttsEmotionBoundaryMode === 'pause'
        ? o.ttsEmotionBoundaryMode : 'pause',
      ttsEmotionBoundaryPauseMs: o.ttsEmotionBoundaryPauseMs ?? 200,
      ttsExpressiveMode: expressive.mode,
      ttsEmotionRefState: emotionState,
      ttsReferencePrompts: prompts,
      ttsReferenceClip: '',            // 파생 클립은 temp — 복원 시 항상 비움(§4: stale 클립 결합 금지)
      ttsRefReady: defaultReady,
      ttsRefMessage: defaultMessage,
      ttsReferenceRegion: defaultRegion,
      resultMetadata: md,
      tracks: session.tracks || [],
      outputDir: dir,
      status: 'done' as const, progress: 100, progressMessage: '이전 결과 불러옴',
      restorable: null, playingTrack: null,
      // 표현형 모드가 계약 밖이면 조용히 넘어가지 않는다. 트랙 복원 자체는 성공했으므로 status 는
      // done 을 유지하고, 오류 카드로 사실을 드러낸다(닫으면 복원된 결과를 그대로 볼 수 있다).
      ...(expressive.valid
        ? { error: null, errorInfo: null }
        : {
          error: '세션에 저장된 표현형 모드 값이 올바르지 않습니다. 기본(legacy_v2)으로 복원했습니다.',
          errorInfo: { code: expressive.errorCode ?? undefined, rawType: expressive.rawType }
        })
    }
  }),
  reset: () => {
    if (isCancelCleanupBusy(get().status)) return  // 취소 정리 중 reset 차단(worker 종료 확인 전 상태 초기화 방지)
    // 세션 리셋 → 파생 참조 클립 폴더 삭제 + 참조/전사/결과 상태 초기화(다른 원본의 상태 잔존 방지).
    try { window.api?.audio?.releaseReferenceClip?.() } catch { /* noop */ }
    set({
      fileInfo: null, fileUrl: null, status: 'idle', progress: 0, progressMessage: '', error: null, errorInfo: null,
      tracks: [], outputDir: null, playingTrack: null, restorable: null, splitMarkers: [], splitLabels: [],
      ttsReferenceClip: '', ttsRefReady: false, ttsRefMessage: '', ttsReferenceRegion: null,
      ttsReferencePrompts: {}, ttsEmotionRefState: {}, ttsPitch: 0.0, ttsPitchCapability: null, resultMetadata: null,
      // 세션 리셋은 표현형 모드도 기본으로 되돌린다(이전 세션의 모드가 새 작업에 눌러앉지 않게).
      ttsExpressiveMode: EXPRESSIVE_DEFAULT_MODE,
    })
  }
}))
