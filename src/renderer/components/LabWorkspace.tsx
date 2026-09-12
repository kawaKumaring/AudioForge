// 테스트개발 작업실 — 대본을 쓰고, 문장별로 음성을 만들고, 고른 것으로 전체를 완성한다.
//
// 기존 합성 화면의 카드·단계 구성을 따라 만들지 않았다. 이 작업실의 목적에서 새로 짰다.
//   · 가운데는 **대본**이다. 설정이 대본보다 큰 자리를 차지하지 않는다.
//   · 한 줄이 한 발화다. 줄마다 입력칸이 따로라 **자동 문장 분리로 입력을 바꾸지 않고**,
//     한 줄을 고쳐도 다른 줄이 다시 그려지지 않아 커서·화면 위치가 유지된다.
//   · 고른 줄 **바로 아래**에 필요한 조작이 붙는다(생성·듣기·다른 테이크·채택).
//   · 아래 고정 막대에 전체 조작과 진행·취소가 있다.
//   · 엔진·참조 방식·난수 같은 내부 설정은 이 화면에 두지 않는다.
//
// 소리를 만드는 일은 **기존 합성 경로를 그대로** 부른다(엔진·기본값 그대로).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '@/stores/app.store'
import { useLabStore, newId } from '@/stores/lab.store'
import {
  LAB_STORAGE_KEY, adoptedTake, exportReadiness, hasUnusedTake,
  lineStatus, lineStatusText, linesNeedingWork, parseDoc, redoTargets, takeBadge, voiceKeyOf,
  type LabDoc, type LabLine, type LabSettings,
} from '../../shared/labWorkspace'
import { REFERENCE_CONDITIONING_RECOMMENDED } from '../../shared/ttsConfig'
import { createManagedAudio } from '@/lib/playbackVolume'
import ReferenceRegionPanel from '@/components/ReferenceRegionPanel'

const box = (extra?: React.CSSProperties): React.CSSProperties => ({
  background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 12, ...extra,
})
const btn = (bg: string, fg: string, disabled?: boolean): React.CSSProperties => ({
  padding: '7px 12px', borderRadius: 8, border: 'none', fontFamily: 'inherit', fontSize: 12,
  fontWeight: 600, background: bg, color: fg,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
})

/**
 * 생성 요청 인자 — **작업실 소유 설정**으로만 만든다.
 *
 * ★합성 탭의 현재 값을 읽지 않는다. 기존 합성 **기능**은 그대로 쓰되, 합성 탭에서 속도·엔진을
 *   바꾼 것이 이 작업실에 조용히 반영되면 "같은 대본인데 결과가 달라졌다" 가 되기 때문이다.
 */
function processOptions(text: string, s: LabSettings,
                        ref: { clip: string; region: { start: number; duration: number } | null }) {
  return {
    ttsText: text,
    ttsSpeed: s.speed, ttsSilenceGap: s.silenceGap, ttsPitch: s.pitch,
    ttsEngine: s.engine, ttsQwenModel: s.qwenModel,
    ttsReferenceOverride: ref.clip, ttsReferenceRegion: ref.region,
    ttsReferenceConditioningMode: s.referenceConditioningMode,
    ttsSpeakerMode: 'single' as const,
  }
}

const STATUS_COLOR: Record<string, string> = {
  ready: 'var(--emerald, #34d399)', none: 'var(--text-muted)',
  stale_text: 'var(--amber, #fbbf24)', stale_voice: 'var(--amber, #fbbf24)',
  empty: 'var(--text-muted)',
}

