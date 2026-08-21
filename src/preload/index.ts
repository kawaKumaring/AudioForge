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
    analyzeReference: (filePath: string) => ipcRenderer.invoke('audio:analyze-reference', filePath),
    trimReference: (filePath: string, startSec: number, durSec: number) =>
      ipcRenderer.invoke('audio:trim-reference', filePath, startSec, durSec),
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
  }
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
