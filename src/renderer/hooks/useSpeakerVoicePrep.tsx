// 인물 목소리 준비의 소유자.
//
// 왜 따로 뺐는가: 이 로직이 `TTSEditor.tsx`(1,772줄·훅 61개) 안에 다른 여섯 관심사와 섞여 있었다.
// 2026-09-08 에 이 부분에서 결함 둘이 나왔고(드라이버가 자기 진행 보고로 자신을 언마운트 / 트림 충돌),
// 고칠 때마다 그 거대한 파일 전체를 다시 읽어야 했다. 준비의 규칙을 한곳에 모아 두면 다음에 여기를
// 만질 사람이 파일 하나만 읽으면 된다.
//
// 여기서 소유하는 것
//   · 자동 준비 대상 선택(한 번에 한 명) — 끝나는 시점은 패널의 onAutoConfirmSettled 만이 정한다
//   · 그 인물의 구간 편집기 만들기(보이는 카드용·보이지 않는 드라이버용 공용)
//   · 목소리 교체 실패 복구(직전 정상 목소리 되돌리기)와 그 알림
//   · 목소리 지정 / 다시 준비 동작
//
// 여기서 소유하지 않는 것
//   · 첫 인물이 기본 목소리 준비 결과를 이어받는 흐름 — 기본 목소리 상태(ttsRefReady·클립·구간)와
//     엮여 있어 셸에 남겼다. 다음 정리 대상이다.
//   · 구간 추천·정책·확정 — 그것은 ReferenceRegionPanel 과 파이썬의 몫이다(이 훅은 부르기만 한다).
import { useCallback, useEffect, useRef, useState } from 'react'

import { useAppStore, refPhaseOf } from '@/stores/app.store'
import type { EmotionRefState } from '@/stores/app.store'
import ReferenceRegionPanel from '@/components/ReferenceRegionPanel'

export interface SpeakerVoicePrep {
  /** 지금 보이지 않는 자리에서 준비를 돌리고 있는 인물(없으면 null). 셸이 숨은 드라이버를 그린다. */
  autoPrep: { id: string; source: string } | null
  /**
   * 그 인물의 구간 편집기. open=false 면 도구를 그리지 않고 준비만 돌린다(마운트는 유지).
   * autoConfirm=true 면 추천 구간으로 한 번 자동 확정하고, 끝나면 다음 사람으로 넘어간다.
   */
  renderSpeakerRegion: (speakerId: string, open?: boolean, autoConfirm?: boolean) => React.ReactNode
  /** 파일을 골라 이 인물의 목소리로 등록한다. 취소하면 아무것도 바꾸지 않는다. */
  assignVoice: (speakerId: string, label?: string) => Promise<void>
  /** 준비가 멈춘 목소리를 같은 파일로 처음부터 다시 준비한다. */
  retryVoice: (speakerId: string) => void
  /** 교체 실패 등 목소리와 관련해 알릴 문구(없으면 null). */
  voiceReplaceNotice: string | null
  clearVoiceReplaceNotice: () => void
  /** 같은 자리에 알릴 문구를 셸이 넣는다(예: 기본 인물의 목소리는 여기서 바꾸지 않는다는 안내). */
  notify: (message: string) => void
}

