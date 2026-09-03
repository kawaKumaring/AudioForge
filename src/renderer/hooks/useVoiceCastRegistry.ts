/**
 * 배역 세트와 전역 참조 자산의 저장·복원·상태 전이.
 *
 * 상태 전이 규칙은 전부 shared `emotionCandidateRegistry` 의 순수 함수가 소유한다. 이
 * 훅이 하는 일은 셋뿐이다 — 기존 `settings` 채널로 읽고, 쓰고, **저장 결과를 기다렸다가**
 * 저장 상태를 알린다.
 *
 * 저장 상태를 화면의 임시 선택과 섞지 않는다. `settings:set` 이 성공을 돌려준 뒤에만
 * `저장됨` 이 되고, 실패하면 기존 저장본이 그대로 남았다는 사실을 유지한다.
 *
 * 활성 배역(`activeVoiceCastId`)은 **이 renderer 작업 세션에만** 산다. 저장하지 않으므로
 * 앱을 다시 열거나 새 파일을 열면 자동으로 적용되지 않는다 — 사용자가 다시 고른다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  EMPTY_VOICE_CAST_STORE, GLOBAL_ASSET_STORAGE_KEY, VOICE_CAST_STORAGE_KEY,
  addVoiceCast, autoRecommendable, createVoiceCast, deleteVoiceCast,
  deserializeAssetStore, deserializeVoiceCasts, evaluateLifecycle, findVoiceCast,
  makeAssetId, makeCandidateId, registerCastCandidate, removeCastCandidate,
  renameVoiceCast, serializeAssetStore, serializeVoiceCasts, setCastSelection,
  setSpeakerDefault,
} from '../../shared/emotionCandidateRegistry'
import { samplerSha256Hex } from '../../shared/emotionSampler'
import type {
  CastRestoreReport, ReferenceAsset, RestoreReport, VoiceCastCandidate, VoiceCastStore,
} from '../../shared/emotionCandidateRegistry'
import type { SaveState } from '../../shared/analysisWording'

/** `settings:set` 이 돌려주는 결과. main 이 실패를 성공으로 바꾸지 않는다. */
interface SettingsSetResult { ok?: boolean; code?: string }

export interface VoiceCastRegistryState {
  casts: VoiceCastStore
  assets: Record<string, ReferenceAsset>
  /** 이 작업 세션에서만 유효한 활성 배역. 저장되지 않는다. */
  activeVoiceCastId: string | null
  saveState: SaveState
  saveErrorCode: string | null
  /** 복원 집계(개수만). 경로·표시 이름이 들어가지 않는다. */
  castReport: CastRestoreReport | null
  assetReport: RestoreReport | null
  loaded: boolean
}

