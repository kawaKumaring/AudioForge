/**
 * 음높이 맞추기 — **보면서 손잡이로 맞춘다.**
 *
 * ★왜 이 화면이 생겼나 (2026-09-26)
 *   따라부르기 결과에 기계음이 나는데 무엇이 잘못됐는지 숫자로 가려내지 못했다.
 *   품질 지표를 여섯 번 골랐고 여섯 번 다 빗나갔다 — 마지막에는 자연스러운 원본과
 *   찢어지는 결과물에 완전히 같은 값이 나왔다. 그림으로 그리니 한눈에 달랐다.
 *
 * ★처음 붙였을 때 형태를 망쳤다 — 그때 어긴 것들
 *   1. 화면 맨 위, 「시작」보다 앞에 끼워 넣어 **더빙 흐름을 끊었다.**
 *   2. 이 화면이 쓰는 단추(`Btn`)를 두고 **날것 button 을 여섯 개** 넣었다.
 *   3. 아무 데도 안 쓰는 접힘(`details`) 삼각형을 들여왔다.
 *   4. 강조 표시를 그대로 적어 **별표가 글자로 나왔다.**
 *   5. 바로 위에 고른 목소리가 보이는데 **또 고르라고 했다.**
 *   6. 읽기 전에도 **거대한 빈 상자**가 화면을 차지했다.
 *   화면에 무언가를 더할 때는 **그 화면의 규칙을 먼저 본다.**
 *
 * ★손잡이는 즉시 보이고, 소리는 눌러야 만든다
 *   빚는 계산은 화면에서 바로 한다(`shared/pitchShape`). 끌면 곧바로 보인다.
 *   두 구현이 갈라지면 보이는 것과 먹는 것이 달라지므로 본보기 40개로 묶어 두었다.
 */
import { useCallback, useMemo, useState, type ReactElement } from 'react'
import {
  applyKnobs, similarity, toSemitones, NEUTRAL, type Curve, type Knobs,
} from '../../shared/pitchShape'
import { Btn } from './DubWorkspace'

interface Reply<T> { ok: boolean; data?: T; error?: string }
interface CurveData { times: number[]; hz: number[]; frames: number; shown: number }

const H = 150
const PAD = 10

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() || ''

/** 소리 없는 자리는 **끊어서** 그린다 — 이어 그리면 없는 소리가 생긴 것처럼 보인다. */
function toPolylines(curve: Curve, lo: number, hi: number, w: number): string[] {
  const out: string[] = []
  let cur: string[] = []
  const span = Math.max(1e-6, hi - lo)
  curve.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 1) out.push(cur.join(' '))
      cur = []
      return
    }
    const x = PAD + (i / Math.max(1, curve.length - 1)) * (w - PAD * 2)
    const y = H - PAD - ((v - lo) / span) * (H - PAD * 2)
    cur.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  if (cur.length > 1) out.push(cur.join(' '))
  return out
}

function Slider(props: {
  label: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void
}): ReactElement {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
      <span style={{ width: 34, color: 'var(--text-muted)' }}>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step}
        value={props.value} style={{ flex: 1, accentColor: 'var(--cyan)' }}
        onChange={(e) => props.onChange(Number(e.target.value))} />
      <span style={{ width: 38, textAlign: 'right', color: 'var(--text-muted)' }}>
        {props.value.toFixed(2)}
      </span>
    </label>
  )
}