export function useSpeakerVoicePrep(opts: {
  disabled: boolean
  /** 인물 id → 표시 이름. 알림 문구에 쓴다. */
  speakerLabelOf: (id: string) => string
  /**
   * 사용자가 카드에서 목소리 설정을 **펼쳐 둔** 인물(없으면 null).
   *
   * 우선순위 규칙(2026-09-09 관리자 검수): 한 슬롯의 보고자는 **하나여야 한다.**
   * 펼쳐 둔 인물은 그 카드가 맡고(자동 준비 드라이버가 잡지 않는다), 접힌 인물은 드라이버가 맡는다
   * (그동안 카드 쪽 패널은 아예 만들지 않는다). 예전에는 둘이 각자의 결론을 올려 서로를 덮었다.
   */
  openSpeakerId?: string | null
  /**
   * 작업 복원이 진행 중인가. 참이면 자동 준비는 **아무도 잡지 않는다**.
   *
   * 우선순위(2026-09-09 관리자 검수): 수동 지정 > 작업 복원 > 자동 준비.
   * 복원은 자기 슬롯에 요청 식별자를 심고 하나씩 되살린다 — 그동안 드라이버가 끼어들면
   * 같은 슬롯에 보고자가 둘이 된다. 사용자가 직접 고르면 새 식별자가 발급되어 복원 결과가 버려진다.
   */
  restoring?: boolean
}): SpeakerVoicePrep {
  const { disabled, speakerLabelOf, openSpeakerId = null, restoring = false } = opts
  const ttsSpeakerRefState = useAppStore((s) => s.ttsSpeakerRefState)
  const ttsSpeakerInherit = useAppStore((s) => s.ttsSpeakerInherit)
  const setSpeakerRefState = useAppStore((s) => s.setSpeakerRefState)
  const registerSpeakerRef = useAppStore((s) => s.registerSpeakerRef)
  const beginSpeakerRefRequest = useAppStore((s) => s.beginSpeakerRefRequest)

  // 한 번에 한 명만 준비한다 — 같은 파이썬 통로를 동시에 두드리지 않기 위해서다.
  const [autoPrep, setAutoPrep] = useState<{ id: string; source: string } | null>(null)
  // 이미 한 번 돌린 (인물|파일) — 다시 잡지 않는다(무한 재시도 금지).
  const autoPrepDone = useRef<Set<string>>(new Set())
  // 목소리를 교체하기 직전의 정상 상태 — 새 파일이 못 쓰게 되면 이것으로 되돌린다.
  const prevGoodVoice = useRef<Record<string, EmotionRefState>>({})
  const [voiceReplaceNotice, setVoiceReplaceNotice] = useState<string | null>(null)
  // 지금 드라이버가 붙잡은 인물 — 보고자를 하나로 유지하는 판정에 쓴다.
  // **렌더 중에 맞춘다**(효과가 아니라): 보고는 비동기로 오지만, 방금 잡은 인물을 놓친 채로
  // 카드 쪽 보고를 통과시키면 안 된다.
  const autoPrepRef = useRef<{ id: string; source: string } | null>(null)

  // ── 같은 슬롯에 보고자가 둘이면 안 된다 ─────────────────────────────────
  // 한 인물에 패널이 **두 개** 붙을 수 있다: 카드 안의 것과 보이지 않는 자동 준비 드라이버.
  // 예전에는 둘 다 '미준비 + 문구' 만 올려서 충돌이 보이지 않았는데, 단계를 명시하자
  // 카드 쪽의 'needs_region' 이 드라이버의 'ready' 를 덮어 준비가 끝나지 않는 것으로 드러났다
  // (2026-09-09 실측: 인물1 이 needs_region 에서 멈췄다).
  // 규칙: **드라이버가 붙잡고 있는 동안에는 그 인물의 보고자는 드라이버 하나뿐이다.**
  autoPrepRef.current = autoPrep

  const renderSpeakerRegion = useCallback((speakerId: string, open = true, autoConfirm = false) => {
    const slot = useAppStore.getState().ttsSpeakerRefState[speakerId]
    const src = slot?.source || ''
    if (!src) return null
    // 드라이버가 이 인물을 맡고 있으면 카드 쪽에는 패널을 만들지 않는다 — 패널이 둘이면
    // 각자의 분석이 각자의 결론을 올려 서로를 덮는다. 드라이버가 끝나면 카드가 새로 만들고,
    // 그때는 준비된 상태(committed)가 붙어 있어 낡은 결론으로 되돌리지 않는다.
    // 단, **사용자가 펼쳐 둔 편집기는 없애지 않는다**(open=true). 없애면 구간을 만지는 도중에
    // 화면이 사라진다 — 실측으로 그 일이 났다. 접힌 카드의 숨은 패널만 대상이다.
    if (!autoConfirm && autoPrepRef.current?.id === speakerId) return null
    const req = slot?.reqId || ''
    return (
      <ReferenceRegionPanel
        // 요청마다 새 인스턴스다. 같은 파일을 다시 골라도(다시 준비) 새 요청이면 새로 만들어야
        // 그 인스턴스가 자기 요청 식별자를 굳혀 들고 갈 수 있다.
        key={src + '|' + req}
        reqId={req}
        clipKey={'spk:' + speakerId}
        path={src}
        disabled={disabled}
        committed={slot?.ready
          ? { clip: slot.clip, region: slot.region, whole: !slot.clip && !slot.region }
          : null}
        onState={(st) => {
          // 늦게 도착한 이전 요청의 결과가 새 선택을 덮지 않게 한다. 파일을 연달아 고르면
          // 앞 파일의 분석이 뒤늦게 끝나 새 파일의 상태를 지우는 일이 실제로 일어난다.
          // 경로 비교만으로는 **같은 파일을 다시 고른 경우**를 가릴 수 없어 요청 식별자도 본다
          // (최종 판정은 store 가 한다 — 여기서 통과해도 store 가 낡은 요청이면 버린다).
          // 드라이버가 이 인물을 맡고 있으면 카드 쪽 패널은 보고하지 않는다(위 규칙).
          if (!autoConfirm && autoPrepRef.current?.id === speakerId) return
          const cur = useAppStore.getState().ttsSpeakerRefState[speakerId]
          if (cur?.source !== src) return
          if (req && cur?.reqId && cur.reqId !== req) return
          setSpeakerRefState(speakerId, st)
        }}
        label={`${speakerLabelOf(speakerId)} 목소리`}
        open={open}
        // 펼쳐 둔 카드가 이 인물을 맡았고 아직 준비되지 않았으면 그 카드가 자동 확정까지 한다.
        // 그러지 않으면 카드를 열어 둔 채 목소리를 바꿨을 때 아무도 확정하지 않아 멈춘다(실측).
        // 패널의 자동 확정은 (인물|파일)당 한 번이라 구간을 손으로 고친 뒤 덮어쓰지 않는다.
        autoConfirm={autoConfirm || (open && !slot?.ready)}
        onAutoConfirmSettled={autoConfirm ? () => {
          // 이 인물·이 파일의 자동 준비가 끝났다. 다시 잡지 않도록 표시하고 다음 사람으로 넘어간다.
          autoPrepDone.current.add(`${speakerId}|${src}`)
          setAutoPrep(null)
        } : undefined}
        plainStatus={!open}
      />
    )
    // ttsSpeakerRefState 를 의존성에 넣지 않는다 — 값은 호출 시점에 store 에서 직접 읽는다.
    // 넣으면 준비 상태가 바뀔 때마다 key 가 같은 패널이 새 함수로 다시 그려진다.
  }, [disabled, speakerLabelOf, setSpeakerRefState])

  // ── 자동 준비 대상 선택 ─────────────────────────────────────────────────
  // ★ 예전에는 '준비 상태 문구가 비었는가'로 대상을 골랐다. 그런데 패널이 분석을 시작하며 진행 문구를
  //   올리는 순간 그 조건이 깨져 **드라이버가 스스로 사라졌고**, 언마운트된 패널은 자동 확정에 이르지
  //   못했다(카드가 '목소리 확인 중'에서 멈추고 사용자가 손으로 구간을 확정해야 했던 실측 결함).
  //   그래서 한 명을 잡으면 **끝났다는 신호나 파일 교체 전까지 놓지 않는다.**
  useEffect(() => {
    if (autoPrep) {
      const st = ttsSpeakerRefState[autoPrep.id]
      if (st?.source === autoPrep.source && refPhaseOf(st) !== 'ready') return   // 아직 준비 중
      setAutoPrep(null)                                          // 준비됐거나 파일이 바뀌었다
      return
    }
    if (restoring) return                                     // 복원이 자기 슬롯을 맡는 동안 비켜 있는다
    const hit = Object.entries(ttsSpeakerRefState)
      .filter(([id, st]) => !!st?.source && refPhaseOf(st) !== 'ready'
        && !autoPrepDone.current.has(`${id}|${st.source}`)       // 이미 한 번 돌린 파일은 다시 돌리지 않는다
        && id !== ttsSpeakerInherit?.speakerId                   // 첫 인물 이어받기는 그쪽이 끝낸다
        && id !== openSpeakerId)                                // 펼쳐 둔 카드는 그 카드가 맡는다
      .sort((a, b) => a[0].localeCompare(b[0]))[0]
    if (hit) setAutoPrep({ id: hit[0], source: hit[1].source })
  }, [ttsSpeakerRefState, ttsSpeakerInherit, autoPrep, openSpeakerId, restoring])

  // ── 교체 실패 복구 ──────────────────────────────────────────────────────
  // ★판정은 **단계(phase)** 로 한다(2026-09-09 관리자 검수). 예전에는 안내 문구를 읽었다 —
  //   비어 있으면 '준비 중', '구간' 이라는 글자가 있으면 '수동 선택 필요' 로 봤다. 문구는 사람에게
  //   보여 주는 것이라 말이 조금 바뀌면 판정이 뒤집힌다.
  //   되돌리는 것은 phase === 'failed' 일 때만이다. needs_region 은 실패가 아니라 사용자 차례다.
  useEffect(() => {
    for (const [id, keep] of Object.entries(prevGoodVoice.current)) {
      const now = ttsSpeakerRefState[id]
      if (!now || now.source === keep.source) { delete prevGoodVoice.current[id]; continue }
      const phase = refPhaseOf(now)
      if (phase === 'ready') {
        // 새 목소리가 준비됐다. 새 준비가 클립을 만들지 않았다면(원본 전체 사용) 이전 클립은
        // 이제 아무도 쓰지 않는다 — 그때 놓는다. 성공 전에는 절대 놓지 않는다.
        if (keep.clip && !now.clip) {
          try { window.api?.audio?.releaseReferenceClip?.('spk:' + id) } catch { /* noop */ }
        }
        delete prevGoodVoice.current[id]
        continue
      }
      if (phase === 'preparing' || phase === 'idle') continue      // 아직 결론이 아니다
      if (phase === 'needs_region') { delete prevGoodVoice.current[id]; continue }  // 사용자 차례 — 실패 아님
      // phase === 'failed' — 이 파일로는 못 만든다. 이전 목소리를 그대로 되돌린다.
      // 클립 파일은 아직 살아 있다(등록 때 지우지 않도록 고쳤다) — 그래서 이 되돌리기가 실제로 쓰인다.
      delete prevGoodVoice.current[id]
      setSpeakerRefState(id, { clip: keep.clip, message: keep.message, region: keep.region,
                               phase: refPhaseOf(keep), reqId: now.reqId })
      useAppStore.setState((cur) => ({ ttsSpeakerRefState: {
        ...cur.ttsSpeakerRefState, [id]: { ...cur.ttsSpeakerRefState[id], source: keep.source } } }))
      setVoiceReplaceNotice(`${speakerLabelOf(id)}: 새로 고른 목소리를 준비하지 못해 이전 목소리를 그대로 씁니다. 다른 파일을 골라 주세요.`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsSpeakerRefState])

  const assignVoice = useCallback(async (speakerId: string, label?: string) => {
    const picked = await window.api.audio.selectFile()
    if (!picked) return                                    // 취소 — 아무것도 바꾸지 않는다
    const before = useAppStore.getState().ttsSpeakerRefState[speakerId]
    if (before?.ready) prevGoodVoice.current[speakerId] = before   // 교체 실패 시 돌려놓을 것
    setVoiceReplaceNotice(null)
    registerSpeakerRef(speakerId, String(picked), label)
  }, [registerSpeakerRef])

  const retryVoice = useCallback((speakerId: string) => {
    // 준비가 어떤 이유로든 멈췄을 때의 되살리기. 같은 파일로 분석·구간 확정을 처음부터 다시 한다.
    // 한 번 돌린 표시를 지우고 상태를 비워야 자동 준비가 이 인물을 다시 집는다.
    const src = useAppStore.getState().ttsSpeakerRefState[speakerId]?.source
    if (!src) return
    autoPrepDone.current.delete(`${speakerId}|${src}`)
    setVoiceReplaceNotice(null)
    // 같은 파일이어도 **새 요청**이다 — 새 식별자를 발급해야 이전 요청의 늦은 결과가 섞이지 않고,
    // 패널도 새 인스턴스로 다시 만들어져 분석을 처음부터 한다.
    // 클립·구간은 지우지 않는다 — 다시 준비가 실패하면 지금 쓰던 목소리가 남아야 한다.
    beginSpeakerRefRequest(speakerId)
    setAutoPrep(null)
  }, [setSpeakerRefState, beginSpeakerRefRequest])

  const clearVoiceReplaceNotice = useCallback(() => setVoiceReplaceNotice(null), [])
  const notify = useCallback((message: string) => setVoiceReplaceNotice(message), [])

  return { autoPrep, renderSpeakerRegion, assignVoice, retryVoice, voiceReplaceNotice, clearVoiceReplaceNotice, notify }
}