export default function LabWorkspace() {
  const app = useAppStore()
  const lab = useLabStore()
  const { doc, selectedLineId, job } = lab
  const voiceKey = voiceKeyOf(doc.voicePath)

  const [playingTakeId, setPlayingTakeId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const chainRef = useRef<{ stop: boolean }>({ stop: false })
  /** 전체 듣기가 '이 문장이 끝나기'를 기다리는 자리. 멈출 때 풀어 줘야 한다. */
  const waiterRef = useRef<(() => void) | null>(null)
  /** 순서 바꾸기 — 끌고 있는 문장과 놓일 자리(그 문장 **앞**인지). */
  const [drag, setDrag] = useState<{ id: string; overId: string; before: boolean } | null>(null)
  /**
   * 이번 실행이 무엇을 남겼는지 — 끝났을 때 **무슨 일이 있었는지 반드시 말하기 위해서**다.
   * 이전 결과를 보존하는 원칙 때문에 새 생성본이 자동 선택되지 않는 경우가 있는데,
   * 아무 말도 없으면 "눌렀는데 아무 일도 없다" 로 보인다.
   */
  const runRef = useRef<{ made: number; picked: number; waiting: number }>({ made: 0, picked: 0, waiting: 0 })

  // ── 저장·복원 — 기존 작업 저장과 **다른 열쇠**를 쓴다 ─────────────────────
  useEffect(() => {
    // ★한 번만 불러온다. 탭을 옮겼다 돌아오면 이 화면은 다시 만들어지지만, 작업 내용은
    //   화면이 아니라 작업실 상태에 있다. 여기서 저장본을 다시 읽어 덮으면 **방금 쓴 글이
    //   옛 저장본으로 되돌아간다**(실측 결함 — 탭 전환만으로 대본이 사라졌다).
    if (useLabStore.getState().loaded) return
    let alive = true
    ;(async () => {
      try {
        const got = await window.api.settings.get() as Record<string, unknown>
        const parsed = parseDoc(got?.[LAB_STORAGE_KEY], REFERENCE_CONDITIONING_RECOMMENDED)
        if (alive && parsed) lab.setDoc(parsed)
      } catch { /* 없으면 빈 대본으로 시작한다 */ }
      if (alive) lab.markLoaded()
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!lab.loaded) return                   // 불러오기 전 빈 문서로 덮어쓰지 않는다
    const t = setTimeout(() => {
      void window.api.settings.set(LAB_STORAGE_KEY, doc)
    }, 600)
    // ★화면이 사라질 때(탭 전환·앱 종료) **기다리던 저장을 그냥 버리지 않는다.**
    //   600ms 안에 탭을 옮기면 방금 쓴 글이 저장되지 않은 채 사라졌다.
    return () => {
      clearTimeout(t)
      void window.api.settings.set(LAB_STORAGE_KEY, useLabStore.getState().doc)
    }
  }, [doc, lab.loaded])

  // ── 재생 ────────────────────────────────────────────────────────────────
  /**
   * 재생을 **실제로** 멈춘다. 합성 작업 취소와는 다른 일이다 — 만들던 것은 계속 만든다.
   *
   * ★pause() 는 'ended' 를 내지 않는다. 전체 듣기는 문장이 끝나기를 기다리고 있으므로,
   *   기다리는 쪽을 직접 풀어 주지 않으면 그 자리에 멈춘 채 남는다.
   */
  const stopPlay = useCallback(() => {
    chainRef.current.stop = true
    const el = audioRef.current
    try { el?.pause() } catch { /* noop */ }
    if (el) { el.onended = null; el.onerror = null }
    const w = waiterRef.current
    waiterRef.current = null
    if (w) w()
    setPlayingTakeId(null)
  }, [])

  const playPath = useCallback(async (path: string, takeId: string) => {
    stopPlay()
    chainRef.current = { stop: false }
    const url = await window.api.audio.getFileUrl(path)
    const el = audioRef.current || createManagedAudio()   // 음량은 공용 값을 따른다
    audioRef.current = el
    el.src = url
    setPlayingTakeId(takeId)
    el.onended = () => setPlayingTakeId(null)
    el.onerror = () => setPlayingTakeId(null)
    try { await el.play() } catch { setPlayingTakeId(null) }
  }, [stopPlay])

  /** 같은 것을 누르면 멈추고, 다른 것을 누르면 그것을 재생한다. */
  const togglePlay = useCallback((path: string, takeId: string) => {
    if (playingTakeId === takeId) { stopPlay(); return }
    void playPath(path, takeId)
  }, [playingTakeId, playPath, stopPlay])

  /** 전체 듣기 — 채택한 테이크를 대본 순서대로. 준비되지 않은 자리가 있으면 시작하지 않는다. */
  const playAll = useCallback(async () => {
    const r = exportReadiness(doc)
    if (!r.ready) {
      lab.setNotice(noticeFor(r))
      return
    }
    stopPlay()
    const chain = { stop: false }
    chainRef.current = chain
    const el = audioRef.current || createManagedAudio()
    audioRef.current = el
    for (const p of r.paths) {
      if (chain.stop) break
      const url = await window.api.audio.getFileUrl(p)
      el.src = url
      setPlayingTakeId('all')
      await new Promise<void>((resolve) => {
        const done = () => { waiterRef.current = null; resolve() }
        waiterRef.current = done          // 멈춤 단추가 이 자리를 풀어 준다
        el.onended = done
        el.onerror = done
        el.play().catch(done)
      })
      if (chain.stop) break               // 멈췄으면 **다음 문장으로 넘어가지 않는다**
    }
    if (!chain.stop) setPlayingTakeId(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, stopPlay])

  /** 전체 듣기 단추 — 도는 중이면 멈춘다. */
  const togglePlayAll = useCallback(() => {
    if (playingTakeId === 'all') { stopPlay(); return }
    void playAll()
  }, [playingTakeId, playAll, stopPlay])

  // ── 생성 — 기존 합성 경로를 그대로 부른다 ─────────────────────────────────
  const busyElsewhere = app.status === 'processing' && !job
  // ★게이트는 **작업실 자신의** 목소리 준비 상태를 본다. 합성 탭의 참조 슬롯이 아니다.
  const canGenerate = !!doc.voicePath && !!lab.ref.clip && lab.ref.ready && !job && !busyElsewhere

  const startJob = useCallback((lineIds: string[]) => {
    const ids = lineIds.filter((id) => {
      const l = doc.lines.find((x) => x.id === id)
      return !!l && !!l.text.trim()
    })
    if (!ids.length) { lab.setNotice('만들 대사가 없습니다.'); return }
    const first = doc.lines.find((l) => l.id === ids[0])!
    lab.setError(null); lab.setNotice(null)
    runRef.current = { made: 0, picked: 0, waiting: 0 }
    // 요청 당시의 대사·목소리를 붙들어 둔다 — 도중에 고쳐도 결과에는 이 값이 붙는다.
    lab.setJob({ lineId: first.id, text: first.text, voiceKey, startedAt: Date.now(), queue: ids.slice(1) })
    // 공용 작업 제어: 기존 합성과 **동시에** 돌지 않도록 같은 상태를 쓴다.
    // ★기존 결과(tracks)는 지우지 않는다 — 다른 탭의 결과를 없애지 않기 위해서다.
    useAppStore.setState({ status: 'processing', progress: 0, progressMessage: '문장 만드는 중...', error: null })
    void window.api.audio.process(doc.voicePath, 'tts', processOptions(first.text, doc.settings, lab.ref))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, voiceKey, lab.ref])

  // 결과·진행·오류를 받는다. 취소·실패로 **이미 만든 테이크와 채택 상태를 잃지 않는다.**
  useEffect(() => {
    const offP = window.api.audio.onProgress((d: any) => {
      if (!useLabStore.getState().job) return
      lab.setProgress({ percent: Number(d?.percent) || 0, message: String(d?.message || '') })
    })
    const offR = window.api.audio.onResult((d: any) => {
      const j = useLabStore.getState().job
      if (!j) return
      const src = (d?.tracks || [])[0]?.path
      void (async () => {
        if (src) {
          const takeId = newId('tk')
          const kept = await window.api.lab.keepTake(src, takeId)
          if (kept?.ok && kept.path) {
            // ★요청 당시의 대사·목소리가 붙는다. 지금 대사와 다르면 자동 채택되지 않고
            //   '수정 전 대사' 꼬리표가 붙는다 — 늦은 결과를 최신인 것처럼 쓰지 않는다.
            useLabStore.getState().addTake(j.lineId, {
              id: takeId, path: kept.path, text: j.text, voiceKey: j.voiceKey, createdAt: Date.now(),
            })
            // 자동으로 골라졌는가, 아니면 사용자가 골라야 하는가.
            const after = useLabStore.getState().doc.lines.find((l) => l.id === j.lineId)
            runRef.current.made += 1
            if (after?.adoptedTakeId === takeId) runRef.current.picked += 1
            else runRef.current.waiting += 1
          } else {
            lab.setError(kept?.reason || '결과를 보관하지 못했습니다')
          }
        }
        next(j)
      })()
    })
    const offE = window.api.audio.onError((d: any) => {
      if (!useLabStore.getState().job) return
      // 실패를 감추지 않는다 — 어느 단계에서 멈췄는지와 다음 행동을 함께 알린다.
      const why = String(d?.message || '알 수 없는 이유')
      lab.setError(`문장 만들기에 실패했습니다 — ${why} · 목소리가 준비됐는지 확인하고 다시 시도하세요. `
        + '계속 실패하면 다른 목소리 파일로 바꿔 보세요. 이미 만든 생성본과 선택은 그대로 있습니다.')
      finish()
    })
    const offCancelled = window.api.audio.onCancelled(() => {
      if (!useLabStore.getState().job) return
      lab.setNotice('취소했습니다. 이미 만든 결과와 고른 것은 그대로 있습니다.')
      finish()
    })

    function finish() {
      useLabStore.getState().setJob(null)
      useLabStore.getState().setProgress(null)
      useAppStore.setState({ status: 'idle', progress: 0, progressMessage: '' })
      // ★완료됐는데 화면이 그대로인 것처럼 두지 않는다.
      const r = runRef.current
      if (r.made > 0 && !useLabStore.getState().error) {
        useLabStore.getState().setNotice(r.waiting > 0
          ? `새 생성본이 있습니다. 사용할 음성을 선택하세요. (새로 만든 ${r.made}개 중 ${r.waiting}개는 이전 결과를 그대로 두었습니다)`
          : `${r.made}개 문장의 음성을 만들었습니다.`)
      }
      runRef.current = { made: 0, picked: 0, waiting: 0 }
    }
    function next(j: { queue: string[] }) {
      const rest = j.queue
      if (!rest.length) { finish(); return }
      const st = useLabStore.getState()
      const line = st.doc.lines.find((l) => l.id === rest[0])
      if (!line || !line.text.trim()) { next({ queue: rest.slice(1) }); return }
      st.setJob({ lineId: line.id, text: line.text, voiceKey: voiceKeyOf(st.doc.voicePath),
                  startedAt: Date.now(), queue: rest.slice(1) })
      void window.api.audio.process(st.doc.voicePath, 'tts',
        processOptions(line.text, st.doc.settings, st.ref))
    }
    return () => { offP(); offR(); offE(); offCancelled() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 목소리 고르기 ────────────────────────────────────────────────────────
  const pickVoice = useCallback(async () => {
    const picked = await window.api.audio.selectFile()
    const p: string | undefined = Array.isArray(picked) ? picked[0] : (picked as any)?.path || picked
    if (typeof p !== 'string' || !p) return
    const info = await window.api.audio.getFileInfo(p)
    // ★합성 탭의 원본·결과·참조는 건드리지 않는다(setFile 을 부르지 않는다).
    //   목소리 준비는 아래 숨은 준비기가 작업실 자신의 자리에 담는다.
    lab.setVoice(p, (info as any)?.name || p.split(/[/\\]/).pop() || '목소리')
  }, [])

  /**
   * 문장을 지우거나 옮기기 전에 **재생을 멈춘다.**
   * 전체 듣기는 시작할 때의 순서를 따라 돌고 있으므로, 그대로 두면 이전 순서로 다음 문장이 나간다.
   */
  const removeLine = useCallback((id: string) => {
    stopPlay()
    lab.removeLine(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopPlay])

  const dropLine = useCallback(() => {
    const d = drag
    setDrag(null)
    if (!d) return
    const lines = useLabStore.getState().doc.lines
    const at = lines.findIndex((l) => l.id === d.overId)
    if (at < 0 || d.overId === d.id) return
    stopPlay()
    lab.moveLine(d.id, d.before ? at : at + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, stopPlay])

  const targets = useMemo(() => redoTargets(doc), [doc])
  // 누르기 전에 **무엇을 만들지** 알 수 있게 — 번호와 이유를 짧게.
  const targetSummary = useMemo(() => {
    const head = targets.slice(0, 4).map((t) => `${t.number}번(${t.reason})`).join(', ')
    return targets.length > 4 ? `${head} 외 ${targets.length - 4}개` : head
  }, [targets])
  const need = useMemo(() => linesNeedingWork(doc), [doc])
  const ready = useMemo(() => exportReadiness(doc), [doc])

  const doExport = useCallback(async () => {
    if (!ready.ready) { lab.setNotice(noticeFor(ready)); return }
    const r = await window.api.lab.exportAll(ready.paths, 'lab-script')
    if (r?.ok) lab.setNotice(`내보냈습니다 — ${r.parts}개 문장, ${Math.round((r.bytes || 0) / 1024)}KB`)
    else if (!r?.canceled) lab.setError(r?.reason || '내보내지 못했습니다')
  }, [ready])

  return (
    <div data-testid="lab-workspace" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* 목소리 — 한 줄로 끝낸다. 대본보다 큰 자리를 차지하지 않는다. */}
      <div style={box({ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' })}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>목소리</span>
        <span data-testid="lab-voice-label" style={{
          fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>{doc.voiceLabel || '아직 고르지 않음'}</span>
        <span style={{ fontSize: 11, color: app.ttsRefReady ? 'var(--emerald, #34d399)' : 'var(--text-muted)' }}>
          {doc.voicePath ? (app.ttsRefReady ? '준비됨' : (app.ttsRefMessage || '준비 중…')) : ''}
        </span>
        <button data-testid="lab-pick-voice" onClick={() => { void pickVoice() }}
          disabled={!!job} style={btn('var(--bg-elevated)', 'var(--cyan)', !!job)}>
          {doc.voicePath ? '목소리 바꾸기' : '목소리 고르기'}
        </button>
      </div>

      {/* 목소리 준비는 기존 기능을 그대로 쓴다. 화면에는 내보내지 않는다(설정을 늘어놓지 않는다). */}
      {doc.voicePath && app.fileInfo?.path === doc.voicePath && (
        <div style={{ display: 'none' }}>
          <ReferenceRegionPanel
            key={doc.voicePath + '|' + lab.ref.reqId}
            path={doc.voicePath} clipKey="default"
            // ★생성 중이라고 **잠그지 않는다.** 이 패널의 disabled 는 분석 효과의 의존값이라,
            //   잠갔다 풀면 참조 분석이 처음부터 다시 돈다(실측 27초). 그 동안 준비 상태가
            //   내려가 다음 테이크를 만들 수 없었다. 참조는 생성 중에 바뀌지 않는다.
            disabled={false}
            open={false} autoConfirm plainStatus
            reqId={lab.ref.reqId}
            // 작업실 소유 설정으로 준비한다 — 합성 탭에서 엔진을 바꿔도 여기 반영되지 않는다.
            engine={doc.settings.engine} refTargetSec={doc.settings.refTargetSec}
            committed={lab.ref.clip ? { clip: lab.ref.clip, region: lab.ref.region } : null}
            onState={(s) => useLabStore.getState().setRef(s)}
          />
        </div>
      )}

      {/* 대본 — 화면 가운데, 가장 넓게 */}
      <div style={box({ padding: '8px 8px 10px' })}>
        {doc.lines.map((line, i) => (
          <LineRow
            key={line.id} line={line} index={i} voiceKey={voiceKey}
            selected={selectedLineId === line.id}
            busy={job?.lineId === line.id}
            canGenerate={canGenerate}
            playingTakeId={playingTakeId}
            onSelect={() => lab.selectLine(line.id)}
            onChange={(v) => lab.setLineText(line.id, v)}
            onEnter={() => lab.addLineAfter(line.id)}
            onRemove={() => removeLine(line.id)}
            dragging={drag?.id === line.id}
            dropBefore={!!drag && drag.overId === line.id && drag.before && drag.id !== line.id}
            dropAfterLast={!!drag && drag.overId === line.id && !drag.before && drag.id !== line.id}
            onDragStartLine={() => setDrag({ id: line.id, overId: line.id, before: true })}
            onDragOverLine={(before) => setDrag((d) => (d && (d.overId !== line.id || d.before !== before)
              ? { ...d, overId: line.id, before } : d))}
            onDropLine={dropLine}
            onDragEndLine={() => setDrag(null)}
            onGenerate={() => startJob([line.id])}
            onPlay={togglePlay}
            onAdopt={(tid) => lab.adopt(line.id, tid)}
          />
        ))}
        <button data-testid="lab-add-line" onClick={() => lab.addLineAfter(null)}
          style={{ ...btn('transparent', 'var(--text-muted)'), width: '100%', textAlign: 'left', padding: '8px 10px' }}>
          + 문장 추가
        </button>
      </div>

      {/* 아래 고정 막대 — 전체 조작과 현재 상태 */}
      <div data-testid="lab-bottom-bar" style={box({
        position: 'sticky', bottom: 0, padding: '10px 14px', display: 'flex',
        alignItems: 'center', gap: 8, flexWrap: 'wrap', background: 'var(--bg-elevated)',
      })}>
        <button data-testid="lab-play-all" onClick={togglePlayAll}
          title={"사용 중인 음성을 대본 순서대로 이어서 들려줍니다."}
          disabled={!!job} style={btn('var(--bg-card)', 'var(--text-primary)', !!job)}>
          {playingTakeId === 'all' ? '■ 멈춤' : '▶ 전체 듣기'}
        </button>
        <button data-testid="lab-generate-changed"
          onClick={() => startJob(need.map((l) => l.id))}
          title={"아직 음성이 없거나 대사·목소리를 바꾼 문장의 음성을 만듭니다."}
          disabled={!canGenerate || need.length === 0}
          style={btn('var(--accent)', '#fff', !canGenerate || need.length === 0)}>
          필요한 문장 생성 {need.length > 0 ? `(${need.length}개)` : ''}
        </button>
        <button data-testid="lab-export" onClick={() => { void doExport() }}
          disabled={!!job || !ready.ready} style={btn('var(--bg-card)', 'var(--cyan)', !!job || !ready.ready)}>
          내보내기
        </button>
        {job && (
          <button data-testid="lab-cancel" onClick={() => { void window.api.audio.cancel() }}
            title={"만드는 중인 작업을 멈춥니다. 재생 중지가 아닙니다."}
            style={btn('var(--bg-card)', 'var(--rose, #fb7185)')}>만들기 취소</button>
        )}
        <div data-testid="lab-status" style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto', textAlign: 'right' }}>
          {job
            ? `만드는 중 — ${lab.progress?.message || ''} ${lab.progress?.percent ?? 0}%`
            : busyElsewhere
              ? '합성 탭에서 작업이 도는 중입니다 — 끝나면 여기서 만들 수 있습니다'
              : !doc.voicePath ? '목소리를 먼저 고르세요'
                : !lab.ref.ready
                  ? `목소리 준비 중 — 참조 음성의 말을 분석하고 있습니다${lab.ref.message ? ` (${lab.ref.message})` : ''}`
                  : targets.length > 0
                    ? `음성을 다시 만들어야 하는 문장 — ${targetSummary}`
                    : ready.ready ? `전부 준비됨 — ${ready.paths.length}문장`
                      : `내보낼 수 없는 자리 ${ready.blocking.length}곳`}
        </div>
      </div>

      {(lab.error || lab.notice) && (
        <div data-testid="lab-message" style={box({
          padding: '8px 12px', fontSize: 12,
          color: lab.error ? 'var(--rose, #fb7185)' : 'var(--text-secondary)',
        })}>
          {lab.error || lab.notice}
          {lab.removed && (
            <button data-testid="lab-undo-remove" onClick={() => lab.undoRemove()}
              title={"방금 지운 문장을 되살립니다. 생성본도 함께 돌아옵니다."}
              style={{ ...btn('var(--bg-card)', 'var(--cyan)'), padding: '2px 10px', marginLeft: 10 }}>
              실행 취소
            </button>
          )}
          <button onClick={() => { lab.setError(null); lab.setNotice(null) }}
            style={{ ...btn('transparent', 'var(--text-muted)'), padding: '0 6px', marginLeft: 8 }}>닫기</button>
        </div>
      )}
    </div>
  )
}

/** 준비되지 않은 자리를 **조용히 빼지 않고** 그대로 알린다. */
function noticeFor(r: ReturnType<typeof exportReadiness>): string {
  if (r.paths.length === 0 && r.blocking.length === 0) return '만든 문장이 없습니다.'
  const head = r.blocking.slice(0, 3)
    .map((b) => `${b.index + 1}번째 줄(${lineStatusText(b.status)})`).join(', ')
  const more = r.blocking.length > 3 ? ` 외 ${r.blocking.length - 3}곳` : ''
  return `음성을 다시 만들어야 하는 문장이 있습니다 — ${head}${more}. 그 문장을 만든 뒤에 이어집니다.`
}

interface LineRowProps {
  line: LabLine; index: number; voiceKey: string
  selected: boolean; busy: boolean; canGenerate: boolean; playingTakeId: string | null
  /** 지금 끌고 있는 문장인가 / 이 자리에 놓이는가 — 갈 자리를 눈에 보이게 한다. */
  dragging: boolean; dropBefore: boolean; dropAfterLast: boolean
  onSelect: () => void; onChange: (v: string) => void; onEnter: () => void; onRemove: () => void
  onGenerate: () => void; onPlay: (path: string, takeId: string) => void; onAdopt: (takeId: string) => void
  onDragStartLine: () => void; onDragOverLine: (before: boolean) => void; onDropLine: () => void
  onDragEndLine: () => void
}

function LineRow(p: LineRowProps) {
  const st = lineStatus(p.line, p.voiceKey)
  const adopted = adoptedTake(p.line)
  const unused = !p.busy && hasUnusedTake(p.line, p.voiceKey)
  // 갈 자리 표시 — 이 줄의 위/아래에 얇은 선을 긋는다.
  const mark = '2px solid var(--accent)'
  return (
    <div data-testid="lab-line" data-line-status={st}
      data-drop={p.dropBefore ? 'before' : p.dropAfterLast ? 'after' : ''}
      onFocus={p.onSelect} onClick={p.onSelect}
      // 끌어 놓기는 **손잡이에서만** 시작한다(아래 draggable 토글). 글자 선택과 부딪히지 않는다.
      onDragOver={(e) => {
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        p.onDragOverLine(e.clientY < r.top + r.height / 2)
      }}
      onDrop={(e) => { e.preventDefault(); p.onDropLine() }}
      onDragEnd={p.onDragEndLine}
      style={{
        opacity: p.dragging ? 0.45 : 1,
        borderTop: p.dropBefore ? mark : '2px solid transparent',
        borderBottom: p.dropAfterLast ? mark : '2px solid transparent',
        borderRadius: 10, padding: '6px 8px',
        background: p.selected ? 'var(--bg-elevated)' : 'transparent',
      }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        {/* 순서 바꾸기 손잡이 — 여기서만 끌기가 시작된다. */}
        <span data-testid="lab-line-handle"
          draggable
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; p.onDragStartLine() }}
          onDragEnd={p.onDragEndLine}
          title={"끌어서 문장 순서를 바꿉니다."}
          style={{
            cursor: 'grab', color: 'var(--text-muted)', paddingTop: 6, flexShrink: 0,
            lineHeight: 1, userSelect: 'none',
          }}>
          <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
            <circle cx="2.5" cy="3" r="1.2" /><circle cx="7.5" cy="3" r="1.2" />
            <circle cx="2.5" cy="8" r="1.2" /><circle cx="7.5" cy="8" r="1.2" />
            <circle cx="2.5" cy="13" r="1.2" /><circle cx="7.5" cy="13" r="1.2" />
          </svg>
        </span>
        <span style={{
          fontSize: 11, color: 'var(--text-muted)', width: 20, textAlign: 'right',
          paddingTop: 7, flexShrink: 0, fontVariantNumeric: 'tabular-nums',
        }}>{p.index + 1}</span>
        {/* 한 줄 = 한 발화. 줄마다 입력칸이 따로라 자동 분리로 입력을 바꾸지 않는다. */}
        <textarea
          data-testid="lab-line-input"
          value={p.line.text}
          onChange={(e) => p.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); p.onEnter() }
          }}
          rows={Math.max(1, Math.ceil((p.line.text.length || 1) / 58))}
          placeholder="말할 내용을 쓰세요. Enter 로 다음 문장."
          style={{
            flex: 1, minWidth: 0, resize: 'none', padding: '6px 8px', borderRadius: 8,
            border: '1px solid var(--border-subtle)', background: 'var(--bg-base)',
            color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5,
          }} />
        <span data-testid="lab-line-status" style={{
          fontSize: 10, color: unused ? 'var(--cyan)' : STATUS_COLOR[st],
          paddingTop: 8, flexShrink: 0, minWidth: 84, textAlign: 'right',
        }}>
          {/* ★새로 만들었는데 아직 고르지 않았으면 그 사실을 여기서 말한다 —
                 이전 결과 보존 때문에 자동 선택되지 않았을 뿐, 아무 일도 없던 것이 아니다. */}
          {p.busy ? '만드는 중…' : unused ? '새 생성본 있음' : lineStatusText(st)}
        </span>
        {/* 삭제는 **늘 보인다** — 줄을 고르지 않아도 찾을 수 있어야 한다. */}
        <button data-testid="lab-line-remove" onClick={p.onRemove} disabled={p.busy}
          title={p.busy ? "만드는 중에는 지울 수 없습니다." : "문장 삭제"}
          aria-label="문장 삭제"
          style={{
            ...btn('transparent', p.busy ? 'var(--text-muted)' : 'var(--text-secondary)', p.busy),
            padding: '2px 6px', marginTop: 4, flexShrink: 0, fontSize: 14, lineHeight: 1,
          }}>×</button>
      </div>

      {/* 고른 줄 바로 아래에 조작을 둔다 — 상세 화면 안에 숨기지 않는다. */}
      {p.selected && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 0 2px 30px' }}>
          <button data-testid="lab-line-generate" onClick={p.onGenerate}
            title={p.line.takes.length
              ? "이전 음성은 보관하고 새 음성을 추가합니다."
              : "이 문장의 음성을 만듭니다."}
            disabled={!p.canGenerate || !p.line.text.trim()}
            style={btn('var(--accent)', '#fff', !p.canGenerate || !p.line.text.trim())}>
            {p.line.takes.length ? '추가 생성' : '만들기'}
          </button>
          {adopted && (
            <button data-testid="lab-line-play" onClick={() => p.onPlay(adopted.path, adopted.id)}
              style={btn('var(--bg-card)', 'var(--text-primary)')}>
              {p.playingTakeId === adopted.id ? '■ 멈춤' : '▶ 듣기'}
            </button>
          )}

          {p.line.takes.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', width: '100%', paddingTop: 4 }}>
              <span style={{ fontSize: 10, color: unused ? 'var(--cyan)' : 'var(--text-muted)', width: '100%' }}>
                {unused
                  ? '새 생성본이 있습니다. 사용할 음성을 선택하세요.'
                  : '들어보고 사용할 음성을 고르세요.'}
              </span>
              {p.line.takes.map((t, i) => {
                const badge = takeBadge(t, p.line, p.voiceKey)
                const isAdopted = p.line.adoptedTakeId === t.id
                return (
                  <div key={t.id} data-testid="lab-take"
                    data-adopted={isAdopted ? '1' : '0'} data-badge={badge}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', borderRadius: 8,
                      border: `1px solid ${isAdopted ? 'var(--border-accent)' : 'var(--border-subtle)'}`,
                      background: isAdopted ? 'var(--accent-glow)' : 'transparent',
                    }}>
                    <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>생성본 {i + 1}</span>
                    {badge && <span style={{ fontSize: 10, color: 'var(--amber, #fbbf24)' }}>{badge}</span>}
                    <button onClick={() => p.onPlay(t.path, t.id)}
                      style={{ ...btn('transparent', 'var(--text-primary)'), padding: '0 4px' }}>
                      {p.playingTakeId === t.id ? '■' : '▶'}
                    </button>
                    <button data-testid="lab-take-adopt" onClick={() => p.onAdopt(t.id)}
                      title={"전체 듣기와 내보내기에 이 음성을 사용합니다."}
                      disabled={isAdopted}
                      style={{ ...btn('transparent', isAdopted ? 'var(--text-muted)' : 'var(--cyan)', isAdopted), padding: '0 4px' }}>
                      {isAdopted ? '사용 중' : '이 음성 사용'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
