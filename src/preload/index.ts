import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppBuildInfo } from '../shared/buildMetadata'
import type { ExportDiagnosticsResult } from '../shared/diagnostics'
import {
  ANALYSIS_CANCEL_CHANNEL, ANALYSIS_CHANNEL, ANALYSIS_PREWARM_CHANNEL,
} from '../shared/inputAnalysis'
import type { AnalysisRequest, AnalysisResponse } from '../shared/inputAnalysis'
import type { CancelResponseLike } from '../shared/cancelContract'
import { SIDECAR_IPC_CHANNEL } from '../shared/sidecarEvents'
import type { SidecarEnvelope } from '../shared/sidecarEvents'
import { REFERENCE_LIBRARY_CHANNELS } from '../shared/referenceLibraryApi'
import { SAMPLER_CHANNELS } from '../shared/samplerApi'
import type {
  SamplerCacheKeyRequest, SamplerGenerateRequest, SamplerGenerateResponse,
  SamplerInventoryResponse, SamplerPreviewUrlResponse, SamplerRemoveResponse,
} from '../shared/samplerApi'
import type {
  ReferenceLibraryImportRequest, ReferenceLibraryImportResponse, ReferenceLibraryListResponse,
  ReferenceLibraryRemoveResponse, ReferenceLibrarySelectResponse,
} from '../shared/referenceLibraryApi'

