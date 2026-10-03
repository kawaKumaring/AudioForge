import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { CHECKS, formatReport, resultLine, checkInfo } from './selfCheck.ts'

const R = (id: string, ok: boolean, reason: string) => ({ id, ok, reason, ms: 1234, at: '2026-09-30T04:10:11.000Z' }) as never

test('검사는 기능마다 하나 — 이름이 겹치지 않는다', () => {
  const ids = CHECKS.map((c) => c.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(CHECKS.every((c) => c.label && c.what))
})

test('★오래 걸리는 검사는 미리 말한다 — 누르고 나서 멈춘 줄 알지 않게', () => {
  assert.ok(checkInfo('reader-reference')?.slow, '참조 목소리 검사가 느리다고 말하지 않는다')
})

test('결과 한 줄 — 이름·통과/실패·걸린 시간·이유', () => {
  assert.equal(resultLine(R('python', true, '파이썬 3.12.7')), '파이썬 통과 (1.2s) — 파이썬 3.12.7')
  assert.match(resultLine(R('ffmpeg', false, '찾을 수 없습니다')), /^ffmpeg 실패 .* 찾을 수 없습니다$/)
})

test('★보고 글에는 안 돌린 검사도 "안 돌림" 으로 적는다 — 빠진 것을 통과로 읽지 않게', () => {
  const text = formatReport([R('python', true, 'ok'), R('log', false, '안 남음')], ['줄1', '줄2'], 'AudioForge 1.14.0')
  assert.match(text, /^AudioForge 1\.14\.0/)
  assert.match(text, /● 파이썬 통과/)
  assert.match(text, /✕ 동작 기록 실패/)
  assert.match(text, /○ ffmpeg 안 돌림/)
  assert.match(text, /\[최근 동작 기록 2건\]\n줄1\n줄2$/)
  for (const c of CHECKS) assert.ok(text.includes(c.label), `${c.label} 이 보고에 없다`)
})
