/**
 * 여러 명 화면의 projection — 원문 `ttsText` 하나를 발화 목록으로 보여 주고, 명령을
 * source patcher 로 바꿔 **같은 원문**에 되쓴다.
 *
 * 권위의 경계
 *   · 영속 권위는 `ttsText` 하나다. 이 훅은 사본을 만들지 않는다.
 *   · 화자·발화·좌표는 **계획(useInputAnalysis 결과)이 준 것**만 쓴다. 여기서 대본을
 *     다시 parse 하지 않는다. `hasOwnSpeakerDirective` 는 계획이 준 구간의 조각이 화자
 *     표기로 시작하는지를 보는 것뿐이다.
 *   · 원문 쓰기는 전부 `dialogueSourcePatcher` 의 명령을 거친다. 범용 직렬화기는 없다.
 *
 * 타이핑 계약
 *   · 대사 입력 중 값은 draft(임시 UI 값)다. 입력을 시작할 때 원문 SHA 를 붙잡아 두고,
 *     반영 직전에 지금 SHA 와 다르면 덮어쓰지 않고 draft 를 버려 최신 원문에 맞춘다.
 *   · 계획이 400ms 동안 낡아도 화면을 닫지 않는다. 잠기는 것은 좌표 의존 명령뿐이다.
 *   · 늦게 온 분석 결과는 `ttsText` 를 건드리지 않는다 — 결과는 읽기 전용 projection 에만
 *     들어온다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AnalysisResult } from '../../shared/inputAnalysis'
import { PLAN_WARNING_BLOCKS } from '../../shared/analysisWording'
import { samplerSha256Hex } from '../../shared/emotionSampler'
import {
  canMove, changeBaseEmotion, changeSpeaker, commitDecision, createInitialDialogue,
  deleteUtterance, insertUtteranceAfter, moveUtterance, replaceUtteranceBody, sliceOf,
  structurable, structuredEditingAllowed, structuredPatchAllowed, utteranceParts,
  validateSpeakerLabel, groupUtteranceRows, TRANSIENT_BLOCKERS,
} from '../../shared/dialogueSourcePatcher'
import type {
  PatchResult, StructureVerdict, UtteranceView,
} from '../../shared/dialogueSourcePatcher'


/** 화면이 그릴 인물. 계획에서 온 것과 아직 원문에 없는 것(pending)을 함께 담는다. */
export interface DialogueSpeaker {
  speakerId: string
  label: string
  utteranceCount: number
  /** 원문에 아직 없는 인물 — 이름만 입력된 카드. 어디에도 저장되지 않는다. */
  pending: boolean
}

export interface DialogueRow {
  view: UtteranceView
  /** 원문 조각(자기 지시 포함). 고급 편집기가 그대로 보여 준다. */
  slice: string
  /** 화자 표기·기본 감정을 뺀 본문. 기본 편집기가 보여 준다. */
  body: string
  /** 본문에 대사 중간 감정 태그가 있는가 — 있으면 기본 편집기는 태그를 지킬 의무가 있다. */
  hasMidEmotionTags: boolean
}

export interface DialogueProjection {
  verdict: StructureVerdict
  /** 구조화 화면을 열어도 되는가(일시적 사유만이면 참). */
  editingAllowed: boolean
  /** 좌표 의존 명령을 눌러도 되는가(계획이 현재 원문과 맞을 때만). */
  patchAllowed: boolean
  speakers: DialogueSpeaker[]
  rows: DialogueRow[]
  textSha: string
  /** 마지막 명령이 거부된 사유(비민감 토큰). 화면이 이유를 말할 때 쓴다. */
  lastRefusal: string | null

  // ── 인물(pending 은 로컬 UI 상태) ──
  addPendingSpeaker: () => void
  /** 빈 카드가 n 개 미만이면 채운다. 몇 번 불려도 결과가 같다(StrictMode 이중 effect 안전). */
  ensurePendingSpeakers: (n: number) => void
  renamePendingSpeaker: (speakerId: string, label: string) => void
  removePendingSpeaker: (speakerId: string) => void
  /** 원문에 발화가 있는 인물은 지우지 않는다 — 사유를 돌려준다. */
  canRemoveSpeaker: (speakerId: string) => { ok: boolean; reason: string | null }

