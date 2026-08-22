import { create } from 'zustand'
import type { SeparationMode, Track, FileInfo } from '../../shared/types'
import type { TtsReferenceEntry } from '../../shared/ttsConfig'

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

// 이전 결과(session.json) 복원용 — 재분리 없이 설정+트랙 되살리기
export interface RestorableSession {
  mode?: SeparationMode
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
  }>
  tracks?: Track[]
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
  status: 'idle' | 'loading' | 'processing' | 'done' | 'error'
  progress: number
  progressMessage: string
  error: string | null
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
  // 감정별 참조 상태(source/clip/region/ready). 통합 브랜치가 config 3필드로 직렬화.
  ttsEmotionRefState: Record<string, EmotionRefState>
  ttsReferencePrompts: Record<string, TtsReferenceEntry>
  ttsEngine: string
  // 참조 준비 상태(합성 버튼 게이팅 + 사유 표시). ttsReferenceClip이 있으면 그 파생 클립을 참조로 전달.
  ttsReferenceClip: string
  ttsRefReady: boolean
  ttsRefMessage: string
  ttsReferenceRegion: { start: number; duration: number } | null
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
  setError: (error: string) => void
  setPlayingTrack: (name: string | null) => void
  setRestorable: (v: { dir: string; session: RestorableSession } | null) => void
  restoreSession: (dir: string, session: RestorableSession) => void
  reset: () => void
}

export const useAppStore = create<AppState>((set) => ({
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
  ttsEmotionRefState: {} as Record<string, EmotionRefState>,
  ttsReferencePrompts: {} as Record<string, TtsReferenceEntry>,
  ttsEngine: 'auto',
  ttsReferenceClip: '',
  ttsRefReady: false,
  ttsRefMessage: '',
  ttsReferenceRegion: null,
  resultMetadata: null,

  // 새 파일 → 이전 파생 참조/준비 상태 무효화(다른 원본의 클립을 재사용하지 않도록) + 임시 클립 폴더 정리
  setFile: (info, url) => {
    try { window.api?.audio?.releaseReferenceClip?.() } catch { /* noop */ }  // 전체 파생 클립(기본+감정) 정리
    set({ fileInfo: info, fileUrl: url, status: 'idle', tracks: [], error: null, progress: 0, outputDir: null, restorable: null, playingTrack: null, ttsReferenceClip: '', ttsRefReady: false, ttsRefMessage: '', ttsReferenceRegion: null, ttsEmotionRefState: {} })
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
  setTtsRefState: (v) => set((s) => ({
    ttsReferenceClip: v.clip !== undefined ? v.clip : s.ttsReferenceClip,
    ttsRefReady: v.ready !== undefined ? v.ready : s.ttsRefReady,
    ttsRefMessage: v.message !== undefined ? v.message : s.ttsRefMessage,
    ttsReferenceRegion: v.region !== undefined ? v.region : s.ttsReferenceRegion,
  })),
  // 감정 원본 등록/변경: source만 설정하고 파생 상태 초기화(재분석 필요) + 그 clipKey의 이전 파생 클립 정리.
  registerEmotionRef: (emotionId, source) => {
    try { window.api?.audio?.releaseReferenceClip?.(emotionId) } catch { /* noop */ }
    set((s) => ({
      ttsEmotionRefState: {
        ...s.ttsEmotionRefState,
        [emotionId]: { source, clip: '', region: null, ready: false, message: '' },
      },
    }))
  },
  // 감정 삭제: slot 제거 + 그 clipKey 파생 클립만 정리(타 감정 불변).
  removeEmotionRef: (emotionId) => {
    try { window.api?.audio?.releaseReferenceClip?.(emotionId) } catch { /* noop */ }
    set((s) => {
      const next = { ...s.ttsEmotionRefState }
      delete next[emotionId]
      return { ttsEmotionRefState: next }
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
  setProcessing: () => set({ status: 'processing', progress: 0, progressMessage: '파일 준비 중...', error: null, tracks: [], resultMetadata: null }),
  setProgress: (percent, message) => set({ progress: percent, progressMessage: message }),
  setResult: (tracks, outputDir, metadata) => set({ status: 'done', progress: 100, progressMessage: '완료', tracks, outputDir, resultMetadata: metadata ?? null }),
  setError: (error) => set({ status: 'error', error, progressMessage: '' }),
  setPlayingTrack: (name) => set({ playingTrack: name }),
  setRestorable: (v) => set({ restorable: v }),
  restoreSession: (dir, session) => set(() => {
    const o = session.options || {}
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
      tracks: session.tracks || [],
      outputDir: dir,
      status: 'done' as const, progress: 100, progressMessage: '이전 결과 불러옴',
      restorable: null, playingTrack: null, error: null
    }
  }),
  reset: () => {
    // 세션 리셋 → 파생 참조 클립 폴더 삭제 + 참조/전사/결과 상태 초기화(다른 원본의 상태 잔존 방지).
    try { window.api?.audio?.releaseReferenceClip?.() } catch { /* noop */ }
    set({
      fileInfo: null, fileUrl: null, status: 'idle', progress: 0, progressMessage: '', error: null,
      tracks: [], outputDir: null, playingTrack: null, restorable: null, splitMarkers: [], splitLabels: [],
      ttsReferenceClip: '', ttsRefReady: false, ttsRefMessage: '', ttsReferenceRegion: null,
      ttsReferencePrompts: {}, ttsEmotionRefState: {}, ttsPitch: 0.0, resultMetadata: null,
    })
  }
}))
