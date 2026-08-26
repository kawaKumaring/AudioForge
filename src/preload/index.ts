import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CancelResponseLike } from '../shared/cancelContract'
import { SIDECAR_IPC_CHANNEL } from '../shared/sidecarEvents'
import type { SidecarEnvelope } from '../shared/sidecarEvents'
import { REFERENCE_LIBRARY_CHANNELS } from '../shared/referenceLibraryApi'
import type {
  ReferenceLibraryImportRequest, ReferenceLibraryImportResponse, ReferenceLibraryListResponse,
  ReferenceLibraryRemoveResponse, ReferenceLibrarySelectResponse,
} from '../shared/referenceLibraryApi'

const api = {
  audio: {
    selectFile: () => ipcRenderer.invoke('audio:select-file'),
    getFileInfo: (filePath: string) => ipcRenderer.invoke('audio:get-file-info', filePath),
    process: (filePath: string, mode: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke('audio:process', filePath, mode, options),
    // 취소 '요청'(계약 C2-P0.1). 수락 여부의 권위는 main이고, 반환값은 신 계약 CancelResponse이거나
    // 구 shape({ok,noop} 등)일 수 있다 → 소비자는 반드시 interpretCancelResponse()로 해석한다.
    // 'cancelling' 전환은 이 반환값이 아니라 audio:cancelling 이벤트가 결정한다(낙관적 전환 금지).
    cancel: (): Promise<CancelResponseLike> => ipcRenderer.invoke('audio:cancel'),
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
    // 진단 사이드카(additive/shadow 관측). main 이 허용목록 + 스키마 검증을 통과시킨
    // SidecarEnvelope 만 이 채널로 온다 — 경로·오디오 샘플·전사 본문은 main 에서 이미 제거됨.
    // 기본 출력/품질 동작에는 어떤 영향도 없다(관측 전용). 반환값은 구독 해제 함수.
    onSidecar: (callback: (data: SidecarEnvelope) => void) => {
      const handler = (_event: unknown, data: SidecarEnvelope) => callback(data)
      ipcRenderer.on(SIDECAR_IPC_CHANNEL, handler)
      return () => ipcRenderer.removeListener(SIDECAR_IPC_CHANNEL, handler)
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
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    selectPythonPath: () => ipcRenderer.invoke('settings:select-python-path')
  },
  app: {
    openFolder: (path: string) => ipcRenderer.invoke('app:open-folder', path),
    readTextFile: (path: string) => ipcRenderer.invoke('app:read-text-file', path)
  },
  // 참조 라이브러리 — renderer 는 논리 ID 만 다룬다. import 요청의 filePath 하나만 경로이고,
  // 어떤 응답에도 절대 경로가 들어오지 않는다(main 이 논리 메타데이터만 돌려준다).
  referenceLibrary: {
    list: (): Promise<ReferenceLibraryListResponse> =>
      ipcRenderer.invoke(REFERENCE_LIBRARY_CHANNELS.list),
    import: (request: ReferenceLibraryImportRequest): Promise<ReferenceLibraryImportResponse> =>
      ipcRenderer.invoke(REFERENCE_LIBRARY_CHANNELS.import, request),
    select: (referenceId: string | null): Promise<ReferenceLibrarySelectResponse> =>
      ipcRenderer.invoke(REFERENCE_LIBRARY_CHANNELS.select, referenceId),
    remove: (referenceId: string): Promise<ReferenceLibraryRemoveResponse> =>
      ipcRenderer.invoke(REFERENCE_LIBRARY_CHANNELS.remove, referenceId)
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
