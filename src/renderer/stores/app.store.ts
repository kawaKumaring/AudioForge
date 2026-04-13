import { create } from 'zustand'
import type { SeparationMode, Track, FileInfo } from '../../shared/types'

interface AppState {
  fileInfo: FileInfo | null
  fileUrl: string | null
  mode: SeparationMode
  trimSilence: boolean
  silenceGap: number
  transcribe: boolean
  translate: boolean
  exportSrt: boolean
  outputFormat: 'wav' | 'mp3' | 'flac'
  whisperModel: 'small' | 'medium' | 'large-v3'
  demucsModel: 'htdemucs' | 'htdemucs_ft'
  nSpeakers: number
  status: 'idle' | 'loading' | 'processing' | 'done' | 'error'
  progress: number
  progressMessage: string
  error: string | null
  tracks: Track[]
  outputDir: string | null
  playingTrack: string | null
  splitMarkers: number[]
  splitLabels: string[]
  ttsText: string
  ttsSpeed: number
  ttsSilenceGap: number
  ttsEmotionRefs: Record<string, string>

  setFile: (info: FileInfo, url: string) => void
  setMode: (mode: SeparationMode) => void
  setTrimSilence: (v: boolean) => void
  setSilenceGap: (v: number) => void
  setTranscribe: (v: boolean) => void
  setTranslate: (v: boolean) => void
  setExportSrt: (v: boolean) => void
  setOutputFormat: (v: 'wav' | 'mp3' | 'flac') => void
  setWhisperModel: (v: 'small' | 'medium' | 'large-v3') => void
  setDemucsModel: (v: 'htdemucs' | 'htdemucs_ft') => void
  setNSpeakers: (v: number) => void
  setProcessing: () => void
  setProgress: (percent: number, message: string) => void
  setResult: (tracks: Track[], outputDir: string) => void
  setError: (error: string) => void
  setPlayingTrack: (name: string | null) => void
  reset: () => void
}

export const useAppStore = create<AppState>((set) => ({
  fileInfo: null,
  fileUrl: null,
  mode: 'music',
  trimSilence: false,
  silenceGap: 0.5,
  transcribe: true,
  translate: false,
  exportSrt: false,
  outputFormat: 'wav' as const,
  whisperModel: 'large-v3' as const,
  demucsModel: 'htdemucs' as const,
  nSpeakers: 2,
  status: 'idle',
  progress: 0,
  progressMessage: '',
  error: null,
  tracks: [],
  outputDir: null,
  playingTrack: null,
  splitMarkers: [],
  splitLabels: [],
  ttsText: '',
  ttsSpeed: 1.0,
  ttsSilenceGap: 0.5,
  ttsEmotionRefs: {} as Record<string, string>,

  setFile: (info, url) => set({ fileInfo: info, fileUrl: url, status: 'idle', tracks: [], error: null, progress: 0, outputDir: null }),
  setMode: (mode) => set({ mode }),
  setTrimSilence: (v) => set({ trimSilence: v }),
  setSilenceGap: (v) => set({ silenceGap: v }),
  setTranscribe: (v) => set({ transcribe: v }),
  setTranslate: (v) => set({ translate: v }),
  setExportSrt: (v) => set({ exportSrt: v }),
  setOutputFormat: (v) => set({ outputFormat: v }),
  setWhisperModel: (v) => set({ whisperModel: v }),
  setDemucsModel: (v) => set({ demucsModel: v }),
  setNSpeakers: (v) => set({ nSpeakers: v }),
  setProcessing: () => set({ status: 'processing', progress: 0, progressMessage: '파일 준비 중...', error: null, tracks: [] }),
  setProgress: (percent, message) => set({ progress: percent, progressMessage: message }),
  setResult: (tracks, outputDir) => set({ status: 'done', progress: 100, progressMessage: '완료', tracks, outputDir }),
  setError: (error) => set({ status: 'error', error, progressMessage: '' }),
  setPlayingTrack: (name) => set({ playingTrack: name }),
  reset: () => set({ fileInfo: null, fileUrl: null, status: 'idle', progress: 0, progressMessage: '', error: null, tracks: [], outputDir: null, playingTrack: null, splitMarkers: [], splitLabels: [] })
}))
