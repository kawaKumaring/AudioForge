/**
 * 음높이 맞추기 — **보면서 손잡이로 맞춘다.**
 *
 * ★왜 이 화면이 생겼나 (2026-09-26)
 *   따라부르기 결과에 기계음이 나는데 무엇이 잘못됐는지 **숫자로 가려내지 못했다.**
 *   품질 지표를 여섯 번 골랐고 여섯 번 다 빗나갔다 — 마지막에는 자연스러운 원본과
 *   찢어지는 결과물에 **완전히 같은 값**이 나왔다.
 *   그런데 그림으로 그리니 한눈에 달랐다. 원본의 음높이는 덩어리로 이어지고
 *   결과는 같은 자리에서 점이 흩어진다.
 *
 *   **지표를 고르는 일 자체가 추측이었다. 그림은 고를 필요가 없다.**
 *
 * ★어떻게 맞추나 (사용자 설계)
 *   점을 하나하나 찍는 편집이 아니다. 손잡이 셋으로 **곡선 전체의 모양**을 잡아
 *   원본에 겹쳐 간다 — 게임의 그래프 맞추기와 같다.
 *   손잡이가 적어야 감으로 맞출 수 있다.
 *
 * ★손잡이는 즉시 보이고, 소리는 눌러야 만든다
 *   빚는 계산은 화면에서 바로 한다(`shared/pitchShape`). 그래서 끌면 곧바로 보인다.
 *   소리를 다시 만드는 일은 공짜가 아니므로 단추를 눌렀을 때만 한다.
 *   두 계산이 갈라지면 **보이는 것과 먹는 것이 달라지므로**, 본보기 40개로 묶어 두었다
 *   (`shared/pitchShape.crosscheck.test.ts`).
 */
import { useCallback, useMemo, useState, type ReactElement } from 'react'
import {
  applyKnobs, similarity, toSemitones, NEUTRAL, type Curve, type Knobs,
} from '../../shared/pitchShape'

interface Reply<T> { ok: boolean; data?: T; error?: string }
interface CurveData { times: number[]; hz: number[]; frames: number; shown: number }

const W = 900
const H = 260
const PAD = 28

/** 반음 곡선을 화면 점으로. 소리 없는 자리는 **끊어서** 그린다 — 이어 그리면 없는 소리가 생긴다. */
function toPolylines(curve: Curve, lo: number, hi: number): string[] {
  const out: string[] = []
  let cur: string[] = []
  const span = Math.max(1e-6, hi - lo)
  curve.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 1) out.push(cur.join(' '))
      cur = []
      return
    }
    const x = PAD + (i / Math.max(1, curve.length - 1)) * (W - PAD * 2)
    const y = H - PAD - ((v - lo) / span) * (H - PAD * 2)
    cur.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (cur.length > 1) out.push(cur.join(' '))
  return out
}

function Slider(props: {
  label: string; hint: string; value: number
  min: number; max: number; step: number
  onChange: (v: number) => void
}): ReactElement {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
      <span style={{ width: 62, color: 'var(--text)' }}>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step}
        value={props.value} style={{ flex: 1 }}
        onChange={(e) => props.onChange(Number(e.target.value))} />
      <span style={{ width: 46, textAlign: 'right', color: 'var(--text-muted)' }}>
        {props.value.toFixed(2)}
      </span>
      <span style={{ width: 200, fontSize: 11, color: 'var(--text-muted)' }}>{props.hint}</span>
    </label>
  )
}

