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
  /**
   * 마지막 저장이 **실패**했는가(사유 코드). 있으면 화면이 미저장 상태와 다시 시도 방법을 알린다.
   * 예전에는 `void window.api.settings.set(...)` 로 응답을 버려서, 저장이 실패해도
   * 사용자는 저장된 줄 알았다(2026-09-09 관리자 검수).
   */
  saveError: string | null
  /** 저장을 다시 시도한다(사용자가 누르는 자리). */
  retrySave: () => void
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
  const [saveError, setSaveError] = useState<string | null>(null)
  /**
   * 아직 디스크에 못 간 변경. 화면 전환·파일 교체·종료 직전에 이것을 먼저 쓴다.
   *
   * 예전에는 저장을 700ms 미루고 그 대기를 **효과 정리에서 그냥 취소**했다. 그래서 대기 중에
   * 모드를 바꾸거나 파일을 교체하거나 창을 닫으면 마지막 변경이 사라졌다(관리자 검수).
   */
  const pending = useRef<{ key: string; draft: WorkDraft } | null>(null)
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

  /**
   * 인물 하나를 저장된 구간 그대로 되살린다. 실패하면 그 인물만 사유를 단다.
   *
   * ★결과를 적용하기 전에 **요청 당시와 같은 상태인지 확인한다**(2026-09-09 관리자 검수).
   *   예전에는 `await` 뒤에 아무 확인 없이 슬롯을 썼다. 되살리는 동안 사용자가 파일이나 목소리를
   *   바꾸면 옛 결과가 새 선택을 덮었다. 확인하는 것 셋:
   *     · 같은 작업인가(원본 파일이 그대로인가)
   *     · 그 인물의 원본이 계획과 같은가(그 사이 다른 목소리를 고르지 않았는가)
   *     · 그 슬롯의 요청 식별자가 그대로인가(수동 지정·다시 준비가 끼어들지 않았는가)
   *
   *   우선순위: **사용자의 손이 이긴다.** 복원은 자기 것이 아니게 된 슬롯을 건드리지 않는다.
   */
  // 계획 + 그 슬롯을 맡은 요청 식별자. 식별자는 계약(WorkSlotPlan)의 것이 아니라 화면 상태이므로
  // 여기서만 덧붙인다 — shared 계약에 화면 사정을 섞지 않는다.
  type RestoreJob = WorkSlotPlan & { reqId?: string }
  const prepareOne = useCallback(async (plan: RestoreJob, workPath: string) => {
    if (plan.phase === 'reconnect') return
    /** 이 계획의 결과를 아직 적용해도 되는가. 적용 직전에 다시 본다. */
    const stillMine = () => {
      const st = useAppStore.getState()
      if ((st.fileInfo?.path || '') !== workPath) return false          // 다른 작업으로 옮겼다
      const slot = st.ttsSpeakerRefState[plan.speakerId]
      if (!slot || slot.source !== plan.source) return false            // 다른 목소리를 골랐다
      if (plan.reqId && slot.reqId && slot.reqId !== plan.reqId) return false  // 다른 요청이 맡았다
      return true
    }
    if (!stillMine()) return
    // 원본을 통째로 쓰던 인물은 만들 것이 없다 — 원본이 그대로 있으면 그것이 곧 준비됨이다.
    if (!plan.region) {
      setSpeakerRefState(plan.speakerId, { clip: '', phase: 'ready', message: '', region: null,
                                           reqId: plan.reqId })
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
      if (!stillMine()) return          // 그 사이 사용자가 바꿨다 — 옛 결과를 적용하지 않는다
      if (ok) {
        setSpeakerRefState(plan.speakerId, {
          clip, phase: 'ready', message: '', reqId: plan.reqId,
          region: { start: eff!.start_sec as number, duration: eff!.dur_sec as number },
        })
        return
      }
      // 되살리지 못했다. 지정과 구간은 남겨 둔다 — 다른 목소리로 대체하지 않는다.
      setSpeakerRefState(plan.speakerId, {
        clip: '', phase: 'needs_region', reqId: plan.reqId,
        message: '저장해 둔 구간으로 목소리를 되살리지 못했습니다. 구간을 다시 확인해 주세요.',
      })
    } catch {
      if (!stillMine()) return
      setSpeakerRefState(plan.speakerId, {
        clip: '', phase: 'needs_region', reqId: plan.reqId,
        message: '저장해 둔 구간으로 목소리를 되살리지 못했습니다. 구간을 다시 확인해 주세요.',
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
        // ★순서가 중요하다: **소유를 확인한 뒤에** 선점한다.
        //   반대로 하면(선점 먼저) 그 사이 사용자가 고른 목소리의 요청 식별자를 복원이 덮어써서,
        //   그 목소리의 준비 보고가 낡은 것으로 취급돼 영영 준비되지 않는다.
        const st0 = useAppStore.getState()
        if ((st0.fileInfo?.path || '') !== path) return          // 다른 작업으로 옮겼다
        const cur = st0.ttsSpeakerRefState[p.speakerId]
        if (!cur || cur.source !== p.source) continue            // 사용자가 이미 다른 목소리를 골랐다
        // 이제 이 슬롯을 복원이 맡았다고 선언한다(요청 식별자 발급). 이후 사용자가 직접 고르면
        // 새 식별자가 발급되므로 복원의 늦은 결과는 store 와 stillMine() 이 함께 버린다.
        useAppStore.getState().beginSpeakerRefRequest(p.speakerId)
        const claimed = useAppStore.getState().ttsSpeakerRefState[p.speakerId]
        await prepareOne({ ...p, reqId: claimed?.reqId }, path)
      }
      if (cancelled) return
      setRestoring(false)
      suppressSave.current = false
    })()
    return () => { cancelled = true; suppressSave.current = false }
  }, [loaded, mode, fileInfo?.path, restoreWorkDraft, prepareOne])

  /**
   * 미저장 변경을 지금 쓴다. **응답을 확인한다** — 실패하면 미저장로 남기고 사유를 올린다.
   * 여러 번 불려도 안전하다(쓸 것이 없으면 아무것도 하지 않는다).
   */
  const flush = useCallback(async () => {
    const p = pending.current
    if (!p || rootError) return
    drafts.current = putWorkDraft(drafts.current, p.key, p.draft)
    try {
      const payload = serializeWorkDrafts(drafts.current)
      const r = (await window.api.settings.set(WORK_DRAFT_STORAGE_KEY, payload)) as
        { ok?: boolean; code?: string } | undefined
      if (r && r.ok === false) {
        setSaveError(r.code || 'SAVE_FAILED')      // 저장된 것처럼 두지 않는다
        return
      }
      pending.current = null
      setSaveError(null)
    } catch (e) {
      setSaveError((e as Error)?.name || 'SAVE_FAILED')
    }
  }, [rootError])

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
    pending.current = { key, draft }
    const timer = setTimeout(() => { void flush() }, SAVE_DEBOUNCE_MS)
    // ★대기 중 전환·언마운트에서는 **먼저 쓰고** 대기를 끝낸다(예전에는 그냥 취소했다).
    return () => { clearTimeout(timer); void flush() }
  }, [loaded, rootError, mode, fileInfo?.path, ttsText, ttsSpeakerMode, ttsSpeakerRefState,
    ttsSpeakerLabels, ttsSpeakerEmotionEnabled, ttsSpeakerRenames, flush])

  // ── 종료 직전 ──
  // 비동기 요청만 던지고 창이 닫히면 마지막 변경이 사라진다. 동기 통로로 **쓰고 나서** 닫힌다.
  useEffect(() => {
    const onBeforeUnload = () => {
      const p = pending.current
      if (!p || rootError) return
      try {
        drafts.current = putWorkDraft(drafts.current, p.key, p.draft)
        const payload = serializeWorkDrafts(drafts.current)
        const r = window.api.settings.setSync(WORK_DRAFT_STORAGE_KEY, payload) as
          { ok?: boolean } | undefined
        if (r?.ok) pending.current = null
      } catch { /* 종료 경로에서는 더 할 수 있는 것이 없다 */ }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [rootError])

  return { restoring, rootError, reconnectSpeakerIds, saveError, retrySave: () => { void flush() } }
}
