// 목소리 준비 보고 — **읽는 칸은 쓰는 쪽이 채우는 칸이어야 한다.**
//
// ★왜(2026-09-26, 사용자가 시킨 실제 작업을 돌리다 잡음)
//   사용자 신고: "영상을 넣고 목소리를 적용하거나 원래 목소리를 쓰거나 전부 안 된다."
//
//   원인은 **칸 이름이 어긋난 것** 하나였다.
//     · 준비 담당(voicePrepRunner)은 성공을 `phase: 'ready'` 로 알린다.
//     · 그런데 더빙 화면은 `patch.ready` 를 봤다 — 그 칸을 채우는 곳은 **아무 데도 없었다.**
//   그래서 목소리는 실제로 준비됐는데 화면이 그것을 기록하지 못했고,
//   `voice.ref` 가 영영 비어 합성 단추 둘이 잠긴 채 남았다.
//   화면은 '아직 고르지 않았습니다' 로 되돌아가 **아무 말도 하지 않았다.**
//
//   타입 검사가 못 잡은 이유: 자료형에 `ready?: boolean` 이 **유령으로 남아 있었다.**
//   쓰는 곳이 사라졌는데 칸만 남으면, 읽는 쪽은 영원히 빈손을 받는다.
//
// ★그래서 이 검사는 "칸 이름이 맞나" 가 아니라 **"읽는 칸을 누가 채우나"** 를 본다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]) => readFileSync(path.resolve(HERE, ...p), 'utf-8')

const RUNNER = read('..', 'renderer', 'lib', 'voicePrepRunner.ts')
const TYPES = read('voicePreparation.ts')
const DUB = read('..', 'renderer', 'components', 'DubWorkspace.tsx')

/** `report({ ... })` 로 실제로 채워 보내는 칸 이름들. */
export function fieldsWritten(runner: string): Set<string> {
  const out = new Set<string>()
  for (const m of runner.matchAll(/report\(\{([^}]*)\}/g)) {
    for (const f of m[1].matchAll(/(^|[\s,])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) out.add(f[2])
  }
  return out
}

/** 주석을 뺀 코드 — 사연을 적어 둔 주석이 검사에 걸리지 않게. */
const codeOf = (text: string): string =>
  text.split(/\r?\n/).filter((l) => {
    const t = l.trimStart()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

/** 어떤 화면이 `patch.X` 로 읽는 칸 이름들. 주석은 세지 않는다. */
export function fieldsRead(screen: string): Set<string> {
  const out = new Set<string>()
  for (const m of codeOf(screen).matchAll(/\bpatch\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(m[1])
  return out
}

test('쓰는 쪽이 실제로 칸을 채운다 — 검사가 눈이 멀지 않았다', () => {
  const w = fieldsWritten(RUNNER)
  assert.ok(w.size >= 3, `채우는 칸을 ${w.size}개밖에 못 찾았다 — 검사가 눈이 멀었다`)
  assert.ok(w.has('phase'), '준비 단계를 알리는 칸을 못 찾았다')
})

// ★이번 사고 그 자체.
test('더빙 화면이 읽는 칸을 준비 담당이 모두 채운다', () => {
  const written = fieldsWritten(RUNNER)
  const orphan = [...fieldsRead(DUB)].filter((f) => !written.has(f))
  assert.deepEqual(orphan, [],
    `아무도 채우지 않는 칸을 읽는다: ${orphan.join(', ')} — 영원히 빈손을 받는다`)
})

test('준비 여부를 phase 로 판정한다 — 문구나 유령 칸이 아니라', () => {
  assert.ok(DUB.includes("patch.phase === 'ready'"),
    '준비 완료를 phase 로 보지 않는다')
})

// ★유령 칸을 남겨 두면 타입 검사가 다음 사람을 또 통과시킨다.
test('자료형에 아무도 안 채우는 칸을 남기지 않는다', () => {
  const at = TYPES.indexOf('export interface RefStatePatch')
  assert.ok(at > 0, '자료형을 못 찾았다 — 검사가 눈이 멀었다')
  const body = TYPES.slice(at, TYPES.indexOf('}', at))
  assert.ok(!/^\s*ready\?\s*:/m.test(body),
    'ready 칸이 되살아났다 — 채우는 곳이 없으면 읽는 쪽은 영원히 빈손이다')
})

// ── 이빨 확인: 파일을 건드리지 않고 예전 모습으로 검사한다 ──────────────
test('예전 모습이었다면 검사가 운다', () => {
  const 옛화면 = "ref: patch.ready ? { clip: patch.clip } : v.ref"
  const orphan = [...fieldsRead(옛화면)].filter((f) => !fieldsWritten(RUNNER).has(f))
  assert.ok(orphan.includes('ready'),
    '아무도 안 채우는 칸을 읽는데 그냥 통과시킨다')
})

test('쓰는 쪽이 칸 이름을 바꾸면 운다', () => {
  const 바뀐담당 = "report({ stage: 'ready', clip: c, message: '', region: r })"
  const orphan = [...fieldsRead(DUB)].filter((f) => !fieldsWritten(바뀐담당).has(f))
  assert.ok(orphan.length > 0, '쓰는 쪽이 이름을 바꿔도 눈치채지 못한다')
})
