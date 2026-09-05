// 현재 작업 자동 저장·복원 — 합성하지 않고 앱을 닫아도 지금 만들던 것이 남는다.
//
// 규칙(계약은 shared/workDraft 하나뿐이다. 여기서 규칙을 다시 쓰지 않는다):
//   · 저장은 `workDrafts` 키에만 쓴다. 사용자가 명시적으로 저장한 목소리 구성(voiceCasts)과
//     전역 자산 등록부(referenceAssets)는 건드리지 않는다.
//   · 복원은 사용자에게 재확정을 요구하지 않는다. 보관 클립이 성하면 그것을, 없으면 **저장된 구간
//     그대로** 다시 만든다. 구간 추천을 다시 돌리지 않고 다른 구간·다른 인물 목소리로 대체하지 않는다.
//   · 복원 중에는 '목소리 준비 중'이고, 실제로 준비가 끝난 인물만 준비됨으로 바뀐다.
//   · 기록을 읽지 못했으면(rootError) 저장하지 않는다 — 빈 값으로 사용자의 기록을 덮지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react'

import { useAppStore } from '../stores/app.store'
import {
  WORK_DRAFT_STORAGE_KEY, buildWorkDraft, deserializeWorkDrafts, findWorkDraft, planWorkRestore,
  putWorkDraft, serializeWorkDrafts, slotForPlan, workDraftIsEmpty, workKeyOf,
} from '../../shared/workDraft'
import type { WorkDraft, WorkSlotPlan } from '../../shared/workDraft'

/** 자동 저장을 미루는 시간. 타자·슬라이더 조작마다 디스크를 건드리지 않기 위해서다. */
const SAVE_DEBOUNCE_MS = 700

export interface WorkDraftStatus {
  /** 복원이 진행 중인가(인물 하나라도 준비 중). */
  restoring: boolean
  /** 기록을 읽지 못한 사유. 있으면 이번 실행에서는 저장하지 않는다. */
  rootError: string | null
  /** 이번 복원에서 원본을 찾지 못해 재연결이 필요한 인물 id. */
  reconnectSpeakerIds: string[]
}

