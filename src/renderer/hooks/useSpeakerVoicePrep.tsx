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

import { useAppStore } from '@/stores/app.store'
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
  /** 교체 실패를 알린 문구(없으면 null). */
  voiceReplaceNotice: string | null
  clearVoiceReplaceNotice: () => void
}

export function useSpeakerVoicePrep(opts: {
  disabled: boolean
  /** 인물 id → 표시 이름. 알림 문구에 쓴다. */
  speakerLabelOf: (id: string) => string
}): SpeakerVoicePrep {
  const { disabled, speakerLabelOf } = opts
  const ttsSpeakerRefState = useAppStore((s) => s.ttsSpeakerRefState)
  const ttsSpeakerInherit = useAppStore((s) => s.ttsSpeakerInherit)
  const setSpeakerRefState = useAppStore((s) => s.setSpeakerRefState)
  const registerSpeakerRef = useAppStore((s) => s.registerSpeakerRef)

  // 한 번에 한 명만 준비한다 — 같은 파이썬 통로를 동시에 두드리지 않기 위해서다.
  const [autoPrep, setAutoPrep] = useState<{ id: string; source: string } | null>(null)
  // 이미 한 번 돌린 (인물|파일) — 다시 잡지 않는다(무한 재시도 금지).
  const autoPrepDone = useRef<Set<string>>(new Set())
  // 목소리를 교체하기 직전의 정상 상태 — 새 파일이 못 쓰게 되면 이것으로 되돌린다.
  const prevGoodVoice = useRef<Record<string, EmotionRefState>>({})
  const [voiceReplaceNotice, setVoiceReplaceNotice] = useState<string | null>(null)

  const renderSpeakerRegion = useCallback((speakerId: string, open = true, autoConfirm = false) => {
    const src = useAppStore.getState().ttsSpeakerRefState[speakerId]?.source || ''
    if (!src) return null
    const slot = useAppStore.getState().ttsSpeakerRefState[speakerId]
    return (
      <ReferenceRegionPanel
        key={src}
        clipKey={'spk:' + speakerId}
        path={src}
        disabled={disabled}
        committed={slot?.ready
          ? { clip: slot.clip, region: slot.region, whole: !slot.clip && !slot.region }
          : null}
        onState={(st) => {
          // 늦게 도착한 이전 파일의 결과가 새 선택을 덮지 않게 한다. 파일을 연달아 고르면
          // 앞 파일의 분석이 뒤늦게 끝나 새 파일의 상태를 지우는 일이 실제로 일어난다.
          if (useAppStore.getState().ttsSpeakerRefState[speakerId]?.source !== src) return
          setSpeakerRefState(speakerId, st)
        }}
        label={`${speakerLabelOf(speakerId)} 목소리`}
        open={open}
        autoConfirm={autoConfirm}
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
      if (st?.source === autoPrep.source && !st.ready) return   // 아직 준비 중 — 계속 붙잡는다
      setAutoPrep(null)                                          // 준비됐거나 파일이 바뀌었다
      return
    }
    const hit = Object.entries(ttsSpeakerRefState)
      .filter(([id, st]) => !!st?.source && !st.ready
        && !autoPrepDone.current.has(`${id}|${st.source}`)       // 이미 한 번 돌린 파일은 다시 돌리지 않는다
        && id !== ttsSpeakerInherit?.speakerId)                  // 첫 인물 이어받기는 그쪽이 끝낸다
      .sort((a, b) => a[0].localeCompare(b[0]))[0]
    if (hit) setAutoPrep({ id: hit[0], source: hit[1].source })
  }, [ttsSpeakerRefState, ttsSpeakerInherit, autoPrep])

  // ── 교체 실패 복구 ──────────────────────────────────────────────────────
  // 새 파일을 못 쓰게 됐고 '구간을 고르라'는 것도 아니면, 보관해 둔 정상 목소리를 되돌린다.
  useEffect(() => {
    for (const [id, keep] of Object.entries(prevGoodVoice.current)) {
      const now = ttsSpeakerRefState[id]
      if (!now || now.source === keep.source) { delete prevGoodVoice.current[id]; continue }
      if (now.ready) { delete prevGoodVoice.current[id]; continue }        // 새 목소리가 준비됐다
      const msg = now.message ?? ''
      if (msg === '') continue                                            // 아직 준비 중
      if (msg.includes('구간')) { delete prevGoodVoice.current[id]; continue }  // 수동 구간 선택 요청은 실패가 아니다
      delete prevGoodVoice.current[id]
      setSpeakerRefState(id, { clip: keep.clip, ready: keep.ready, message: keep.message, region: keep.region })
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
    setSpeakerRefState(speakerId, { clip: '', region: null, ready: false, message: '' })
    setAutoPrep(null)
  }, [setSpeakerRefState])

  const clearVoiceReplaceNotice = useCallback(() => setVoiceReplaceNotice(null), [])

  return { autoPrep, renderSpeakerRegion, assignVoice, retryVoice, voiceReplaceNotice, clearVoiceReplaceNotice }
}
