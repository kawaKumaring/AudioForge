/**
 * 영상 더빙 작업실.
 *
 * ★만드는 동안 '테스트개발' 의 **이름표와 아이콘만** 빌린다(규칙: doc/dev-rules.md 8장 ·
 *   LabPlaceholder.tsx 머리말). 내부 이름은 처음부터 최종 것이다 — 모드 열쇠 `dub`,
 *   목소리 자리 `dub`, 작업 폴더 `userData/dub/`. 완성되면 ModeSelector 의 이름표만 바꾼다.
 *
 * 이 화면은 **판단하지 않는다.**
 *   · 자리 계산(쉼 먹기·늘이기·표시)   → python/dub_timing.py
 *   · 순서와 이어 하기                 → python/dub_pipeline.py
 *   · 상태 글자와 색                   → shared/dubbing.ts
 *   · 목소리 준비                      → lib/voicePrepRunner (자리 `dub`)
 * 여기 있는 것은 **부르는 순서와 보여 주는 방법**뿐이다.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import {
  DUB_STAGE_LABELS, dubFrontSummary, dubNextAction, dubStatusColor, dubStatusLabel, dubTimeLabel,
  type DubFrontResult, type DubLine, type DubLineResult, type DubLineState, type DubRenderResult,
} from '../../shared/dubbing'
// 말끝 잘림 판정은 **고급 화면과 같은 기준**을 쓴다 — 기준이 둘이면 화면끼리 말이 달라진다.
import { synthesisOptions, defaultSettings, isTailCut, tailResidualOf } from '../../shared/labWorkspace'
import { REFERENCE_CONDITIONING_RECOMMENDED } from '../../shared/ttsConfig'
import type { CommittedRef } from '../../shared/voicePreparation'
import { runVoicePrep } from '@/lib/voicePrepRunner'

/** 더빙이 쓰는 파생 클립 자리. 일반·고급의 목소리를 건드리지 않는다. */
const DUB_CLIP_KEY = 'dub'

type Busy = '' | 'front' | 'voice' | 'synth' | 'render'

interface Reply<T> { ok: boolean; data?: T; error?: string }