  // ── 좌표 의존 명령(patchAllowed 일 때만) ──
  /** label null = 기본 인물(화자 표기 없음)로 되돌린다. */
  setSpeaker: (index: number, label: string | null) => string | null
  setBaseEmotion: (index: number, emotionTag: string | null) => string | null
  insertAfter: (index: number, label: string, line: string, emotionTag?: string | null) =>
    string | null
  remove: (index: number) => string | null
  move: (index: number, direction: -1 | 1) => string | null
  moveAllowed: (index: number, direction: -1 | 1) => { allowed: boolean; code: string | null }
  createInitial: (rows: { speakerLabel: string; line: string }[]) => string | null

  // ── 본문 draft ──
  draftOf: (index: number) => string | null
  beginDraft: (index: number) => void
  updateDraft: (index: number, body: string) => void
  /**
   * 반영. 원문이 그 사이 바뀌었으면 덮어쓰지 않고 draft 를 버린다('resync').
   * 원문은 그대로인데 계획만 아직 따라오지 않았으면(PLAN_MISSING/PLAN_STALE) draft 를 **보류**하고
   * 계획이 오면 그때 반영한다('deferred') — 늦은 분석이 사용자 글을 되돌리지 않는다.
   */
  commitDraft: (index: number, opts?: { advanced?: boolean }) =>
    'commit' | 'resync' | 'noop' | 'refused' | 'deferred'
  discardDraft: (index: number) => void
}

function toViews(text: string, result: AnalysisResult | null): UtteranceView[] {
  const plan = result?.plan
  if (!plan) return []
  // 계획 좌표 그대로 — 같은 줄 조각을 한 행으로 묶고 앞 화자 표기를 흡수하는 규칙은 패처가 소유한다.
  return groupUtteranceRows(text, plan.utterances)
}

type PendingSpeaker = { speakerId: string; label: string }

