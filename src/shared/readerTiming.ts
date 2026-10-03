/**
 * 낭독 — **소리 안에서 지금 어느 글자를 읽는가.**
 *
 * ★왜 (2026-10-01 사용자 신고): "따라가기가 소리가 읽어 주는 줄바꿈에 맞춰 따라가길 원했는데,
 *   생성된 음원의 처음에 서 있다가 다음 음원의 처음 부분에 쭉 서 있는 것 같다."
 *   예전에는 덩이(약 20초) 하나를 통째로 칠하고, 덩이가 넘어갈 때만 화면을 옮겼다 — 읽는 줄을 몰랐다.
 *
 * 어떻게 아는가 — **만든 소리의 쉼**과 **글의 끊는 자리**(문장 끝 · 쉼표)를 맞춘다.
 *   · 어떤 목소리든(기본 · Qwen · 참조) 문장 끝과 쉼표에서 쉰다. 엔진이 시간 정보를 주지 않아도 된다.
 *   · 글은 구절(문장 끝·쉼표로 자른 조각)로 나누고, 구절의 **읽을 글자 수**로 어디쯤 쉴지 어림한다.
 *   · 소리에서 찾은 쉼들 중 어림한 자리에 가까운 것을 **순서를 지켜** 짝짓는다(동적 계획법).
 *     짝을 못 찾은 끊는 자리는 말소리 시간으로 나눠 채운다.
 *   · 구절 안에서는 글자 수대로 나눈다 — 한 구절은 몇 초라 줄 단위로 따라가기에 충분하다.
 *
 * ★순수 함수만 둔다 — 시계·GPU 없이 검사한다(`readerTiming.test.ts`).
 */

/** 구절 하나 — 소리로 읽는 글자 수와, 끝이 문장 끝인지(쉼이 길다). */
export interface TimingPart { weight: number; strong: boolean }

/** 파형 — 모노 · -1~1. */
export interface Wave { sampleRate: number; samples: Float32Array }

/** WAV 를 읽는다(PCM 16/24/32 · float32). 여러 채널이면 첫 채널. 못 읽으면 null. */
export function parseWav(buf: Uint8Array): Wave | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3])
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null
  let off = 12
  while (off + 8 <= buf.length) {
    const id = tag(off), size = dv.getUint32(off + 4, true), body = off + 8
    if (id === 'fmt ') {
      fmt = { format: dv.getUint16(body, true), channels: dv.getUint16(body + 2, true),
        rate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) }
      if (fmt.format === 0xfffe && size >= 26) fmt.format = dv.getUint16(body + 24, true)   // 확장 형식
    } else if (id === 'data' && fmt) {
      const bytes = Math.min(size, buf.length - body)
      const step = (fmt.bits / 8) * fmt.channels
      const n = Math.floor(bytes / step)
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const p = body + i * step
        if (fmt.format === 3 && fmt.bits === 32) out[i] = dv.getFloat32(p, true)
        else if (fmt.bits === 16) out[i] = dv.getInt16(p, true) / 32768
        else if (fmt.bits === 24) out[i] = ((dv.getInt8(p + 2) << 16) | (buf[p + 1] << 8) | buf[p]) / 8388608
        else if (fmt.bits === 32) out[i] = dv.getInt32(p, true) / 2147483648
        else return null
      }
      return { sampleRate: fmt.rate, samples: out }
    }
    off = body + size + (size & 1)
  }
  return null
}

/** 10ms 마다의 소리 크기(RMS). */
export const HOP_SEC = 0.01
export function envelope(w: Wave, hopSec = HOP_SEC): Float32Array {
  const hop = Math.max(1, Math.round(w.sampleRate * hopSec))
  const n = Math.floor(w.samples.length / hop)
  const env = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let s = 0
    for (let i = f * hop, e = i + hop; i < e; i++) s += w.samples[i] * w.samples[i]
    env[f] = Math.sqrt(s / hop)
  }
  return env
}

interface Pause { start: number; end: number; voicedBefore: number }

/** 쉼으로 볼 가장 짧은 길이(초). 낱말 사이의 짧은 끊김(수십 ms)은 쉼이 아니다. */
export const MIN_PAUSE_SEC = 0.09

/**
 * 구절마다 **소리 안의 시작·끝 시각**(초). 돌려주는 배열은 구절 수만큼의 [시작, 끝].
 * 말소리가 없으면(빈 소리) 전부 0.
 */
