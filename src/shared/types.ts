export type SeparationMode = 'music' | 'conversation' | 'transcribe' | 'split'

export interface Track {
  name: string
  label: string
  path: string
}

export interface ProcessingProgress {
  percent: number
  message: string
}

export interface ProcessingResult {
  tracks: Track[]
  outputDir: string
}

export interface ProcessOptions {
  trimSilence?: boolean
  silenceGap?: number
  transcribe?: boolean
  translate?: boolean
  exportSrt?: boolean
  outputFormat?: string
  whisperModel?: string
  demucsModel?: string
  nSpeakers?: number
  splitMarkers?: number[]
  splitLabels?: string[]
}

export interface FileInfo {
  path: string
  name: string
  duration: number
  channels: number
  sampleRate: number
  format: string
}