/** 기존 카드 번호의 최댓값 + 1. 상태만 보고 정하므로 몇 번 계산해도 같다. */
function nextPendingId(existing: PendingSpeaker[]): string {
  let max = 0
  for (const s of existing) {
    const m = /^pending-(\d+)$/.exec(s.speakerId)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `pending-${max + 1}`
}

export function useDialogueProjection(
  text: string,
  setText: (next: string) => void,
  result: AnalysisResult | null
): DialogueProjection {
  const textSha = useMemo(() => samplerSha256Hex(text), [text])
  const plan = result?.plan ?? null

  // 계획 좌표는 계획이 만들어진 원문에서만 뜻이 있다. 원문이 바뀐 뒤 계획이 따라오기 전(PLAN_STALE)
  // 에는 마지막으로 맞았던 (원문, 계획) 짝 위에서 행을 그린다 — 낡은 좌표를 새 원문에 대면
  // 잠깐 엉뚱한 조각이 보인다. 좌표 의존 명령은 그동안 잠기므로 이 스냅샷으로 쓰는 일은 없다.
  const planTextRef = useRef<{ sha: string; text: string } | null>(null)
  if (plan && plan.sourceSha256 === textSha) planTextRef.current = { sha: textSha, text }
  const projectionText = (plan && planTextRef.current && planTextRef.current.sha === plan.sourceSha256)
    ? planTextRef.current.text
    : text

  const views = useMemo(() => toViews(projectionText, result), [projectionText, result])

  const verdict = useMemo<StructureVerdict>(() => structurable({
    text,
    textSha256: textSha,
    planSourceSha256: plan?.sourceSha256 ?? null,
    parserAuthority: plan?.parserAuthority ?? false,
    utterances: views,
    offsetsExact: (plan?.utterances ?? []).map((u) => u.sourceOffsetsExact),
    hasBlockingWarning: (plan?.warnings ?? []).some((w) => PLAN_WARNING_BLOCKS[w.code] === true),
  }), [text, textSha, plan, views])

  const editingAllowed = structuredEditingAllowed(verdict)
  const patchAllowed = structuredPatchAllowed(verdict)

  const rows = useMemo<DialogueRow[]>(() => views.map((v) => {
    const slice = sliceOf(projectionText, v)
    const parts = utteranceParts(slice)
    return {
      view: v, slice, body: parts.body.trim(),
      hasMidEmotionTags: /\[[^\]]*\]/.test(parts.body),
    }
  }), [projectionText, views])

  // 아직 원문에 없는 인물. 이름만 있는 카드이며 어디에도 저장되지 않는다.
  const [pending, setPending] = useState<PendingSpeaker[]>([])
  const [lastRefusal, setLastRefusal] = useState<string | null>(null)

  const speakers = useMemo<DialogueSpeaker[]>(() => {
    const fromPlan = (plan?.speakers ?? []).map((s) => ({
      speakerId: s.speakerId, label: s.label, utteranceCount: s.utteranceCount, pending: false,
    }))
    const known = new Set(fromPlan.map((s) => s.label.trim().normalize('NFC').toLowerCase()))
    const extra = pending
      .filter((p) => !known.has(p.label.trim().normalize('NFC').toLowerCase()))
      .map((p) => ({ speakerId: p.speakerId, label: p.label, utteranceCount: 0, pending: true }))
    return [...fromPlan, ...extra]
  }, [plan, pending])

  const apply = useCallback((res: PatchResult): string | null => {
    if (res.changed) {
      setText(res.text)
      setLastRefusal(null)
      return null
    }
    setLastRefusal(res.refusedCode)
    return res.refusedCode
  }, [setText])

  const guard = useCallback((): string | null => {
    if (!patchAllowed) {
      const code = verdict.blockers[0] ?? 'PATCH_NOT_ALLOWED'
      setLastRefusal(code)
      return code
    }
    return null
  }, [patchAllowed, verdict.blockers])

  // ── 인물 ──
  // ID 는 ref 가 아니라 **이전 상태**에서 만든다. ref 를 밖에서 올리면 StrictMode 가 updater 를
  // 두 번 부를 때 같은 번호가 붙는다(실측: 카드 4개가 모두 pending-4).
  const addPendingSpeaker = useCallback(() => {
    setPending((p) => [...p, { speakerId: nextPendingId(p), label: '' }])
  }, [])
  const ensurePendingSpeakers = useCallback((n: number) => {
    setPending((p) => {
      if (p.length >= n) return p
      const out = [...p]
      while (out.length < n) out.push({ speakerId: nextPendingId(out), label: '' })
      return out
    })
  }, [])
  const renamePendingSpeaker = useCallback((speakerId: string, label: string) => {
    setPending((p) => p.map((s) => (s.speakerId === speakerId ? { ...s, label } : s)))
  }, [])
  const removePendingSpeaker = useCallback((speakerId: string) => {
    setPending((p) => p.filter((s) => s.speakerId !== speakerId))
  }, [])
  const canRemoveSpeaker = useCallback((speakerId: string) => {
    const s = speakers.find((x) => x.speakerId === speakerId)
    if (!s) return { ok: false, reason: 'SPEAKER_NOT_FOUND' }
    if (s.pending) return { ok: true, reason: null }
    // 발화가 남은 인물은 확인 없이 지우지 않는다 — 다른 인물로 재지정하거나 발화를 먼저 지운다.
    return s.utteranceCount > 0
      ? { ok: false, reason: 'SPEAKER_HAS_UTTERANCES' }
      : { ok: true, reason: null }
  }, [speakers])

  // ── 좌표 의존 명령 ──
  const setSpeaker = useCallback((index: number, label: string | null) => {
    const g = guard(); if (g) return g
    if (label !== null) {
      const check = validateSpeakerLabel(label)
      if (!check.ok) { setLastRefusal(`SPEAKER_LABEL_${check.problem}`); return `SPEAKER_LABEL_${check.problem}` }
    }
    return apply(changeSpeaker(text, views, index, label))
  }, [guard, apply, text, views])

  const setBaseEmotion = useCallback((index: number, emotionTag: string | null) => {
    const g = guard(); if (g) return g
    return apply(changeBaseEmotion(text, views, index, emotionTag))
  }, [guard, apply, text, views])

  const insertAfter = useCallback((
    index: number, label: string, line: string, emotionTag?: string | null
  ) => {
    const g = guard(); if (g) return g
    return apply(insertUtteranceAfter(text, views, index, label, line, emotionTag))
  }, [guard, apply, text, views])

  const remove = useCallback((index: number) => {
    const g = guard(); if (g) return g
    return apply(deleteUtterance(text, views, index))
  }, [guard, apply, text, views])

  const moveAllowed = useCallback((index: number, direction: -1 | 1) => {
    if (!patchAllowed) return { allowed: false, code: verdict.blockers[0] ?? 'PATCH_NOT_ALLOWED' }
    return canMove(text, views, index, index + direction)
  }, [patchAllowed, verdict.blockers, text, views])

  const move = useCallback((index: number, direction: -1 | 1) => {
    const g = guard(); if (g) return g
    return apply(moveUtterance(text, views, index, index + direction))
  }, [guard, apply, text, views])

  const createInitial = useCallback((rowsIn: { speakerLabel: string; line: string }[]) => {
    // 빈 원문 예외 — 계획 없이도 첫 대화를 만든다. 공백 외 문자가 있으면 patcher 가 거부한다.
    if (!verdict.initialCreationAllowed) { setLastRefusal('TEXT_NOT_EMPTY'); return 'TEXT_NOT_EMPTY' }
    const res = apply(createInitialDialogue(text, rowsIn))
    if (res === null) setPending([])   // 원문에 들어갔으니 pending 카드는 역할이 끝났다
    return res
  }, [verdict.initialCreationAllowed, apply, text])

  // ── 본문 draft ──
  type Draft = { body: string; capturedSha: string; pendingCommit?: { advanced: boolean } }
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const draftOf = useCallback((index: number) => drafts[index]?.body ?? null, [drafts])
  const beginDraft = useCallback((index: number) => {
    setDrafts((d) => d[index] ? d : {
      ...d, [index]: { body: rows[index]?.body ?? '', capturedSha: textSha },
    })
  }, [rows, textSha])
  const updateDraft = useCallback((index: number, body: string) => {
    // 입력은 계획 상태와 무관하게 계속 받는다. 붙잡은 SHA 는 처음 값으로 유지한다.
    setDrafts((d) => ({
      ...d, [index]: { body, capturedSha: d[index]?.capturedSha ?? textSha },
    }))
  }, [textSha])
  const discardDraft = useCallback((index: number) => {
    setDrafts((d) => { const n = { ...d }; delete n[index]; return n })
  }, [])
  const commitDraft = useCallback((index: number, opts: { advanced?: boolean } = {}) => {
    const d = drafts[index]
    if (!d) return 'noop' as const
    const committed = rows[index]?.body ?? ''
    const decision = commitDecision(d.capturedSha, textSha, d.body, committed)
    if (decision === 'noop') { discardDraft(index); return 'noop' as const }
    if (decision === 'commit' && !patchAllowed
      && verdict.blockers.every((b) => (TRANSIENT_BLOCKERS as readonly string[]).includes(b))) {
      // 원문은 그대로, 계획만 아직이다. 초안을 버리지 않고 보류한다 — 아래 effect 가 계획이 오면 반영한다.
      setDrafts((cur) => cur[index]
        ? { ...cur, [index]: { ...cur[index], pendingCommit: { advanced: !!opts.advanced } } }
        : cur)
      return 'deferred' as const
    }
    if (decision === 'resync' || !patchAllowed) {
      // 그 사이 원문이 바뀌었거나 좌표가 낡았다 — 덮어쓰지 않고 최신 원문에 맞춘다.
      discardDraft(index)
      setLastRefusal(decision === 'resync' ? 'STALE_SOURCE' : (verdict.blockers[0] ?? 'PATCH_NOT_ALLOWED'))
      return 'resync' as const
    }
    const res = replaceUtteranceBody(text, views, index, d.body, {
      allowEmotionTagChange: !!opts.advanced, capturedSha: d.capturedSha, currentSha: textSha,
    })
    discardDraft(index)
    return apply(res) === null ? 'commit' as const : 'refused' as const
  }, [drafts, rows, textSha, patchAllowed, verdict.blockers, text, views, apply, discardDraft])

  // 보류된 초안 — 계획이 따라와 좌표가 살아나면 한 번 반영한다. 그 사이 원문이 바뀌었으면
  // commitDraft 가 resync 로 정리한다(덮어쓰지 않음). 어느 경로든 draft 는 지워지므로 되돌지 않는다.
  useEffect(() => {
    if (!patchAllowed) return
    for (const [k, d] of Object.entries(drafts)) {
      if (d.pendingCommit) commitDraft(Number(k), { advanced: d.pendingCommit.advanced })
    }
  }, [patchAllowed, drafts, commitDraft])

  return {
    verdict, editingAllowed, patchAllowed, speakers, rows, textSha, lastRefusal,
    addPendingSpeaker, ensurePendingSpeakers, renamePendingSpeaker, removePendingSpeaker,
    canRemoveSpeaker,
    setSpeaker, setBaseEmotion, insertAfter, remove, move, moveAllowed, createInitial,
    draftOf, beginDraft, updateDraft, commitDraft, discardDraft,
  }
}
