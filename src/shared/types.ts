export type SeparationMode = 'music' | 'conversation' | 'transcribe' | 'split' | 'tts' | 'lab'

export interface Track {
  name: string
  label: string
  path: string
  /** 전사 결과에만 붙는다 — 문장별 시작·끝·글자(교정 화면이 쓴다). */
  segments?: { start: number; end: number; text: string }[]
  /** 출력 파일 접두어(교정본 저장 이름). */
  base?: string
  text?: string
  language?: string
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
  /** 텍스트 추출의 실행 엔진. 'whisper'(기본, 기존 경로) | 'faster-whisper'(격리 venv). */
  asrEngine?: string
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