export function useWorkDraft(ttsEngine: string): WorkDraftStatus {
  const fileInfo = useAppStore((s) => s.fileInfo)
  const mode = useAppStore((s) => s.mode)
  const ttsText = useAppStore((s) => s.ttsText)
  const ttsSpeakerMode = useAppStore((s) => s.ttsSpeakerMode)
  const ttsSpeakerRefState = useAppStore((s) => s.ttsSpeakerRefState)
  const ttsSpeakerLabels = useAppStore((s) => s.ttsSpeakerLabels)
  const ttsSpeakerEmotionEnabled = useAppStore((s) => s.ttsSpeakerEmotionEnabled)
  const ttsSpeakerRenames = useAppStore((s) => s.ttsSpeakerRenames)
  const restoreWorkDraft = useAppStore((s) => s.restoreWorkDraft)
  const setSpeakerRefState = useAppStore((s) => s.setSpeakerRefState)

  const drafts = useRef<Record<string, WorkDraft>>({})
  const [loaded, setLoaded] = useState(false)
  const [rootError, setRootError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [reconnectSpeakerIds, setReconnect] = useState<string[]>([])
  /** 복원이 만든 변화가 곧바로 저장으로 돌아오지 않게 막는다. */
  const suppressSave = useRef(false)
  const restoredFor = useRef<string>('')
  const engineRef = useRef(ttsEngine)
  engineRef.current = ttsEngine

  // ── 기록 읽기(앱 실행에 한 번) ──
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const got = await window.api.settings.get() as Record<string, unknown>
        if (cancelled) return
        const out = deserializeWorkDrafts(got?.[WORK_DRAFT_STORAGE_KEY] ?? null)
        drafts.current = out.drafts
        setRootError(out.report.rootError)
      } catch {
        // 읽기 실패는 '없음' 과 다르다. 저장을 막아 기존 기록을 지키는 쪽으로 둔다.
        setRootError('READ_FAILED')
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  /** 인물 하나를 저장된 구간 그대로 되살린다. 실패하면 그 인물만 사유를 단다. */
  const prepareOne = useCallback(async (plan: WorkSlotPlan) => {
    if (plan.phase === 'reconnect') return
    // 원본을 통째로 쓰던 인물은 만들 것이 없다 — 원본이 그대로 있으면 그것이 곧 준비됨이다.
    if (!plan.region) {
      setSpeakerRefState(plan.speakerId, { clip: '', ready: true, message: '', region: null })
      return
    }
    try {
      const raw = await window.api.audio.trimReference(
        plan.source, plan.region.start, plan.region.duration, 'spk:' + plan.speakerId,
        { ttsEngine: engineRef.current },
      ) as Record<string, unknown>
      const metrics = raw?.metrics as { ready?: unknown; blocking?: unknown;
        effective_region?: { start_sec?: unknown; dur_sec?: unknown } } | undefined
      const blocking = Array.isArray(metrics?.blocking)
        ? metrics.blocking.filter((c): c is string => typeof c === 'string') : null
      const eff = metrics?.effective_region
      const spanOk = !!eff && typeof eff.start_sec === 'number' && typeof eff.dur_sec === 'number'
      const clip = typeof raw?.clip_path === 'string' ? raw.clip_path : ''
      const ok = raw?.status !== 'failed' && typeof raw?.code !== 'string'
        && blocking !== null && blocking.length === 0 && metrics?.ready === true && spanOk && !!clip
      if (ok) {
        setSpeakerRefState(plan.speakerId, {
          clip, ready: true, message: '',
          region: { start: eff!.start_sec as number, duration: eff!.dur_sec as number },
        })
        return
      }
      // 되살리지 못했다. 지정과 구간은 남겨 둔다 — 다른 목소리로 대체하지 않는다.
      setSpeakerRefState(plan.speakerId, {
        clip: '', ready: false, message: '저장해 둔 구간으로 목소리를 되살리지 못했습니다. 구간을 다시 확인해 주세요.',
      })
    } catch {
      setSpeakerRefState(plan.speakerId, {
        clip: '', ready: false, message: '저장해 둔 구간으로 목소리를 되살리지 못했습니다. 구간을 다시 확인해 주세요.',
      })
    }
  }, [setSpeakerRefState])

  // ── 복원(원본을 열 때 한 번) ──
  useEffect(() => {
    const path = fileInfo?.path || ''
    if (!loaded || mode !== 'tts' || !path) return
    const key = workKeyOf(path)
    if (!key || restoredFor.current === key) return
    // 이미 이 작업에 인물이 있으면(사용자가 방금 만든 것) 기록으로 덮지 않는다.
    if (Object.keys(useAppStore.getState().ttsSpeakerRefState).length > 0) { restoredFor.current = key; return }
    const found = findWorkDraft(drafts.current, path)
    if (!found || workDraftIsEmpty(found.draft)) { restoredFor.current = key; return }
    restoredFor.current = key

    let cancelled = false
    void (async () => {
      const draft = found.draft
      const sources = [...new Set(Object.values(draft.speakers).map((s) => s.source))]
      let present: Record<string, boolean> = {}
      try { present = await window.api.audio.sourcesPresent(sources) } catch { present = {} }
      if (cancelled) return
      const plans = planWorkRestore(draft, {
        // 보관 클립 재사용은 앱 관리 사본이 붙은 뒤부터다(다음 단계). 지금은 원본+구간으로만 되살린다.
        storedClipUsable: () => false,
        sourcePresent: (p) => present[p] === true,
      })
      const slots: Record<string, ReturnType<typeof slotForPlan>> = {}
      const labels: Record<string, string> = {}
      const emotionEnabled: Record<string, boolean> = {}
      for (const p of plans) {
        slots[p.speakerId] = slotForPlan(p)
        if (p.label) labels[p.speakerId] = p.label
        if (p.emotionEnabled) emotionEnabled[p.speakerId] = true
      }
      suppressSave.current = true
      restoreWorkDraft({
        ttsText: draft.ttsText, speakerMode: draft.speakerMode,
        slots, labels, emotionEnabled, renames: draft.renames,
      })
      setReconnect(plans.filter((p) => p.phase === 'reconnect').map((p) => p.speakerId))
      const preparing = plans.filter((p) => p.phase === 'preparing')
      setRestoring(preparing.length > 0)
      // 되살리기는 하나씩 한다 — 같은 파이썬 통로를 여럿이 동시에 두드리지 않는다.
      for (const p of preparing) {
        if (cancelled) return
        await prepareOne(p)
      }
      if (cancelled) return
      setRestoring(false)
      suppressSave.current = false
    })()
    return () => { cancelled = true; suppressSave.current = false }
  }, [loaded, mode, fileInfo?.path, restoreWorkDraft, prepareOne])

  // ── 자동 저장 ──
  useEffect(() => {
    const path = fileInfo?.path || ''
    if (!loaded || rootError || mode !== 'tts' || !path || suppressSave.current) return
    const key = workKeyOf(path)
    if (!key) return
    const draft = buildWorkDraft({
      sourcePath: path,
      ttsText,
      speakerMode: ttsSpeakerMode,
      speakers: ttsSpeakerRefState,
      labels: ttsSpeakerLabels,
      emotionEnabled: ttsSpeakerEmotionEnabled,
      renames: ttsSpeakerRenames,
      inheritSpeakerId: null,
      sourceSha256: drafts.current[key]?.sourceSha256 ?? null,
    })
    if (workDraftIsEmpty(draft)) return       // 빈 기록으로 쓸모 있는 기록을 덮지 않는다
    const timer = setTimeout(() => {
      drafts.current = putWorkDraft(drafts.current, key, draft)
      void window.api.settings.set(WORK_DRAFT_STORAGE_KEY, serializeWorkDrafts(drafts.current))
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [loaded, rootError, mode, fileInfo?.path, ttsText, ttsSpeakerMode, ttsSpeakerRefState,
    ttsSpeakerLabels, ttsSpeakerEmotionEnabled, ttsSpeakerRenames])

  return { restoring, rootError, reconnectSpeakerIds }
}