export interface VoiceCastRegistryApi extends VoiceCastRegistryState {
  createCast: (castName: string) => Promise<string | null>
  renameCast: (voiceCastId: string, castName: string) => Promise<void>
  removeCast: (voiceCastId: string) => Promise<void>
  applyCast: (voiceCastId: string) => void
  unapplyCast: () => void
  registerCandidate: (
    voiceCastId: string, candidate: VoiceCastCandidate, asset: ReferenceAsset
  ) => Promise<void>
  unregisterCandidate: (
    voiceCastId: string, speakerId: string, emotionId: string, candidateId: string
  ) => Promise<void>
  selectCandidate: (
    voiceCastId: string, speakerId: string, emotionId: string, choice: string | null
  ) => Promise<void>
  assignSpeakerDefault: (
    voiceCastId: string, speakerId: string, assetId: string | null, asset?: ReferenceAsset
  ) => Promise<void>
  /**
   * 파일 하나 또는 여러 개를 이 (화자, 감정)의 후보로 등록한다.
   *
   * 감정은 **호출부가 준 값**을 그대로 쓴다 — 파일을 보고 감정을 분류하지 않는다.
   * 길이·품질·SHA 는 기존 분석 경로(`audio:analyze-reference`,
   * `audio:fingerprint-reference`)를 재사용한다. 모델을 올리지 않는다.
   */
  addCandidateFiles: (
    voiceCastId: string, speakerId: string, emotionId: string, paths: readonly string[]
  ) => Promise<{ added: number; failed: number }>
  analyzing: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

function newCastId(): string {
  // 경로·이름·SHA 에서 파생하지 않는다. 난수 id 하나뿐이다.
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // randomUUID 가 없는 환경(구형 webview)에서도 파생 id 를 만들지 않는다.
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function useVoiceCastRegistry(): VoiceCastRegistryApi {
  const [casts, setCasts] = useState<VoiceCastStore>(EMPTY_VOICE_CAST_STORE)
  const [assets, setAssets] = useState<Record<string, ReferenceAsset>>({})
  const [activeVoiceCastId, setActive] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null)
  const [castReport, setCastReport] = useState<CastRestoreReport | null>(null)
  const [assetReport, setAssetReport] = useState<RestoreReport | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  // 저장 실패 시 화면을 되돌리기 위해 마지막 durable 값을 들고 있는다.
  const durable = useRef<{ casts: VoiceCastStore; assets: Record<string, ReferenceAsset> }>(
    { casts: EMPTY_VOICE_CAST_STORE, assets: {} })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const got = await window.api.settings.get() as Record<string, unknown>
        if (cancelled) return
        const castOut = deserializeVoiceCasts(got?.[VOICE_CAST_STORAGE_KEY] ?? null)
        // 파일 존재 확인은 등록 시점의 분석이 이미 남긴 값으로 판단한다 —
        // 복원할 때마다 디스크를 훑지 않는다(앱 시작을 느리게 만들지 않기 위해서다).
        const assetOut = deserializeAssetStore(got?.[GLOBAL_ASSET_STORAGE_KEY] ?? null,
          (asset) => ({
            sourcePresent: !!asset.sourcePath,
            clipPresent: !!asset.effectiveClipId,
          }))
        const byId: Record<string, ReferenceAsset> = {}
        for (const a of assetOut.assets) byId[a.assetId] = a
        setCasts(castOut.store)
        setAssets(byId)
        setCastReport(castOut.report)
        setAssetReport(assetOut.report)
        durable.current = { casts: castOut.store, assets: byId }
      } catch {
        // 읽기 실패는 "없음" 과 다르다. 빈 값을 저장하지 않는다 — 원본이 사라진다.
        setCastReport({
          restoredCasts: 0, quarantinedCasts: 0, quarantinedCandidates: 0,
          rootError: 'READ_FAILED',
        })
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  /** 두 키를 각각 저장한다. 하나라도 실패하면 화면을 durable 값으로 되돌린다. */
  const persist = useCallback(async (
    nextCasts: VoiceCastStore, nextAssets: Record<string, ReferenceAsset>
  ): Promise<boolean> => {
    setSaveState('saving')
    setSaveErrorCode(null)
    try {
      const results = await Promise.all([
        window.api.settings.set(VOICE_CAST_STORAGE_KEY,
          serializeVoiceCasts(nextCasts)) as Promise<SettingsSetResult>,
        window.api.settings.set(GLOBAL_ASSET_STORAGE_KEY,
          serializeAssetStore(Object.values(nextAssets))) as Promise<SettingsSetResult>,
      ])
      const bad = results.find((r) => r && r.ok === false)
      if (bad) {
        setCasts(durable.current.casts)
        setAssets(durable.current.assets)
        setSaveState('failed')
        setSaveErrorCode(bad.code ?? null)
        return false
      }
      durable.current = { casts: nextCasts, assets: nextAssets }
      setSaveState('saved')
      return true
    } catch (err) {
      setCasts(durable.current.casts)
      setAssets(durable.current.assets)
      setSaveState('failed')
      setSaveErrorCode((err as Error)?.name ?? 'SET_FAILED')
      return false
    }
  }, [])

  const commit = useCallback(async (
    nextCasts: VoiceCastStore, nextAssets?: Record<string, ReferenceAsset>
  ) => {
    const target = nextAssets ?? assets
    setCasts(nextCasts)
    if (nextAssets) setAssets(nextAssets)
    await persist(nextCasts, target)
  }, [assets, persist])

  const createCast = useCallback(async (castName: string) => {
    const id = newCastId()
    const next = addVoiceCast(casts, createVoiceCast(castName, id, nowIso()))
    const ok = await persist(next, assets)
    if (ok) {
      setCasts(next)
      return id
    }
    return null
  }, [casts, assets, persist])

  const renameCast = useCallback(async (voiceCastId: string, castName: string) => {
    await commit(renameVoiceCast(casts, voiceCastId, castName, nowIso()))
  }, [casts, commit])

  const removeCast = useCallback(async (voiceCastId: string) => {
    const { store } = deleteVoiceCast(casts, voiceCastId)
    // 자산과 사용자 원본은 지우지 않는다. 놓아 줄 파생 클립 판단은 자산 수명 계약의 몫이다.
    if (activeVoiceCastId === voiceCastId) setActive(null)
    await commit(store)
  }, [casts, activeVoiceCastId, commit])

  const applyCast = useCallback((voiceCastId: string) => {
    // 존재하는 배역만 적용한다. 하나뿐이어도 이 호출 없이는 적용되지 않는다.
    if (findVoiceCast(casts, voiceCastId)) setActive(voiceCastId)
  }, [casts])

  const unapplyCast = useCallback(() => setActive(null), [])

  const registerCandidate = useCallback(async (
    voiceCastId: string, candidate: VoiceCastCandidate, asset: ReferenceAsset
  ) => {
    const nextAssets = { ...assets, [asset.assetId]: asset }
    const next = registerCastCandidate(casts, voiceCastId, candidate, nowIso())
    await commit(next, nextAssets)
  }, [casts, assets, commit])

  const unregisterCandidate = useCallback(async (
    voiceCastId: string, speakerId: string, emotionId: string, candidateId: string
  ) => {
    // 등록 해제는 원본 파일 삭제가 아니다. 자산 기록도 남긴다(다른 배역이 쓸 수 있다).
    await commit(removeCastCandidate(casts, voiceCastId, speakerId, emotionId,
      candidateId, nowIso()))
  }, [casts, commit])

  const selectCandidate = useCallback(async (
    voiceCastId: string, speakerId: string, emotionId: string, choice: string | null
  ) => {
    await commit(setCastSelection(casts, voiceCastId, speakerId, emotionId, choice,
      nowIso()))
  }, [casts, commit])

  const assignSpeakerDefault = useCallback(async (
    voiceCastId: string, speakerId: string, assetId: string | null, asset?: ReferenceAsset
  ) => {
    const nextAssets = asset ? { ...assets, [asset.assetId]: asset } : assets
    await commit(setSpeakerDefault(casts, voiceCastId, speakerId, assetId, nowIso()),
      nextAssets)
  }, [casts, assets, commit])

  const addCandidateFiles = useCallback(async (
    voiceCastId: string, speakerId: string, emotionId: string, paths: readonly string[]
  ) => {
    if (!paths.length) return { added: 0, failed: 0 }
    setAnalyzing(true)
    let nextCasts = casts
    const nextAssets = { ...assets }
    let added = 0
    let failed = 0
    try {
      for (const path of paths) {
        try {
          // 기존 분석 경로 그대로. CPU 만 쓴다 — 모델도 GPU 도 건드리지 않는다.
          const sha = await window.api.audio.fingerprintReference(path)
          const info = await window.api.audio.analyzeReference(path,
            `cast-${voiceCastId}`) as {
              duration_sec?: number; valid_whole?: boolean
              errors?: { code: string }[]; warnings?: { code: string }[]
            }
          const codes = [
            ...(info?.errors ?? []).map((e) => e.code),
            ...(info?.warnings ?? []).map((w) => w.code),
          ]
          const quality = info?.valid_whole === false
            ? 'invalid' as const
            : ((info?.warnings ?? []).length > 0 ? 'warning' as const : 'ok' as const)
          const assetId = makeAssetId(sha, null)
          const base: ReferenceAsset = {
            assetId,
            sourcePath: path,
            sourceSha256: sha,
            sourceDurationSec: Number(info?.duration_sec ?? 0),
            sourceFormat: (path.split('.').pop() ?? '').toLowerCase(),
            region: null,
            effectiveClipId: null,
            profileId: null,
            qualityState: quality,
            qualityCodes: codes,
            // 출처는 사용자가 선언할 몫이다. 앱이 추측하지 않는다.
            sourceKind: 'unknown',
            lifecycle: 'ready',
            lifecycleCode: null,
          }
          const life = evaluateLifecycle(base,
            { sourcePresent: true, clipPresent: false, currentSourceSha256: sha })
          const asset: ReferenceAsset = { ...base, ...life }
          nextAssets[assetId] = asset
          nextCasts = registerCastCandidate(nextCasts, voiceCastId, {
            candidateId: makeCandidateId(assetId, speakerId, emotionId, samplerSha256Hex),
            assetId, speakerId, emotionId,
          }, nowIso())
          added++
        } catch {
          failed++   // 한 파일이 실패해도 나머지는 계속 등록한다
        }
      }
    } finally {
      setAnalyzing(false)
    }
    if (added > 0) {
      setCasts(nextCasts)
      setAssets(nextAssets)
      await persist(nextCasts, nextAssets)
    }
    return { added, failed }
  }, [casts, assets, persist])

  // `autoRecommendable` 은 후보 줄을 만들 때 shared 가 계산한다. 여기서 다시 쓰지 않도록
  // 참조만 남겨 두면 lint 가 미사용으로 잡으므로, 자산 등록 시점의 판정에만 쓴다.
  void autoRecommendable

  return {
    casts, assets, activeVoiceCastId, saveState, saveErrorCode, castReport, assetReport,
    loaded, analyzing,
    createCast, renameCast, removeCast, applyCast, unapplyCast,
    registerCandidate, unregisterCandidate, selectCandidate, assignSpeakerDefault,
    addCandidateFiles,
  }
}
