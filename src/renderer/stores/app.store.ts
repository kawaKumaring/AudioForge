import { create } from 'zustand'
import type { SeparationMode, Track, FileInfo } from '../../shared/types'

// 이전 결과(session.json) 복원용 — 재분리 없이 설정+트랙 되살리기
export interface RestorableSession {
  mode?: SeparationMode
  options?: Partial<{
    model: 'htdemucs' | 'htdemucs_ft' | 'roformer' | 'roformer_ensemble'
    trimSilence: boolean
    silenceGap: number
    transcribe: boolean
    translate: boolean
    srt: boolean
    outputFormat: 'wav' | 'mp3' | 'flac'
    whisperModel: 'small' | 'medium' | 'large-v3' | 'large-v3-turbo'
    whisperLang: string
    translateModel: '600m' | '1.3b' | 'llm'
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
  translateModel: '600m' | '1.3b' | 'llm'
  demucsModel: 'htdemucs' | 'htdemucs_ft' | 'roformer' | 'roformer_ensemble'
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
  ttsEmotionRefs: Record<string, string>
  ttsEngine: string

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
  setTranslateModel: (v: '600m' | '1.3b' | 'llm') => void
  setDemucsModel: (v: 'htdemucs' | 'htdemucs_ft' | 'roformer' | 'roformer_ensemble') => void
  setNSpeakers: (v: number) => void
  setProcessing: () => void
  setProgress: (percent: number, message: string) => void
  setResult: (tracks: Track[], outputDir: string) => void
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
  ttsEmotionRefs: {} as Record<string, string>,
  ttsEngine: 'auto',

  setFile: (info, url) => set({ fileInfo: info, fileUrl: url, status: 'idle', tracks: [], error: null, progress: 0, outputDir: null, restorable: null, playingTrack: null }),
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
  setProcessing: () => set({ status: 'processing', progress: 0, progressMessage: '파일 준비 중...', error: null, tracks: [] }),
  setProgress: (percent, message) => set({ progress: percent, progressMessage: message }),
  setResult: (tracks, outputDir) => set({ status: 'done', progress: 100, progressMessage: '완료', tracks, outputDir }),
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
  reset: () => set({ fileInfo: null, fileUrl: null, status: 'idle', progress: 0, progressMessage: '', error: null, tracks: [], outputDir: null, playingTrack: null, restorable: null, splitMarkers: [], splitLabels: [] })
}))
