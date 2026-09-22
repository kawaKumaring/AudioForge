export type SeparationMode = 'music' | 'conversation' | 'transcribe' | 'split' | 'tts' | 'lab' | 'dub'
  | 'dialogue-rebuild'

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
  /** 알아듣기 전에 배경음을 걷어낼지. 'never'(기본) | 'auto'(배경음이 클 때만) | 'always'. */
  asrSeparate?: string
  /** 분할에서 저장할 조각 번호(0부터). 없으면 전부 저장. */
  splitSelected?: number[] | null
  /** 대화 구간 수정본 — 모델을 다시 돌리지 않고 이 구간으로만 트랙을 다시 만든다. */
  dialogueSegments?: { start: number; end: number; speaker: string }[]
  /** 대화 분석 엔진. 'builtin'(기본, 기존 엔진) | 'community-1'(pyannote, 격리 환경). */
  diarizeEngine?: string
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
