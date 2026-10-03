// 다른 자리에 저장할 때 — **덮어쓰지 않는다.**
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportFault, refusalText } from './trackExportGuard.ts'
import type { PathProbe } from './joinOutputGuard.ts'

/** 같은 파일을 다른 이름으로 가리킬 수 있는 세상. */
const probe = (ids: Record<string, string>): PathProbe => ({
  real: (p) => p.replace(/\\/g, '/'),
  fileId: (p) => ids[p] ?? null,
})

test('빈 폴더에는 저장한다', () => {
  assert.equal(exportFault('D:/backup/speaker_a.wav', ['C:/out/speaker_a.wav'], false, probe({})), '')
})

test('★결과 파일 위에는 저장하지 않는다 — 자기 자신을 덮는 경우', () => {
  const p = probe({ 'C:/out/speaker_a.wav': '1:100' })
  assert.equal(exportFault('C:/out/speaker_a.wav', ['C:/out/speaker_a.wav'], true, p), 'GUARDED')
})

test('★경로 모양이 달라도 같은 파일이면 막는다', () => {
  // 바로가기·짧은 이름 등으로 같은 파일을 다르게 가리킬 수 있다 — 번호로 본다.
  const p = probe({ 'C:/out/speaker_a.wav': '1:100', 'D:/link/a.wav': '1:100' })
  assert.equal(exportFault('D:/link/a.wav', ['C:/out/speaker_a.wav'], true, p), 'GUARDED')
})

test('★같은 이름이 이미 있으면 덮지 않고 사유를 남긴다', () => {
  assert.equal(exportFault('D:/backup/a.wav', ['C:/out/a.wav'], true, probe({})), 'EXISTS')
})

test('사유는 사람이 읽을 말로 나간다 — 내부 코드가 화면에 뜨지 않는다', () => {
  assert.match(refusalText('GUARDED'), /저장할 수 없습니다/)
  assert.match(refusalText('EXISTS'), /이미 있습니다/)
})