export default function PitchStudio(): ReactElement {
  /** 맞춰 갈 목표 — 원본 보컬. **이것의 자연스러움이 기준이다.** */
  const [targetPath, setTargetPath] = useState('')
  /** 손볼 소리 — 변환에 넣을 것. */
  const [sourcePath, setSourcePath] = useState('')
  const [target, setTarget] = useState<CurveData | null>(null)
  const [source, setSource] = useState<CurveData | null>(null)
  const [knobs, setKnobs] = useState<Knobs>({ ...NEUTRAL })
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const api = (window as unknown as { api: { pitch: {
    curve: (a: string, s?: number) => Promise<Reply<CurveData>>
    reshape: (a: string, d: string, k: Partial<Knobs>, s?: number) => Promise<Reply<unknown>>
    fit: (t: string, a: string, s?: number) => Promise<Reply<{ knobs: Knobs; score: number }>>
  } } }).api.pitch
  const pick = (window as unknown as { api: { audio: {
    selectFile: (multi: boolean, kind: string) => Promise<string | string[] | null>
  } } }).api.audio

  /** 만든 소리는 손볼 소리 옆에 둔다 — 자료 폴더를 어지럽히지 않는다. */
  const destPath = sourcePath ? sourcePath.replace(/(\.[^.]+)$/, '_손본것.wav') : ''

  const choose = useCallback(async (which: 'target' | 'source') => {
    const got = await pick.selectFile(false, 'voice')
    const one = Array.isArray(got) ? got[0] : got
    if (!one || typeof one !== 'string') return
    if (which === 'target') setTargetPath(one)
    else setSourcePath(one)
  }, [pick])

  const load = useCallback(async () => {
    setError(''); setBusy('곡선을 읽는 중…')
    try {
      const [t, s] = await Promise.all([api.curve(targetPath), api.curve(sourcePath)])
      if (!t?.ok || !t.data) throw new Error(t?.error || '원본 곡선을 읽지 못했습니다')
      if (!s?.ok || !s.data) throw new Error(s?.error || '손볼 곡선을 읽지 못했습니다')
      setTarget(t.data); setSource(s.data)
      setNote(`원본 ${t.data.frames}칸 · 손볼 것 ${s.data.frames}칸 (화면에는 솎아서 그린다)`)
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }, [api, targetPath, sourcePath])

  // ★끌면 곧바로 보인다 — 파이썬을 부르지 않는다.
  const shaped = useMemo(() => {
    if (!source) return null
    return applyKnobs(toSemitones(source.hz), knobs)
  }, [source, knobs])

  const targetSemi = useMemo(() => (target ? toSemitones(target.hz) : null), [target])
  const score = useMemo(
    () => (targetSemi && shaped ? similarity(targetSemi, shaped) : 0), [targetSemi, shaped])

  const range = useMemo(() => {
    const all = [...(targetSemi ?? []), ...(shaped ?? [])].filter((v): v is number => v !== null)
    if (!all.length) return { lo: 0, hi: 1 }
    const lo = Math.min(...all), hi = Math.max(...all)
    const pad = Math.max(1, (hi - lo) * 0.1)
    return { lo: lo - pad, hi: hi + pad }
  }, [targetSemi, shaped])

  const autoFit = useCallback(async () => {
    setError(''); setBusy('프로그램이 맞추는 중…')
    try {
      const r = await api.fit(targetPath, sourcePath)
      if (!r?.ok || !r.data) throw new Error(r?.error || '맞추지 못했습니다')
      setKnobs({ ...NEUTRAL, ...r.data.knobs })
      setNote(`자동으로 맞췄습니다 — 여기서 손으로 더 돌릴 수 있습니다.`)
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }, [api, targetPath, sourcePath])

  const make = useCallback(async () => {
    setError(''); setBusy('소리를 만드는 중…')
    try {
      const r = await api.reshape(sourcePath, destPath, knobs)
      if (!r?.ok) throw new Error(r?.error || '소리를 만들지 못했습니다')
      setNote('손본 소리를 만들었습니다 — 들어 보고 이어서 변환하세요.')
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }, [api, knobs, sourcePath, destPath])

  const lines = shaped ? toPolylines(shaped, range.lo, range.hi) : []
  const tlines = targetSemi ? toPolylines(targetSemi, range.lo, range.hi) : []
  const touched = knobs.smooth !== 0 || knobs.spread !== 1 || knobs.shift !== 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => void choose('target')} disabled={!!busy}>원본 고르기</button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 200,
                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {targetPath ? targetPath.split(/[\\/]/).pop() : '아직 안 골랐습니다'}
        </span>
        <button onClick={() => void choose('source')} disabled={!!busy}>손볼 것 고르기</button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 200,
                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {sourcePath ? sourcePath.split(/[\\/]/).pop() : '아직 안 골랐습니다'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={() => void load()} disabled={!!busy || !targetPath || !sourcePath}>
          곡선 읽기
        </button>
        <button onClick={() => void autoFit()} disabled={!!busy || !source}>자동으로 맞추기</button>
        <button onClick={() => setKnobs({ ...NEUTRAL })} disabled={!!busy || !touched}>
          손잡이 되돌리기
        </button>
        <button onClick={() => void make()} disabled={!!busy || !source}>이 설정으로 소리 만들기</button>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{busy || note}</span>
      </div>
      {error && <div style={{ fontSize: 12, color: 'var(--rose, #f43f5e)' }}>{error}</div>}

      <svg width={W} height={H} style={{
        background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 8,
        maxWidth: '100%',
      }}>
        {tlines.map((p, i) => (
          <polyline key={`t${i}`} points={p} fill="none" stroke="var(--emerald, #34d399)"
            strokeWidth={2} opacity={0.9} />
        ))}
        {lines.map((p, i) => (
          <polyline key={`c${i}`} points={p} fill="none" stroke="var(--cyan, #22d3ee)"
            strokeWidth={1.6} opacity={0.95} />
        ))}
        {!source && (
          <text x={W / 2} y={H / 2} textAnchor="middle" fontSize={13} fill="var(--text-muted)">
            곡선 읽기를 누르세요
          </text>
        )}
      </svg>

      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--emerald, #34d399)' }}>■ 원본(맞출 목표)</span>
        <span style={{ color: 'var(--cyan, #22d3ee)' }}>■ 지금 손본 것</span>
        <span>겹침 {(score * 100).toFixed(0)}% — 높을수록 원본에 가깝다</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Slider label="편다" hint="들쑥날쑥한 자리를 고르게. 찢어지는 음에 먼저 써 본다."
          min={0} max={1} step={0.05} value={knobs.smooth}
          onChange={(v) => setKnobs((k) => ({ ...k, smooth: v }))} />
        <Slider label="폭" hint="오르내림의 크기. 1 이 그대로, 크면 표정이 세진다."
          min={0} max={3} step={0.05} value={knobs.spread}
          onChange={(v) => setKnobs((k) => ({ ...k, spread: v }))} />
        <Slider label="옮김" hint="통째로 올리거나 내린다(반음). 12 면 한 옥타브."
          min={-12} max={12} step={0.5} value={knobs.shift}
          onChange={(v) => setKnobs((k) => ({ ...k, shift: v }))} />
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        손잡이는 **곧바로 보이고**, 소리는 단추를 눌렀을 때만 만든다 — 소리를 다시 만드는 일은
        공짜가 아니기 때문이다. 앞 {20}초만 본다: 사람은 구간으로 맞추고, 맞으면 전곡을 낸다.
      </div>
    </div>
  )
}