const api = {
  audio: {
    // multi=true 면 string[] 을 돌려준다. 인자 없는 기존 호출은 string|null 그대로다.
    /** `kind` 는 **어느 폴더에서 열지**만 정한다 — 빼면 음원 폴더.
     *  용도를 나누지 않으면 영상·목소리를 고른 뒤 음원 폴더가 엉뚱하게 바뀐다. */
    selectFile: (multi?: boolean, kind?: 'source' | 'voice') =>
      ipcRenderer.invoke('audio:select-file', multi, kind),
    getFileInfo: (filePath: string) => ipcRenderer.invoke('audio:get-file-info', filePath),
    /** 원본들이 아직 그 자리에 있는가(경로 → 참/거짓). 현재 작업 복원이 쓴다. */
    sourcesPresent: (paths: string[]): Promise<Record<string, boolean>> =>
      ipcRenderer.invoke('audio:sources-present', paths),
    process: (filePath: string, mode: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke('audio:process', filePath, mode, options),
    // 취소 '요청'(계약 C2-P0.1). 수락 여부의 권위는 main이고, 반환값은 신 계약 CancelResponse이거나
    // 구 shape({ok,noop} 등)일 수 있다 → 소비자는 반드시 interpretCancelResponse()로 해석한다.
    // 'cancelling' 전환은 이 반환값이 아니라 audio:cancelling 이벤트가 결정한다(낙관적 전환 금지).
    cancel: (): Promise<CancelResponseLike> => ipcRenderer.invoke('audio:cancel'),
    getFileUrl: (filePath: string) => ipcRenderer.invoke('audio:get-file-url', filePath),
    /** 돌려주는 것: 취소면 null, 아니면 { ok, dir, copied[], failed[] }. ★결과를 버리지 않는다. */
    exportTracks: (trackPaths: string[]) => ipcRenderer.invoke('audio:export-tracks', trackPaths) as
      Promise<null | { ok: boolean; dir: string; copied: string[]; failed: Array<{ name: string; why: string }> }>,
    restoreFromFolder: () => ipcRenderer.invoke('audio:restore-from-folder'),
    findSession: (sourcePath: string) => ipcRenderer.invoke('audio:find-session', sourcePath),
    transcribeReference: (filePath: string) => ipcRenderer.invoke('audio:transcribe-reference', filePath),
    // clipKey('default'|emotionId): 감정별 파생 클립을 식별해 분석/트림/정리(생략 시 'default').
    // extra 는 같은 채널에 얹는 추가 설정이다(예: 감정 참조 후보 목록 요청).
    // 새 채널을 만들지 않는다 — 응답에 필드가 더 붙을 뿐이다.
    analyzeReference: (filePath: string, clipKey?: string, extra?: Record<string, unknown>) =>
      ipcRenderer.invoke('audio:analyze-reference', filePath, clipKey, extra),
    /** 검사 전용 — 다음 '파일 고르기' 가 돌려줄 경로를 지정한다(AF_E2E=1 에서만 동작). */
    e2eSetSelectFile: (filePath: string) => ipcRenderer.invoke('audio:e2e-set-select-file', filePath),
    /** 이 결과가 어땠는지를 그 실행의 기록에 남긴다. verdict: good | fair | bad. */
    recordListening: (runId: string, verdict: string, note?: string) =>
      ipcRenderer.invoke('audio:record-listening', runId, verdict, note),
    // extra: 분석과 같은 추가 설정(예: ttsEngine → 워커가 그 엔진의 길이 정책으로 판정). 새 채널 없음.
    trimReference: (filePath: string, startSec: number, durSec: number, clipKey?: string, extra?: Record<string, unknown>) =>
      ipcRenderer.invoke('audio:trim-reference', filePath, startSec, durSec, clipKey, extra),
    // clipKey 지정 시 그 하나만, 생략 시 전체 파생 클립 정리.
    releaseReferenceClip: (clipKey?: string) => ipcRenderer.invoke('audio:release-reference-clip', clipKey),
    // 확정 클립 이어받기(복사) / 인물 id 변경 시 클립 key 이동 — 여러 명 첫 인물 초기 연결·시작 카드 이름 변경용.
    adoptReferenceClip: (fromKey: string, toKey: string): Promise<string> => ipcRenderer.invoke('audio:adopt-reference-clip', fromKey, toKey),
    renameReferenceClip: (fromKey: string, toKey: string): Promise<boolean> => ipcRenderer.invoke('audio:rename-reference-clip', fromKey, toKey),
    // 참조 source 지문(path|size|mtimeMs). 전사 확정 시 stamp해 두면 합성 경계에서 stale 폐기(§4).
    fingerprintReference: (filePath: string): Promise<string> => ipcRenderer.invoke('audio:fingerprint-reference', filePath),
    qwenPreflight: () => ipcRenderer.invoke('audio:qwen-preflight'),
    // pitch 후처리 capability(rubberband 지원 여부) — PitchCapability 계약. UI가 슬라이더 가용성에 소비.
    pitchPreflight: () => ipcRenderer.invoke('audio:pitch-preflight'),
    processTrack: (trackPath: string, outputDir: string, options: { transcribe?: boolean; translate?: boolean; srt?: boolean; translateModel?: string;
      /** ★고른 알아듣기 설정. 예전에는 빠져 파이썬 기본값으로 고정됐다(2026-09-24 감사). */
      whisperModel?: string; whisperLang?: string; asrSeparate?: string }) =>
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
    // 짐은 선택이다 — 본체가 요청 식별자를 실어 보낸다. 기존 화면은 그냥 무시한다.
    onCancelling: (callback: (data?: unknown) => void) => {
      const handler = (_event: unknown, data?: unknown) => callback(data)
      ipcRenderer.on('audio:cancelling', handler)
      return () => ipcRenderer.removeListener('audio:cancelling', handler)
    },
    onCancelled: (callback: (data?: unknown) => void) => {
      const handler = (_event: unknown, data?: unknown) => callback(data)
      ipcRenderer.on('audio:cancelled', handler)
      return () => ipcRenderer.removeListener('audio:cancelled', handler)
    },
    onCancelFailed: (callback: (data: unknown) => void) => {
      const handler = (_event: unknown, data: unknown) => callback(data)
      ipcRenderer.on('audio:cancel-failed', handler)
      return () => ipcRenderer.removeListener('audio:cancel-failed', handler)
    }
  },
  // 테스트개발 작업실 — 테이크 보관과 이어 붙여 내보내기만. 생성은 기존 audio.process 를 쓴다.
  /** 생성 카드 — 카드별 미디어. 카드 하나가 다른 카드의 파일을 건드리지 않는다. */
  cards: {
    /** 영상이면 소리를 꺼내 그 경로를, 소리 파일이면 그대로 돌려준다. */
    extractAudio: (cardId: string, filePath: string) =>
      ipcRenderer.invoke('card:extract-audio', cardId, filePath),
    /** 이 카드가 꺼내 둔 소리만 지운다. */
    releaseMedia: (cardId: string) => ipcRenderer.invoke('card:release-media', cardId),
  },
  lab: {
    keepTake: (srcPath: string, takeId: string): Promise<{ ok: boolean; path?: string; reason?: string }> =>
      ipcRenderer.invoke('lab:keep-take', srcPath, takeId),
    pruneTakes: (keepIds: string[]): Promise<{ ok: boolean; removed: number }> =>
      ipcRenderer.invoke('lab:prune-takes', keepIds),
    exportAll: (paths: string[], suggestedName?: string): Promise<{
      ok: boolean; path?: string; parts?: number; bytes?: number; canceled?: boolean; reason?: string
    }> => ipcRenderer.invoke('lab:export', paths, suggestedName),
  },
  // 음높이 곡선 — 보면서 손잡이로 맞춘다.
  //   ★숫자로는 좋고 나쁨을 가려내지 못했다(2026-09-26, 여섯 번 시도해 여섯 번 실패).
  //     그래서 화면이 그리고 사람이 본다.
  pitch: {
    /** 곡선 하나를 받아 온다(화면이 그릴 만큼 솎아서 온다). */
    curve: (audio: string, seconds?: number) =>
      ipcRenderer.invoke('pitch:curve', audio, seconds),
    /** 손잡이를 먹여 새 소리를 만든다. 빚은 곡선도 함께 온다. */
    reshape: (audio: string, dest: string,
             knobs: { smooth?: number; spread?: number; shift?: number },
             seconds?: number) =>
      ipcRenderer.invoke('pitch:reshape', audio, dest, knobs, seconds),
    /** 프로그램이 손잡이를 맞춰 준다 — 사람이 이어받아 돌릴 같은 손잡이다. */
    fit: (target: string, audio: string, seconds?: number) =>
      ipcRenderer.invoke('pitch:fit', target, audio, seconds),
  },
  // 영상 더빙. 번역 백엔드는 여기서 고르지 않는다 - 파이썬이 실행 경로 안쪽에서 막고 고른다.
  dub: {
    pickVideo: () => ipcRenderer.invoke('dub:pick-video'),
    runFront: (opts?: { language?: string; register?: string; force?: boolean }) =>
      ipcRenderer.invoke('dub:run-front', opts),
    originalVoice: () => ipcRenderer.invoke('dub:original-voice'),
    load: () => ipcRenderer.invoke('dub:load'),
    saveKorean: (edits: Record<number, string>) => ipcRenderer.invoke('dub:save-korean', edits),
    /** 고치는 즉시 쌓는다 — 저장 단추와 별개다. 줄 목록 파일은 건드리지 않는다. */
    saveEdits: (edits: Record<number, string>) => ipcRenderer.invoke('dub:save-edits', edits),
    /** 도는 앞단·내보내기를 멈춘다. 줄 소리는 공용 취소가 멈춘다. */
    cancel: () => ipcRenderer.invoke('dub:cancel'),
    render: (takes: Record<number, string>, destPath?: string) =>
      ipcRenderer.invoke('dub:render', takes, destPath),
    keepTake: (srcPath: string, index: number) =>
      ipcRenderer.invoke('dub:keep-take', srcPath, index),
    workDir: () => ipcRenderer.invoke('dub:work-dir'),
    /** 새 작업이 쌓이는 자리. */
    workRoot: () => ipcRenderer.invoke('dub:work-root'),
    /** 그 자리를 고른다. **이미 쌓인 것은 옮기지 않는다** — 옛 작업은 있던 자리에서 열린다. */
    setWorkRoot: () => ipcRenderer.invoke('dub:set-work-root'),
    /** 이미 만들어 둔 줄 소리를 되살린다 — 파일은 작업 폴더에 그대로 있다. */
    takes: () => ipcRenderer.invoke('dub:takes'),
    onProgress: (callback: (data: unknown) => void) => {
      const handler = (_event: unknown, data: unknown) => callback(data)
      ipcRenderer.on('dub:progress', handler)
      return () => ipcRenderer.removeListener('dub:progress', handler)
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key: string, value: unknown) => ipcRenderer.invoke('settings:set', key, value),
    /**
     * 종료 직전 저장용 **동기** 저장. main 이 파일을 쓰고 답할 때까지 돌아오지 않는다.
     * 비동기 요청만 던지고 창이 닫히면 마지막 변경이 사라지기 때문에 이 통로가 필요하다.
     * 자동 저장 키에만 열려 있다.
     */
    setSync: (key: string, value: unknown) => ipcRenderer.sendSync('settings:set-sync', key, value),
    selectPythonPath: () => ipcRenderer.invoke('settings:select-python-path')
  },
  app: {
    openFolder: (path: string) => ipcRenderer.invoke('app:open-folder', path),
    // 탐색기에서 그 파일을 고른 상태로 보여 준다(여는 것이 아니다).
    revealFile: (path: string) => ipcRenderer.invoke('app:reveal-file', path),
    readTextFile: (path: string) => ipcRenderer.invoke('app:read-text-file', path),
    // 교정본 저장 — 처음 인식한 파일은 그대로 두고 `_corrected` 로 새로 쓴다.
    saveCorrectedTranscript: (dir: string, base: string, txt: string, srt: string | null) =>
      ipcRenderer.invoke('transcript:save-corrected', dir, base, txt, srt),
    // 앱 버전·빌드 정보 — 인자 없는 read-only 조회. 경로를 주고받지 않는다.
    getBuildInfo: (): Promise<AppBuildInfo> => ipcRenderer.invoke('app:get-build-info'),
    // 진단 묶음 내보내기 — main 이 폴더를 묻고 만든다. 돌아오는 것은 묶음 폴더 **이름**과 로그 개수뿐.
    exportDiagnostics: (): Promise<ExportDiagnosticsResult> => ipcRenderer.invoke('app:export-diagnostics')
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
  // 감정 샘플러 — 논리 ID 만 오간다. 경로·전사·대본은 어떤 응답에도 없다.
  sampler: {
    generate: (request: SamplerGenerateRequest): Promise<SamplerGenerateResponse> =>
      ipcRenderer.invoke(SAMPLER_CHANNELS.generate, request),
    inventory: (): Promise<SamplerInventoryResponse> =>
      ipcRenderer.invoke(SAMPLER_CHANNELS.inventory),
    remove: (request: SamplerCacheKeyRequest): Promise<SamplerRemoveResponse> =>
      ipcRenderer.invoke(SAMPLER_CHANNELS.remove, request),
    previewUrl: (request: SamplerCacheKeyRequest): Promise<SamplerPreviewUrlResponse> =>
      ipcRenderer.invoke(SAMPLER_CHANNELS.previewUrl, request)
  },
  // 입력 분석 — read-only 조회 하나와 취소 하나. 응답에는 대사 원문이 없고 offset 만 온다.
  analysis: {
    analyze: (req: AnalysisRequest): Promise<AnalysisResponse> =>
      ipcRenderer.invoke(ANALYSIS_CHANNEL, req),
    cancel: (): Promise<{ cancelled: number }> => ipcRenderer.invoke(ANALYSIS_CANCEL_CHANNEL),
    prewarm: (): Promise<{ ready: boolean }> => ipcRenderer.invoke(ANALYSIS_PREWARM_CHANNEL)
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