export default function PitchStudio(props: {
  /** 맞춰 갈 목표 — 원본 보컬. 화면이 이미 아는 것을 받는다. **다시 고르게 하지 않는다.** */
  targetPath: string
  /** 손볼 소리. 비어 있으면 목표와 같은 것을 손본다. */
  sourcePath?: string
  disabled?: boolean
}): ReactElement {
  const [target, setTarget] = useState<CurveData | null>(null)
  const [source, setSource] = useState<CurveData | null>(null)
  const [knobs, setKnobs] = useState<Knobs>({ ...NEUTRAL })
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const sourcePath = props.sourcePath || props.targetPath
  const destPath = sourcePath ? sourcePath.replace(/(\.[^.]+)$/, '_손본것.wav') : ''

  const api = (window as unknown as { api: { pitch: {
    curve: (a: string, s?: number) => Promise<Reply<CurveData>>
    reshape: (a: string, d: string, k: Partial<Knobs>, s?: number) => Promise<Reply<unknown>>
    fit: (t: string, a: string, s?: number) => Promise<Reply<{ knobs: Knobs; score: number }>>
  } } }).api.pitch

  const load = useCallback(async () => {
    setError(''); setBusy('곡선을 읽는 중…')
    try {
      const [t, s] = await Promise.all([api.curve(props.targetPath), api.curve(sourcePath)])
      if (!t?.ok || !t.data) throw new Error(t?.error || '원본 곡선을 읽지 못했습니다')
      if (!s?.ok || !s.data) throw new Error(s?.error || '손볼 곡선을 읽지 못했습니다')
      setTarget(t.data); setSource(s.data); setNote('앞 20초입니다.')
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }, [api, props.targetPath, sourcePath])

  // ★끌면 곧바로 보인다 — 파이썬을 부르지 않는다.
  const shaped = useMemo(
    () => (source ? applyKnobs(toSemitones(source.hz), knobs) : null), [source, knobs])
  const targetSemi = useMemo(() => (target ? toSemitones(target.hz) : null), [target])
  const score = useMemo(
    () => (targetSemi && shaped ? similarity(targetSemi, shaped) : 0), [targetSemi, shaped])

  const range = useMemo(() => {
    const all = [...(targetSemi ?? []), ...(shaped ?? [])].filter((v): v is number => v !== null)
    if (!all.length) return { lo: 0, hi: 1 }
    const lo = Math.min(...all)
    const hi = Math.max(...all)
    const pad = Math.max(1, (hi - lo) * 0.1)
    return { lo: lo - pad, hi: hi + pad }
  }, [targetSemi, shaped])

  const autoFit = useCallback(async () => {
    setError(''); setBusy('맞추는 중…')
    try {
      const r = await api.fit(props.targetPath, sourcePath)
      if (!r?.ok || !r.data) throw new Error(r?.error || '맞추지 못했습니다')
      setKnobs({ ...NEUTRAL, ...r.data.knobs })
      setNote('맞췄습니다 — 여기서 손으로 더 돌릴 수 있습니다.')
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }, [api, props.targetPath, sourcePath])

  const make = useCallback(async () => {
    setError(''); setBusy('소리를 만드는 중…')
    try {
      const r = await api.reshape(sourcePath, destPath, knobs)
      if (!r?.ok) throw new Error(r?.error || '소리를 만들지 못했습니다')
      setNote(`만들었습니다 — ${baseName(destPath)}`)
    } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }, [api, knobs, sourcePath, destPath])

  const off = !!props.disabled || !!busy
  const touched = knobs.smooth !== 0 || knobs.spread !== 1 || knobs.shift !== 0
  const width = 860
  const lines = shaped ? toPolylines(shaped, range.lo, range.hi, width) : []
  const tlines = targetSemi ? toPolylines(targetSemi, range.lo, range.hi, width) : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Btn onClick={() => void load()} disabled={off || !props.targetPath}>음높이 보기</Btn>
        <Btn onClick={() => void autoFit()} disabled={off || !source}>자동으로 맞추기</Btn>
        <Btn onClick={() => setKnobs({ ...NEUTRAL })} disabled={off || !touched}>되돌리기</Btn>
        <Btn onClick={() => void make()} disabled={off || !source} primary>손본 소리 만들기</Btn>
        <span style={{ fontSize: 11, color: error ? 'var(--amber)' : 'var(--text-muted)' }}>
          {error || busy || note}
        </span>
      </div>

      {/* ★읽기 전에는 자리를 차지하지 않는다. 빈 상자가 화면을 먹으면 안 된다. */}
      {source && (
        <>
          <svg width={width} height={H} style={{
            background: 'var(--bg-base, #0b0d10)', border: '1px solid var(--border-subtle)',
            borderRadius: 6, maxWidth: '100%',
          }}>
            {tlines.map((p, i) => (
              <polyline key={`t${i}`} points={p} fill="none"
                stroke="var(--emerald)" strokeWidth={1.8} opacity={0.85} />
            ))}
            {lines.map((p, i) => (
              <polyline key={`c${i}`} points={p} fill="none"
                stroke="var(--cyan)" strokeWidth={1.4} />
            ))}
          </svg>

          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)',
                        alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--emerald)' }}>— 원본</span>
            <span style={{ color: 'var(--cyan)' }}>— 손본 것</span>
            <span>겹침 {(score * 100).toFixed(0)}%</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: width }}>
            <Slider label="편다" min={0} max={1} step={0.05} value={knobs.smooth}
              onChange={(v) => setKnobs((k) => ({ ...k, smooth: v }))} />
            <Slider label="폭" min={0} max={3} step={0.05} value={knobs.spread}
              onChange={(v) => setKnobs((k) => ({ ...k, spread: v }))} />
            <Slider label="옮김" min={-12} max={12} step={0.5} value={knobs.shift}
              onChange={(v) => setKnobs((k) => ({ ...k, shift: v }))} />
          </div>
        </>
      )}
    </div>
  )
}
