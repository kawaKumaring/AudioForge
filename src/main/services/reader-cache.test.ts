// 낭독 쌓아 두기의 기록·확정(2026-10-09) — 실제 임시 폴더로 본다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
// @ts-ignore TS5097
import { cacheState, commitCache, readSpokenRecord, reusable, sha256, spokenRecordPath, SPOKEN_RECORD_V } from './reader-cache.ts'

const RULE = { rule: 'ordinal-ko-v1', ordinalChanges: 1 }
const NO_CHANGE = { rule: 'ordinal-ko-v1', ordinalChanges: 0 }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'af-rcache-'))
  const out = join(dir, 'abc.wav')
  const name = 'voice|key일곱 번째 장면이다.'
  const body = '일곱 번째 장면이다.'
  const wav = Buffer.from('RIFF....fake wav bytes')
  const rec = { rule: 'ordinal-ko-v1', ordinalChanges: 1, usedText: 'spoken' as const, engine: 'qwen-0.6b', nameSha256: sha256(name), sentSha256: sha256(body) }
  return { dir, out, name, body, wav, rec, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('확정한 새 소리는 기록이 이름·보낸 글·음원과 맞아 verified', () => {
  const f = fixture()
  try {
    commitCache(f.out, f.wav, f.rec)
    assert.equal(cacheState(f.out, f.name, f.body, RULE), 'verified')
    const r = readSpokenRecord(f.out)
    assert.equal(r.v, SPOKEN_RECORD_V); assert.equal(r.wavSha256, sha256(f.wav)); assert.equal(r.wavBytes, f.wav.length)
    assert.deepEqual(readdirSync(f.dir).filter((n: string) => n.endsWith('.part')), [], '.part 가 남지 않는다')
  } finally { f.done() }
})

test('기록 없는 옛 소리 — 바꾼 글이 없는 요청만 다시 쓴다(보정 확인 불가한 소리를 보정 결과로 쓰지 않는다)', () => {
  const f = fixture()
  try {
    writeFileSync(f.out, f.wav)
    assert.equal(cacheState(f.out, f.name, f.body, NO_CHANGE), 'legacy-unrecorded')
    assert.ok(reusable('legacy-unrecorded'))
    assert.equal(cacheState(f.out, f.name, f.body, RULE), 'legacy-needs-rule')
    assert.ok(!reusable('legacy-needs-rule'))
    assert.equal(cacheState(f.out, f.name, f.body, null), 'legacy-unrecorded')
  } finally { f.done() }
})

test('불완전 저장(기록만 있고 음원 없음)은 쌓아 둔 것이 아니다', () => {
  const f = fixture()
  try {
    commitCache(f.out, f.wav, f.rec); rmSync(f.out)
    assert.equal(cacheState(f.out, f.name, f.body, RULE), 'none')
  } finally { f.done() }
})

test('기록이 다른 이름·다른 글의 것이면 쓰지 않는다', () => {
  const f = fixture()
  try {
    commitCache(f.out, f.wav, f.rec)
    assert.equal(cacheState(f.out, f.name + 'x', f.body, RULE), 'record-mismatch')
    assert.equal(cacheState(f.out, f.name, f.body + 'x', RULE), 'record-mismatch')
  } finally { f.done() }
})

test('음원이 기록과 다르면(바뀜·잘림) 쓰지 않는다', () => {
  const f = fixture()
  try {
    commitCache(f.out, f.wav, f.rec)
    writeFileSync(f.out, Buffer.concat([f.wav, Buffer.from('x')]))
    assert.equal(cacheState(f.out, f.name, f.body, RULE), 'wav-mismatch')
  } finally { f.done() }
})

test('읽을 수 없는 기록·옛 판 기록은 확인 불가 — 쓰지 않는다', () => {
  const f = fixture()
  try {
    commitCache(f.out, f.wav, f.rec)
    writeFileSync(spokenRecordPath(f.out), '{깨진')
    assert.equal(cacheState(f.out, f.name, f.body, RULE), 'record-unreadable')
    const old = { ...JSON.parse(JSON.stringify({ ...f.rec, wavSha256: sha256(f.wav), wavBytes: f.wav.length, madeAt: '' })), v: SPOKEN_RECORD_V + 99 }
    writeFileSync(spokenRecordPath(f.out), JSON.stringify(old))
    assert.equal(cacheState(f.out, f.name, f.body, RULE), 'record-unreadable')
  } finally { f.done() }
})

// ── plain 기록(Qwen 없이 바꾸지 않은 글로 만든 소리) — 기록을 끝까지 대조한 **뒤에** 재사용 여부를 정한다(2026-10-09 재검수) ──
const PLAIN = '7번째 장면이다.'
const plainRec = (f: ReturnType<typeof fixture>) => ({ ...f.rec, rule: null, ordinalChanges: 0, usedText: 'plain' as const, sentSha256: sha256(PLAIN) })

test('정상 plain 기록 — 사실대로 맞는 기록(fallback-plain)이지만 보정 요청에는 다시 쓰지 않는다', () => {
  const f = fixture()
  try {
    commitCache(f.out, f.wav, plainRec(f))
    const st = cacheState(f.out, f.name, f.body, { ...RULE, plainSay: PLAIN })
    assert.equal(st, 'fallback-plain')
    assert.ok(!reusable(st))
    assert.equal(readSpokenRecord(f.out).usedText, 'plain')
    // 보정을 끈(바꾸지 않은 글을 그대로 보내는) 같은 이름 요청에는 맞는 소리다.
    assert.equal(cacheState(f.out, f.name, f.body, { rule: null, ordinalChanges: 0, plainSay: PLAIN }), 'verified')
  } finally { f.done() }
})

test('plain 기록의 전달 글이 이번 요청의 바꾸지 않은 글과 다르면 기록 불일치 — fallback-plain 으로 보이지 않는다', () => {
  const f = fixture()
  try {
    commitCache(f.out, f.wav, plainRec(f))
    assert.equal(cacheState(f.out, f.name, f.body, { ...RULE, plainSay: PLAIN + ' 다른 글' }), 'record-mismatch')
    assert.equal(cacheState(f.out, f.name, f.body, RULE), 'record-mismatch')      // plainSay 없음 → body 와 대조
  } finally { f.done() }
})

test('plain 기록에 연결된 음원이 바뀌면 음원 불일치 — fallback-plain 으로 보이지 않는다', () => {
  const f = fixture()
  try {
    commitCache(f.out, f.wav, plainRec(f))
    writeFileSync(f.out, Buffer.from('RIFF....other bytes!!'))
    assert.equal(cacheState(f.out, f.name, f.body, { ...RULE, plainSay: PLAIN }), 'wav-mismatch')
    writeFileSync(f.out, Buffer.alloc(f.wav.length, 1))          // 크기는 같고 내용만 다름
    assert.equal(cacheState(f.out, f.name, f.body, { ...RULE, plainSay: PLAIN }), 'wav-mismatch')
  } finally { f.done() }
})

test('plain 기록이 다른 이름의 것이면 기록 불일치', () => {
  const f = fixture()
  try {
    commitCache(f.out, f.wav, plainRec(f))
    assert.equal(cacheState(f.out, f.name + 'x', f.body, { ...RULE, plainSay: PLAIN }), 'record-mismatch')
  } finally { f.done() }
})

test('확정 실패는 이름으로 쌓지 않는다(throw) · 조각이 남지 않는다', () => {
  const f = fixture()
  try {
    const bad = join(f.dir, '없는 폴더', 'abc.wav')
    assert.throws(() => commitCache(bad, f.wav, f.rec))
    assert.ok(!existsSync(bad))
    assert.ok(!existsSync(spokenRecordPath(bad)))
  } finally { f.done() }
})

test('확정은 그 이름 자리만 — 다른 쌓아 둔 것(기록 없는 옛 소리 포함)은 지우지 않는다', () => {
  const f = fixture()
  try {
    const other = join(f.dir, 'other.wav'); writeFileSync(other, 'old')
    commitCache(f.out, f.wav, f.rec)
    commitCache(f.out, f.wav, f.rec)          // 같은 자리 다시 확정(덮어쓰기)
    assert.equal(readFileSync(other, 'utf-8'), 'old')
    assert.equal(cacheState(f.out, f.name, f.body, RULE), 'verified')
  } finally { f.done() }
})