export function alignParts(env: Float32Array, parts: readonly TimingPart[], hopSec = HOP_SEC): Array<[number, number]> {
  const n = parts.length
  if (!n) return []
  let peak = 0
  for (const v of env) if (v > peak) peak = v
  const thr = Math.max(peak * 0.04, 1e-4)             // 가장 큰 소리보다 약 28dB 작으면 조용하다
  let first = -1, last = -1
  for (let f = 0; f < env.length; f++) if (env[f] > thr) { if (first < 0) first = f; last = f }
  if (first < 0) return parts.map(() => [0, 0])
  // 말소리 사이의 쉼 — 앞뒤의 조용함은 빼고.
  const minRun = Math.max(1, Math.round(MIN_PAUSE_SEC / hopSec))
  const pauses: Pause[] = []
  let voiced = 0, runFrom = -1
  for (let f = first; f <= last + 1; f++) {
    const quiet = f <= last && env[f] <= thr
    if (quiet) { if (runFrom < 0) runFrom = f; continue }
    if (runFrom >= 0) {
      if (f - runFrom >= minRun) pauses.push({ start: runFrom, end: f, voicedBefore: voiced })
      runFrom = -1
    }
    if (f <= last) voiced++
  }
  const V = Math.max(1, voiced)
  // 끊는 자리 k(구절 k 뒤)의 어림 자리 — 말소리 시간 기준.
  const W = parts.reduce((s, p) => s + Math.max(0, p.weight), 0) || 1
  const expect: number[] = []
  let acc = 0
  for (let k = 0; k < n - 1; k++) { acc += Math.max(0, parts[k].weight); expect.push(acc / W * V) }
  // 순서를 지켜 짝짓기(동적 계획법). 짝짓지 않으면 벌점 — 문장 끝은 크게, 쉼표는 작게(쉼표에선 안 쉴 때도 많다).
  const B = n - 1, P = pauses.length
  const SKIP = (k: number) => parts[k].strong ? 0.12 : 0.03
  const cost = (k: number, j: number) => {
    const d = Math.abs(expect[k] - pauses[j].voicedBefore) / V
    if (d > 0.3) return Infinity
    const len = (pauses[j].end - pauses[j].start) * hopSec
    // 긴 쉼일수록 문장 끝답다 — 조금 덜어 준다.
    return d - (parts[k].strong ? 0.04 : 0.015) * Math.min(len, 0.6) / 0.6
  }
  // dp[k][j] = 끊는 자리 0..k-1 을 쉼 0..j-1 안에서 짝지었을 때의 최소 비용
  const INF = Infinity
  const dp: Float64Array[] = Array.from({ length: B + 1 }, () => new Float64Array(P + 1).fill(INF))
  const how: Int8Array[] = Array.from({ length: B + 1 }, () => new Int8Array(P + 1))   // 0=쉼 버림 1=자리 버림 2=짝
  for (let j = 0; j <= P; j++) dp[0][j] = 0
  for (let k = 1; k <= B; k++) {
    dp[k][0] = dp[k - 1][0] + SKIP(k - 1); how[k][0] = 1
    for (let j = 1; j <= P; j++) {
      let best = dp[k][j - 1], h = 0
      const skip = dp[k - 1][j] + SKIP(k - 1)
      if (skip < best) { best = skip; h = 1 }
      const c = cost(k - 1, j - 1)
      const pair = dp[k - 1][j - 1] + c
      if (pair < best) { best = pair; h = 2 }
      dp[k][j] = best; how[k][j] = h
    }
  }
  const match: number[] = new Array(B).fill(-1)
  for (let k = B, j = P; k > 0;) {
    const h = how[k][j]
    if (h === 2) { match[k - 1] = j - 1; k--; j-- } else if (h === 1) k--; else j--
  }
  // 말소리 시간 → 실제 시각(짝 못 찾은 자리를 채울 때).
  const atVoiced = (v: number) => {
    let seen = 0
    for (let f = first; f <= last; f++) { if (env[f] > thr) { if (seen >= v) return f; seen++ } }
    return last + 1
  }
  const ends: number[] = [], starts: number[] = [first]
  for (let k = 0; k < B; k++) {
    const m = match[k]
    if (m >= 0) { ends.push(pauses[m].start); starts.push(pauses[m].end) }
    else { const f = atVoiced(expect[k]); ends.push(f); starts.push(f) }
  }
  ends.push(last + 1)
  // 순서가 뒤집히지 않게(짝 못 찾은 자리가 짝지은 자리 뒤로 가는 일을 막는다).
  for (let k = 1; k < n; k++) { if (starts[k] < ends[k - 1]) starts[k] = ends[k - 1]; if (ends[k] < starts[k]) ends[k] = starts[k] }
  return parts.map((_, k) => [+(starts[k] * hopSec).toFixed(3), +(ends[k] * hopSec).toFixed(3)])
}

/**
 * 재생 시각 → **구절 번호와 그 안의 몫**(0~1). 구절 사이의 쉼에서는 앞 구절 끝(1)에 머문다 —
 * 다음 줄로 미리 뛰지 않는다.
 */
export function partAt(spans: ReadonlyArray<readonly [number, number]>, t: number): { part: number; frac: number } {
  if (!spans.length) return { part: -1, frac: 0 }
  for (let k = 0; k < spans.length; k++) {
    const [s, e] = spans[k]
    if (t < s) return k === 0 ? { part: 0, frac: 0 } : { part: k - 1, frac: 1 }
    if (t <= e) return { part: k, frac: e > s ? (t - s) / (e - s) : 1 }
  }
  return { part: spans.length - 1, frac: 1 }
}
