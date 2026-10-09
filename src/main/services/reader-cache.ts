/**
 * 낭독 쌓아 두기의 **기록·확정 규칙**(2026-10-09) — reader.ipc.ts 가 쓴다. electron 없이 검사할 수 있게 따로 둔다.
 * 규칙: 새 소리는 기록(.spoken.json)을 먼저 확정하고 음원을 마지막에 이름으로 옮긴다. 쓸 때는 기록이 이 이름·보낸 글·음원과 맞는지 확인한다.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, renameSync } from 'fs'
import { createHash } from 'crypto'

/**
 * 서수 읽기 보정(2026-10-09) — 화면이 이 요청의 소리 글을 어떤 규칙으로 만들었나.
 * plainSay = 규칙을 적용하지 않은 소리 글(참조 목소리가 Qwen 이 아닌 엔진으로 넘어갈 때만 쓴다).
 */
export interface SpokenRequest { rule: string | null; ordinalChanges: number; plainSay?: string }

/** 쌓아 둔 소리 옆 기록의 형식 판 — 바꾸면 올린다(옛 판 기록은 '확인 불가'). */
export const SPOKEN_RECORD_V = 1
/**
 * 만든 덩이 옆 기록 — **그 소리를 만들 당시**의 사실. 쌓아 둔 것을 쓸 때 지금 요청과 나란히 돌려준다. 글 본문은 넣지 않는다(지문만).
 * - nameSha256: 쌓아 둔 이름을 만든 원재료(목소리 열쇠 + 보낸 글 [+ 감정 덩어리])의 전체 지문 — 이 기록이 **이 이름**의 것인지.
 * - sentSha256: 실제로 엔진에 보낸 글의 지문(바꾼 글 또는 넘어갔을 때 바꾸지 않은 글).
 * - wavSha256 · wavBytes: 기록과 짝인 음원.
 */
export interface SpokenRecord {
  v: number; rule: string | null; ordinalChanges: number; usedText: 'spoken' | 'plain'; engine?: string
  nameSha256: string; sentSha256: string; wavSha256: string; wavBytes: number; madeAt: string
}
/**
 * 쌓아 둔 소리를 이 요청에 쓸 수 있나 — 판정과 그 이유(관측 기록에 그대로 싣는다).
 * - verified: 기록이 이 이름·이 글·이 음원과 맞는다.
 * - legacy-unrecorded: 기록 제도 이전의 옛 소리(새 저장은 기록을 **먼저** 확정하므로 기록 없는 완성 음원은 옛 것뿐이다).
 *   바꾼 글이 없는 요청에만 다시 쓴다 — 보정을 적용했는지 확인할 수 없는 소리를 보정 결과로 쓰지 않는다.
 * - 나머지는 쓰지 않고 새로 만든다(그 자리만 덮어쓴다 — 다른 쌓아 둔 것은 지우지 않는다).
 */
export type CacheState = 'none' | 'verified' | 'legacy-unrecorded'
  | 'record-unreadable' | 'record-mismatch' | 'wav-mismatch' | 'fallback-plain' | 'legacy-needs-rule'

export function spokenOf(raw: unknown): SpokenRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const rule = typeof o.rule === 'string' && o.rule ? o.rule : null
  const n = Number(o.ordinalChanges)
  return { rule, ordinalChanges: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0, ...(typeof o.plainSay === 'string' ? { plainSay: o.plainSay } : {}) }
}
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
export function spokenRecordPath(wav: string): string { return wav.replace(/\.wav$/i, '') + '.spoken.json' }
export function readSpokenRecord(wav: string): SpokenRecord | null {
  try { return JSON.parse(readFileSync(spokenRecordPath(wav), 'utf-8')) as SpokenRecord } catch { return null }
}

export function cacheState(wav: string, nameSource: string, body: string, spoken: SpokenRequest | null): CacheState {
  if (!existsSync(wav)) return 'none'
  const recPath = spokenRecordPath(wav)
  if (!existsSync(recPath)) {
    // 바꾼 글이 든 요청은 기록 없는 소리를 쓰지 않는다(보정 적용 여부를 확인할 수 없다).
    return spoken?.rule && spoken.ordinalChanges > 0 ? 'legacy-needs-rule' : 'legacy-unrecorded'
  }
  const rec = readSpokenRecord(wav)
  if (!rec || rec.v !== SPOKEN_RECORD_V) return 'record-unreadable'
  if (rec.nameSha256 !== sha256(nameSource)) return 'record-mismatch'
  if (rec.usedText === 'plain') {
    // Qwen 이 없어 바꾸지 않은 글로 만든 소리 — 규칙을 켠 요청에는 쓰지 않는다.
    if (spoken?.rule) return 'fallback-plain'
    if (spoken?.plainSay == null || rec.sentSha256 !== sha256(spoken.plainSay)) return 'record-mismatch'
  } else if (rec.sentSha256 !== sha256(body)) return 'record-mismatch'
  try {
    const buf = readFileSync(wav)
    if (buf.length !== rec.wavBytes || sha256(buf) !== rec.wavSha256) return 'wav-mismatch'
  } catch { return 'wav-mismatch' }
  return 'verified'
}
export const reusable = (s: CacheState) => s === 'verified' || s === 'legacy-unrecorded'

/**
 * 새 소리를 쌓아 둔 자리에 **확정**한다 — 기록을 먼저 확정하고 음원을 마지막에 이름으로 옮긴다.
 * ★음원 이름이 생기는 순간 기록은 이미 있다. 어느 단계든 실패하면 그 이름으로 쌓지 않는다(throw) — 부르는 쪽이
 *   재생 전용 자리로 돌린다. 중간에 끊겨 남은 .part 는 이름이 달라 쓰이지 않고 다음 정리에서 지운다.
 */
export function commitCache(out: string, wavBytes: Buffer, rec: Omit<SpokenRecord, 'v' | 'wavSha256' | 'wavBytes' | 'madeAt'>): void {
  const full: SpokenRecord = { v: SPOKEN_RECORD_V, ...rec, wavSha256: sha256(wavBytes), wavBytes: wavBytes.length, madeAt: new Date().toISOString() }
  const recPath = spokenRecordPath(out)
  const tag = `${process.pid}-${Date.now()}`
  const wavPart = `${out}.${tag}.part`, recPart = `${recPath}.${tag}.part`
  try {
    writeFileSync(wavPart, wavBytes)
    writeFileSync(recPart, JSON.stringify(full), 'utf-8')
    // 옛 음원을 먼저 치운다 — 새 기록이 옛 음원과 짝지어 보이는 틈을 없앤다(같은 이름 자리 하나만).
    rmSync(out, { force: true })
    renameSync(recPart, recPath)
    renameSync(wavPart, out)
  } catch (e) {
    for (const p of [wavPart, recPart]) { try { rmSync(p, { force: true }) } catch { /* 다음 정리에서 */ } }
    // 기록만 확정되고 음원을 못 옮겼으면 음원 없는 기록이 남는다 — 'none' 으로 보이고 다음에 다시 만든다.
    throw e
  }
}

