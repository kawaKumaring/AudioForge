import { contextBridge, ipcRenderer, webUtils } from 'electron'

const api = {
  audio: {
    selectFile: () => ipcRenderer.invoke('audio:select-file'),
    getFileInfo: (filePath: string) => ipcRenderer.invoke('audio:get-file-info', filePath),
    process: (filePath: string, mode: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke('audio:process', filePath, mode, options),
    cancel: () => ipcRenderer.invoke('audio:cancel'),
    getFileUrl: (filePath: string) => ipcRenderer.invoke('audio:get-file-url', filePath),
    exportTracks: (trackPaths: string[]) => ipcRenderer.invoke('audio:export-tracks', trackPaths),
    restoreFromFolder: () => ipcRenderer.invoke('audio:restore-from-folder'),
    findSession: (sourcePath: string) => ipcRenderer.invoke('audio:find-session', sourcePath),
    transcribeReference: (filePath: string) => ipcRenderer.invoke('audio:transcribe-reference', filePath),
    // clipKey('default'|emotionId): 감정별 파생 클립을 식별해 분석/트림/정리(생략 시 'default').
    analyzeReference: (filePath: string, clipKey?: string) => ipcRenderer.invoke('audio:analyze-reference', filePath, clipKey),
    trimReference: (filePath: string, startSec: number, durSec: number, clipKey?: string) =>
      ipcRenderer.invoke('audio:trim-reference', filePath, startSec, durSec, clipKey),
    // clipKey 지정 시 그 하나만, 생략 시 전체 파생 클립 정리.
    releaseReferenceClip: (clipKey?: string) => ipcRenderer.invoke('audio:release-reference-clip', clipKey),
    qwenPreflight: () => ipcRenderer.invoke('audio:qwen-preflight'),
    processTrack: (trackPath: string, outputDir: string, options: { transcribe?: boolean; translate?: boolean; srt?: boolean; translateModel?: string }) =>
      ipcRenderer.invoke('audio:process-track', trackPath, outputDir, options),
    onTrackResult: (callback: (data: unknown) => void) => {
      const handler = (_event: unknown, data: unknown) => callback(data)
      ipcRenderer.on('audio:track-result', handler)
      return () => ipcRenderer.removeListener('audio:track-result', handler)
    },
    onTrackError: (callback: (data: unknown) => void) => {
      const handler = (_event: unknown, data: unknown) => callback(data)
      ipcRenderer.on('audio:track-error', handler)
      return () => ipcRenderer.removeListener('audio:track-error', handler)
    },
    onProgress: (callback: (data: unknown) => void) => {
      const handler = (_event: unknown, data: unknown) => callback(data)
      ipcRenderer.on('audio:progress', handler)
      return () => ipcRenderer.removeListener('audio:progress', handler)
    },
    onResult: (callback: (data: unknown) => void) => {
      const handler = (_event: unknown, data: unknown) => callback(data)
      ipcRenderer.on('audio:result', handler)
      return () => ipcRenderer.removeListener('audio:result', handler)
    },
    onError: (callback: (data: unknown) => void) => {
      const handler = (_event: unknown, data: unknown) => callback(data)
      ipcRenderer.on('audio:error', handler)
      return () => ipcRenderer.removeListener('audio:error', handler)
    }
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    selectPythonPath: () => ipcRenderer.invoke('settings:select-python-path')
  },
  app: {
    openFolder: (path: string) => ipcRenderer.invoke('app:open-folder', path),
    readTextFile: (path: string) => ipcRenderer.invoke('app:read-text-file', path)
  },
  utils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    copyToClipboard: (text: string) => ipcRenderer.invoke('app:copy-to-clipboard', text)
  },
  // E2E 전용 게이트 — AF_E2E=1 로 실행할 때만 true. 이 값으로만 renderer가 테스트 훅을 노출한다.
  _e2e: process.env.AF_E2E === '1'
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