export default function DubWorkspace() {
  const [videoPath, setVideoPath] = useState('')
  const [front, setFront] = useState<DubFrontResult | null>(null)
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [takes, setTakes] = useState<Record<number, string>>({})
  // ★말끝이 잘렸을 수 있는 줄(2026-09-24 감사).
  //   값은 **이미 도착해 있었는데** 수신 타입이 metadata 를 버려서 쓰이지 못했다.
  //   고급 화면은 꼬리표를 보여 주는데 더빙은 잘린 채로 영상에 실렸다.
  const [tailCut, setTailCut] = useState<Record<number, boolean>>({})
  const [report, setReport] = useState<DubRenderResult | null>(null)
  const [busy, setBusy] = useState<Busy>('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [voice, setVoice] = useState<{ path: string; ref: CommittedRef | null; message: string }>(
    { path: '', ref: null, message: '' },
  )
  // 번역 말투. 더빙은 한 사람이 이어서 말하므로 줄마다 말투가 바뀌면 다른 사람처럼 들린다.
  const [register, setRegister] = useState<'' | 'casual' | 'polite'>('casual')
  // 합성 결과를 기다리는 줄. 파이썬 통로가 하나라 한 줄씩 줄을 세운다.
  // 돌려받는 것에 **말끝 잔여량**을 함께 싣는다 — 값은 같은 알림에 이미 들어 있다.
  const pending = useRef<{ index: number; resolve: (r: { path: string; residual?: number }) => void; reject: (e: Error) => void } | null>(null)
  const committed = useRef<CommittedRef | null>(null)

  useEffect(() => { committed.current = voice.ref }, [voice.ref])

  // 앞단·내보내기의 진행을 그대로 받아 적는다.
  useEffect(() => {
    const off = window.api.dub.onProgress((raw: unknown) => {
      const d = raw as { tag?: string; data?: { percent?: number; message?: string } }
      const msg = d?.data?.message
      if (msg) setNote(`${d.tag ?? ''} · ${msg}`.trim())
    })
    return () => { off() }
  }, [])

  // 줄 소리 합성 결과를 받는다. 지금 기다리는 줄이 없으면 무시한다 —
  // 다른 화면이 만든 소리를 더빙의 줄로 잘못 채우지 않는다.
  useEffect(() => {
    const offR = window.api.audio.onResult((raw: unknown) => {
      const slot = pending.current
      if (!slot) return
      const d = raw as { tracks?: Array<{ path?: string }> }
      const src = d?.tracks?.[0]?.path
      // ★metadata 를 버리지 않는다 — 꺼내는 자리는 shared 의 순수 함수가 소유한다.
      const residual = tailResidualOf(raw)
      pending.current = null
      if (src) {
        slot.resolve({ path: src, residual })
      }
      else slot.reject(new Error('만든 소리가 돌아오지 않았습니다'))
    })
    const offE = window.api.audio.onError((raw: unknown) => {
      const slot = pending.current
      if (!slot) return
      pending.current = null
      slot.reject(new Error(String((raw as { message?: string })?.message ?? raw)))
    })
    return () => { offR?.(); offE?.() }
  }, [])

  const lines: DubLine[] = front?.lines ?? []
  const koreanOf = (l: DubLine) => (edits[l.index] ?? l.korean)
  const resultOf = (i: number): DubLineResult | undefined => report?.lines.find((r) => r.index === i)
  const stateOf = (l: DubLine): DubLineState => resultOf(l.index)?.status ?? 'pending'

  const emptyCount = lines.filter((l) => !koreanOf(l).trim()).length
  const missingCount = lines.filter((l) => !takes[l.index]).length
  const overCount = report?.summary.over ?? 0

  async function call<T>(p: Promise<Reply<T>>, what: string): Promise<T | null> {
    const r = await p
    if (!r?.ok) { setError(r?.error || `${what}에 실패했습니다`); return null }
    return (r.data ?? null) as T | null
  }

  const pickVideo = useCallback(async () => {
    setError('')
    const path = await call(window.api.dub.pickVideo() as Promise<Reply<string | null>>, '영상 고르기')
    if (!path) return
    setVideoPath(path)
    // 화면 상태만 비운다 — 고친 번역문은 작업 폴더에 쌓여 있어 잃지 않는다.
    setFront(null); setEdits({}); setTakes({}); setReport(null)
    // 지난번 작업이 남아 있으면 그대로 이어 간다.
    const prev = await (window.api.dub.load() as Promise<Reply<DubFrontResult>>)
    if (prev?.ok && prev.data && prev.data.lines.length > 0) {
      setFront(prev.data)
      setNote('지난 작업을 이어서 엽니다.')
    }
  }, [])

  const runFront = useCallback(async (force = false) => {
    setError(''); setBusy('front'); setNote('시작합니다...')
    const got = await call(
      window.api.dub.runFront({ force, register }) as Promise<Reply<DubFrontResult>>, '앞단')
    setBusy('')
    if (got) {
      // 앞단이 줄 목록을 새로 썼어도 본체가 손본 번역문을 되씌운다 — got 에 이미 들어 있다.
      setFront(got); setEdits({}); setReport(null)
      // ★할 일이 없었다는 것도 결과다. 아무 말도 안 하면 멈춘 것처럼 보인다(2026-09-20 신고).
      setNote(dubFrontSummary(got.ran ?? [], got.skipped ?? []))
    }
  }, [register])

  /** 목소리 하나를 준비시킨다. 파일을 고르든 영상 속 목소리를 쓰든 여기로 모인다. */
  const prepareVoice = useCallback(async (path: string) => {
    setBusy('voice')
    setVoice({ path, ref: null, message: '목소리를 살펴보는 중...' })
    const outcome = await runVoicePrep({
      clipKey: DUB_CLIP_KEY,
      path,
      reqId: `dub-${Date.now()}`,
      engine: 'auto',
      refTargetSec: 0,
      plain: false,
      committedNow: () => committed.current,
      report: (patch) => {
        setVoice((v) => ({
          path,
          ref: patch.ready ? { clip: patch.clip ?? '', region: patch.region ?? null } : v.ref,
          message: patch.message ?? v.message,
        }))
      },
    })
    setBusy('')
    if (outcome === 'failed') setError('이 목소리 파일로는 준비하지 못했습니다. 다른 파일을 골라 주세요.')
    if (outcome === 'needs_region') {
      setError('이 목소리는 쓸 구간을 직접 골라야 합니다. 합성(고급) 작업실에서 구간을 정한 뒤 다시 오세요.')
    }
  }, [])

  const pickVoice = useCallback(async () => {
    setError('')
    const picked = await window.api.audio.selectFile(false)
    const path = Array.isArray(picked) ? picked[0] : picked
    if (!path || typeof path !== 'string') return
    await prepareVoice(path)
  }, [prepareVoice])

  /**
   * 영상 속 목소리를 그대로 쓴다 - 인물은 그대로 두고 **언어만** 바꾸는 길이다.
   * 갈라낸 보컬이 이미 있으므로 새로 고를 파일이 없다.
   */
  const useOriginalVoice = useCallback(async () => {
    setError('')
    const p = await call(window.api.dub.originalVoice() as Promise<Reply<string>>, '영상 속 목소리')
    if (!p) return
    await prepareVoice(p)
  }, [prepareVoice])

  // ★고치는 즉시 제 집에 쌓는다 — 저장 단추를 기다리지 않는다(2026-09-24 2차 감사).
  //   예전에는 편집이 화면 안에만 있어서, 앱을 닫거나 영상을 바꾸면 수십 줄이
  //   한 번에 사라졌다. 그리고 그 자리(영상 고르기·앞단 다시 돌리기)에는
  //   **아무 경고도 없었다.** 이제 쌓아 두므로 화면 상태를 비워도 잃지 않는다.
  //   실패를 버리지 않는다 — 쌓지 못했으면 그 사실을 말한다.
  const editsRef = useRef(edits)
  editsRef.current = edits
  useEffect(() => {
    if (!front || Object.keys(edits).length === 0) return
    const t = setTimeout(() => {
      void (async () => {
        try {
          const r = await (window.api.dub.saveEdits(editsRef.current) as Promise<Reply<number>>)
          if (!r?.ok) setNote('고친 번역문을 임시로 보관하지 못했습니다 — 저장 단추를 눌러 주세요.')
        } catch {
          setNote('고친 번역문을 임시로 보관하지 못했습니다 — 저장 단추를 눌러 주세요.')
        }
      })()
    }, 500)
    return () => clearTimeout(t)
  }, [edits, front])

  const saveKorean = useCallback(async () => {
    if (Object.keys(edits).length === 0) return
    setError('')
    const got = await call(
      window.api.dub.saveKorean(edits) as Promise<Reply<DubFrontResult>>, '번역문 저장')
    if (got) { setFront(got); setEdits({}); setNote('번역문을 저장했습니다.') }
  }, [edits])

  /** 줄 하나를 만든다. 결과가 올 때까지 기다린다 — 통로가 하나이므로 겹쳐 부르지 않는다. */
  const synthOne = useCallback(async (line: DubLine, ref: CommittedRef): Promise<void> => {
    const text = koreanOf(line).trim()
    if (!text) return
    const made = await new Promise<{ path: string; residual?: number }>((resolve, reject) => {
      pending.current = { index: line.index, resolve, reject }
      const opts = synthesisOptions(text, defaultSettings(REFERENCE_CONDITIONING_RECOMMENDED),
        { clip: ref.clip, region: ref.region })
      // ★시작 요청의 **거절을 버리지 않는다**(2026-09-24 2차 감사).
      //   main 은 여덟 갈래로 거절할 수 있고 그 경로에는 어떤 알림도 따라오지 않는다.
      //   버리면 "줄 소리 만드는 중… 1/N" 에서 **이유 없이 멈춘다** — 더빙에는 취소 단추도 없다.
      void window.api.audio.process(voice.path, 'tts', opts as Record<string, unknown>)
        .catch((e: unknown) => {
          pending.current = null
          reject(new Error(`줄 소리 만들기를 시작하지 못했습니다: ${(e as Error)?.message || e}`))
        })
    })
    const kept = await (window.api.dub.keepTake(made.path, line.index) as Promise<Reply<string>>)
    if (!kept?.ok || !kept.data) throw new Error(kept?.error || '만든 소리를 보관하지 못했습니다')
    setTakes((t) => ({ ...t, [line.index]: kept.data as string }))
    // ★말끝이 잘렸는가 — 판정은 고급 화면과 **같은 기준**을 쓴다(labWorkspace.TAIL_RESIDUAL_CUT).
    setTailCut((m) => ({ ...m, [line.index]: isTailCut(made.residual) }))
  }, [edits, front, voice.path])

  const synthAll = useCallback(async (onlyMissing: boolean) => {
    const ref = voice.ref
    if (!ref) { setError('먼저 목소리를 고르세요.'); return }
    const todo = lines.filter((l) => koreanOf(l).trim() && (!onlyMissing || !takes[l.index]))
    if (todo.length === 0) { setNote('만들 줄이 없습니다.'); return }
    setError(''); setBusy('synth')
    try {
      for (let i = 0; i < todo.length; i++) {
        setNote(`줄 소리 만드는 중... ${i + 1}/${todo.length}`)
        await synthOne(todo[i], ref)
      }
      setNote(`${todo.length}줄을 만들었습니다.`)
    } catch (e) {
      setError(`줄 소리를 만들다 멈췄습니다: ${(e as Error).message}`)
    } finally {
      pending.current = null
      setBusy('')
    }
  }, [lines, takes, voice.ref, synthOne])

  const exportVideo = useCallback(async () => {
    setError(''); setBusy('render'); setNote('영상을 만드는 중...')
    const got = await call(
      window.api.dub.render(takes) as Promise<Reply<DubRenderResult>>, '영상 만들기')
    setBusy('')
    if (got) {
      setReport(got)
      const s = got.summary
      setNote(`영상을 만들었습니다 — 맞음 ${s.fit} · 늘여서 ${s.stretched} · 안 맞음 ${s.over}`)
    } else {
      setNote('')
    }
  }, [takes])

  const disabled = busy !== ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14 }}>
      <Header videoPath={videoPath} voice={voice} disabled={disabled}
        canUseOriginal={!!front}
        onPickVideo={pickVideo} onPickVoice={pickVoice} onUseOriginal={useOriginalVoice} />

      {videoPath && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Btn onClick={() => void runFront(false)} disabled={disabled} primary>
            {front ? '이어서 하기' : '시작'}
          </Btn>
          {front && (
            <Btn onClick={() => void runFront(true)} disabled={disabled}>처음부터 다시</Btn>
          )}
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 5, alignItems: 'center' }}>
            말투
            <select value={register} disabled={disabled}
              onChange={(e) => setRegister(e.target.value as '' | 'casual' | 'polite')}
              style={{
                fontFamily: 'inherit', fontSize: 11, padding: '4px 6px', borderRadius: 6,
                background: 'var(--bg-input, #1b1d23)', color: 'var(--text)',
                border: '1px solid var(--border-subtle)',
              }}>
              <option value="casual">반말로 통일</option>
              <option value="polite">존댓말로 통일</option>
              <option value="">통일만 (한쪽을 정하지 않음)</option>
            </select>
          </label>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {DUB_STAGES_HINT}
          </span>
        </div>
      )}

      {(note || error) && (
        <div style={{
          fontSize: 12, padding: '8px 10px', borderRadius: 8,
          background: error ? 'var(--rose-soft, #40202a)' : 'var(--bg-card)',
          color: error ? 'var(--rose)' : 'var(--text-muted)',
          border: '1px solid var(--border-subtle)', whiteSpace: 'pre-wrap',
        }}>{error || note}</div>
      )}

      {front && (
        <>
          <div style={{
            display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
            fontSize: 12, color: 'var(--text-muted)',
          }}>
            <strong style={{ color: 'var(--text)' }}>
              {dubNextAction({ lines: lines.length, empty: emptyCount, missing: missingCount, over: overCount })}
            </strong>
            <span>· 원어 {front.language} · {lines.length}줄</span>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn onClick={() => void saveKorean()} disabled={disabled || Object.keys(edits).length === 0}>
              번역문 저장 ({Object.keys(edits).length})
            </Btn>
            <Btn onClick={() => void synthAll(true)} disabled={disabled || !voice.ref}>
              안 만든 줄 만들기 ({missingCount})
            </Btn>
            <Btn onClick={() => void synthAll(false)} disabled={disabled || !voice.ref}>
              전부 다시 만들기
            </Btn>
            <Btn onClick={() => void exportVideo()} disabled={disabled || missingCount === lines.length} primary>
              영상 만들기
            </Btn>
          </div>

          <LineTable lines={lines} koreanOf={koreanOf} stateOf={stateOf} resultOf={resultOf}
            takes={takes} tailCut={tailCut} disabled={disabled}
            onEdit={(i, v) => setEdits((e) => ({ ...e, [i]: v }))} />
        </>
      )}

      {report && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
          <div>영상: {report.video}</div>
          <div>한국어 자막: {report.srt}</div>
          {report.summary.missingIndexes.length > 0 && (
            <div style={{ color: 'var(--amber)' }}>
              소리가 없어 빠진 줄 {report.summary.missingIndexes.length}개 — 그 줄은 원본 그대로 비어 있습니다.
            </div>
          )}
          {report.summary.trimmed > 0 && (
            <div style={{ color: 'var(--amber)' }}>
              영상 끝을 넘어 잘린 줄 {report.summary.trimmed}개.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const DUB_STAGES_HINT = Object.values(DUB_STAGE_LABELS).join(' → ')

function Header(props: {
  videoPath: string
  voice: { path: string; ref: CommittedRef | null; message: string }
  disabled: boolean
  canUseOriginal: boolean
  onPickVideo: () => void
  onPickVoice: () => void
  onUseOriginal: () => void
}): ReactElement {
  const name = props.videoPath.replace(/\\/g, '/').split('/').pop() || ''
  const voiceName = props.voice.path.replace(/\\/g, '/').split('/').pop() || ''
  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
      <Btn onClick={props.onPickVideo} disabled={props.disabled}>영상 고르기</Btn>
      <span style={{ fontSize: 12, color: name ? 'var(--text)' : 'var(--text-muted)' }}>
        {name || '아직 고르지 않았습니다'}
      </span>
      <span style={{ width: 1, height: 18, background: 'var(--border-subtle)' }} />
      <Btn onClick={props.onPickVoice} disabled={props.disabled}>목소리 고르기</Btn>
      <Btn onClick={props.onUseOriginal} disabled={props.disabled || !props.canUseOriginal}>
        영상 속 목소리 쓰기
      </Btn>
      <span style={{
        fontSize: 12,
        color: props.voice.ref ? 'var(--emerald)' : 'var(--text-muted)',
      }}>
        {props.voice.ref ? `${voiceName} · 준비됨` : (props.voice.message || '아직 고르지 않았습니다')}
      </span>
    </div>
  )
}

function LineTable(props: {
  lines: DubLine[]
  koreanOf: (l: DubLine) => string
  stateOf: (l: DubLine) => DubLineState
  resultOf: (i: number) => DubLineResult | undefined
  takes: Record<number, string>
  /** 말끝이 잘렸을 수 있는 줄. 값이 없으면 재지 못한 것이다. */
  tailCut: Record<number, boolean>
  disabled: boolean
  onEdit: (index: number, value: string) => void
}): ReactElement {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6,
      maxHeight: 420, overflowY: 'auto', paddingRight: 4,
    }}>
      {props.lines.map((l) => {
        const state = props.stateOf(l)
        const r = props.resultOf(l.index)
        const color = dubStatusColor(state)
        return (
          <div key={l.index} style={{
            display: 'grid', gridTemplateColumns: '64px 1fr 1fr 150px', gap: 8,
            alignItems: 'start', padding: '7px 8px', borderRadius: 8,
            background: 'var(--bg-card)', border: '1px solid var(--border-subtle)',
          }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', paddingTop: 5 }}>
              {dubTimeLabel(l.start)}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', paddingTop: 4, wordBreak: 'break-word' }}>
              {l.source}
            </span>
            <textarea
              value={props.koreanOf(l)}
              onChange={(e) => props.onEdit(l.index, e.target.value)}
              disabled={props.disabled}
              rows={Math.max(1, Math.ceil(props.koreanOf(l).length / 26))}
              style={{
                width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 12,
                padding: '4px 6px', borderRadius: 6, background: 'var(--bg-input, #1b1d23)',
                color: 'var(--text)', border: '1px solid var(--border-subtle)',
              }}
            />
            <span style={{ fontSize: 11, color, paddingTop: 5, lineHeight: 1.5 }}>
              {dubStatusLabel(state, { ratio: r?.ratio, overflowSec: r?.overflowSec })}
              {props.takes[l.index] ? '' : ' · 소리 없음'}
              {props.tailCut[l.index]
                ? <span style={{ color: 'var(--amber, #d98b2b)' }}> · ★말끝이 잘렸을 수 있습니다</span>
                : null}
              {r?.loudnessNote ? <><br /><span style={{ color: 'var(--text-muted)' }}>{r.loudnessNote}</span></> : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function Btn(props: {
  onClick: () => void; disabled?: boolean; primary?: boolean; children: ReactNode
}): ReactElement {
  return (
    <button onClick={props.onClick} disabled={props.disabled} style={{
      padding: '7px 13px', borderRadius: 8, fontFamily: 'inherit', fontSize: 12,
      fontWeight: props.primary ? 600 : 500, cursor: props.disabled ? 'not-allowed' : 'pointer',
      background: props.primary ? 'var(--cyan)' : 'var(--bg-card)',
      color: props.primary ? '#0b0d10' : 'var(--text)',
      border: '1px solid var(--border-subtle)', opacity: props.disabled ? 0.5 : 1,
    }}>{props.children}</button>
  )
}
