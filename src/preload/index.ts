import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { RuntimeStatusReport } from '../shared/runtimeStatus.ts'
import type {
  ProvisionPlanResponse,
  ProvisionVerifyResponse,
  ProvisionApplyResponse,
  ProvisionSelectManagedRootResponse,
  ManagedRootSelectionStatus,
} from '../shared/provisionIpc.ts'

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
    // 참조 source 지문(path|size|mtimeMs). 전사 확정 시 stamp해 두면 합성 경계에서 stale 폐기(§4).
    fingerprintReference: (filePath: string): Promise<string> => ipcRenderer.invoke('audio:fingerprint-reference', filePath),
    qwenPreflight: () => ipcRenderer.invoke('audio:qwen-preflight'),
    // pitch 후처리 capability(rubberband 지원 여부) — PitchCapability 계약. UI가 슬라이더 가용성에 소비.
    pitchPreflight: () => ipcRenderer.invoke('audio:pitch-preflight'),
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
    },
    // 취소 lifecycle(공용 마감 K): cancelling→(cancelled|cancel-failed). result/error와 별개 채널로,
    // 취소 승자 정착 후 main이 명시적으로 보낸다(늦은 result/error는 main에서 이미 억제).
    onCancelling: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('audio:cancelling', handler)
      return () => ipcRenderer.removeListener('audio:cancelling', handler)
    },
    onCancelled: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('audio:cancelled', handler)
      return () => ipcRenderer.removeListener('audio:cancelled', handler)
    },
    onCancelFailed: (callback: (data: unknown) => void) => {
      const handler = (_event: unknown, data: unknown) => callback(data)
      ipcRenderer.on('audio:cancel-failed', handler)
      return () => ipcRenderer.removeListener('audio:cancel-failed', handler)
    }
  },
  settings: {
    get: (): Promise<RuntimeStatusReport> => ipcRenderer.invoke('settings:get'),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    selectPythonPath: (): Promise<{ basename: string } | null> => ipcRenderer.invoke('settings:select-python-path')
  },
  // managed provisioner(R-provision) — plan/verify는 읽기 전용, apply는 항상 차단(APPLY_DISABLED).
  // 반환에는 전체 절대경로가 없다(main이 assertNoAbsolutePaths로 가드한 뒤 전달).
  provision: {
    getManagedRoot: (): Promise<ManagedRootSelectionStatus> => ipcRenderer.invoke('provision:get-managed-root'),
    selectManagedRoot: (): Promise<ProvisionSelectManagedRootResponse> => ipcRenderer.invoke('provision:select-managed-root'),
    plan: (): Promise<ProvisionPlanResponse> => ipcRenderer.invoke('provision:plan'),
    verify: (): Promise<ProvisionVerifyResponse> => ipcRenderer.invoke('provision:verify'),
    apply: (): Promise<ProvisionApplyResponse> => ipcRenderer.invoke('provision:apply'),
    cancel: (): Promise<{ ok: true; cancelled: number }> => ipcRenderer.invoke('provision:cancel')
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
