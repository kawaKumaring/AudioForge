// 현재 작업 자동 저장 계약 — 합성하지 않아도 남고, 재시작 후 사용자에게 재확정을 요구하지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_WORK_DRAFTS, WORK_DRAFT_SCHEMA_VERSION, buildWorkDraft, deserializeWorkDrafts, findWorkDraft,
  planWorkRestore, putWorkDraft, serializeWorkDrafts, slotForPlan, workDraftIsEmpty, workKeyOf,
} from './workDraft.ts'
import type { WorkDraft } from './workDraft.ts'

const INPUT = {
  sourcePath: 'E:\\voices\\A.wav',
  ttsText: '[화자 주인공]\n하나',
  speakerMode: 'multi' as const,
  speakers: {
    주인공: { source: 'E:\\voices\\A.wav', region: { start: 9.755, duration: 8.685 } },
    조연: { source: 'E:\\voices\\B.wav', region: null, referenceId: 'ref-b' },
  },
  labels: { 주인공: '주인공', 조연: '조연' },
  emotionEnabled: { 주인공: true },
  renames: { 인물1: '주인공' },
  inheritSpeakerId: null,
  now: '2026-09-05T10:00:00.000Z',
}

test('작업 열쇠는 원본 경로를 정규화한 값이다 — 전역 화자 이름으로 묶지 않는다', () => {
  assert.equal(workKeyOf('E:\\voices\\A.wav'), 'e:/voices/a.wav')
  assert.equal(workKeyOf('E:/Voices/A.WAV'), workKeyOf('E:\\voices\\a.wav'))
  assert.equal(workKeyOf('  '), '')
  // 다른 원본은 다른 작업이다.
  assert.notEqual(workKeyOf('E:/voices/A.wav'), workKeyOf('E:/voices/B.wav'))
})

test('기록에는 확정 구간이 들어가고 임시 클립·준비 여부는 들어가지 않는다', () => {
  const d = buildWorkDraft(INPUT)
  assert.deepEqual(d.speakers['주인공'].region, { start: 9.755, duration: 8.685 })
  assert.equal(d.speakers['주인공'].emotionEnabled, true)
  assert.equal(d.speakers['조연'].referenceId, 'ref-b')
  assert.deepEqual(d.renames, { 인물1: '주인공' })
  assert.equal(d.ttsText, '[화자 주인공]\n하나')
  const blob = JSON.stringify(d)
  assert.equal(blob.includes('"clip"'), false)
  assert.equal(blob.includes('"ready"'), false)
})

test('원본 없는 인물은 담지 않고, 담을 것이 없으면 빈 기록으로 판정한다', () => {
  const d = buildWorkDraft({ ...INPUT, speakers: { 유령: { source: '  ', region: null } }, ttsText: '' })
  assert.deepEqual(Object.keys(d.speakers), [])
  assert.equal(workDraftIsEmpty(d), true)
  assert.equal(workDraftIsEmpty(buildWorkDraft(INPUT)), false)
})

test('저장·복원 왕복에서 값이 보존되고, 어긋난 항목만 격리한다', () => {
  const key = workKeyOf(INPUT.sourcePath)
  const stored = serializeWorkDrafts({ [key]: buildWorkDraft(INPUT) })
  const back = deserializeWorkDrafts(JSON.parse(JSON.stringify(stored)))
  assert.equal(back.report.rootError, null)
  assert.equal(back.report.restored, 1)
  assert.deepEqual(back.drafts[key].speakers['주인공'].region, { start: 9.755, duration: 8.685 })

  const dirty = { schemaVersion: WORK_DRAFT_SCHEMA_VERSION, drafts: {
    good: buildWorkDraft(INPUT), bad: { schemaVersion: 99 }, worse: 7 } }
  const out = deserializeWorkDrafts(dirty)
  assert.equal(out.report.restored, 1)
  assert.equal(out.report.quarantined, 2)
  assert.equal(out.report.rootError, null)
})

test('모르는 스키마는 전체를 쓰지 않고 사유를 남긴다 — 저장된 원본을 덮지 않게', () => {
  for (const [raw, code] of [[{ schemaVersion: 999, drafts: {} }, 'SCHEMA_VERSION'],
    [{ schemaVersion: WORK_DRAFT_SCHEMA_VERSION }, 'DRAFTS_MISSING'], ['nope', 'NOT_OBJECT']] as const) {
    const out = deserializeWorkDrafts(raw)
    assert.equal(out.report.rootError, code)
    assert.deepEqual(out.drafts, {})
  }
  assert.equal(deserializeWorkDrafts(null).report.rootError, null)   // 처음 실행은 오류가 아니다
})

test('상한을 넘으면 오래된 것부터 버리되 방금 작업한 것은 남는다', () => {
  let map: Record<string, WorkDraft> = {}
  for (let i = 0; i < MAX_WORK_DRAFTS; i += 1) {
    map = putWorkDraft(map, `k${i}`, buildWorkDraft({ ...INPUT, now: `2026-09-05T00:${String(i).padStart(2, '0')}:00.000Z` }))
  }
  assert.equal(Object.keys(map).length, MAX_WORK_DRAFTS)
  map = putWorkDraft(map, 'newest', buildWorkDraft({ ...INPUT, now: '2026-09-05T23:00:00.000Z' }))
  assert.equal(Object.keys(map).length, MAX_WORK_DRAFTS)
  assert.ok(map.newest, '방금 넣은 것은 남는다')
  assert.equal(map.k0, undefined, '가장 오래된 것이 빠진다')
  assert.ok(map[`k${MAX_WORK_DRAFTS - 1}`])
})

test('원본을 옮겨도 내용 해시가 같으면 찾는다. 해시가 없으면 조용히 못 찾는다', () => {
  const key = workKeyOf('E:/voices/A.wav')
  const withSha = { [key]: buildWorkDraft({ ...INPUT, sourceSha256: 'abc' }) }
  assert.equal(findWorkDraft(withSha, 'E:\\voices\\A.wav')?.key, key)
  assert.equal(findWorkDraft(withSha, 'D:/moved/A.wav', 'abc')?.key, key)
  assert.equal(findWorkDraft(withSha, 'D:/moved/A.wav', 'zzz'), null)
  const noSha = { [key]: buildWorkDraft(INPUT) }
  assert.equal(findWorkDraft(noSha, 'D:/moved/A.wav', 'abc'), null)
})

test('복원 계획: 보관 클립 우선, 없으면 저장된 구간으로 재생성, 둘 다 없으면 그 인물만 재연결', () => {
  const draft = buildWorkDraft(INPUT)
  const plans = planWorkRestore(draft, {
    storedClipUsable: (id) => id === 'ref-b',
    sourcePresent: (p) => p === 'E:\\voices\\A.wav',
  })
  const byId = Object.fromEntries(plans.map((p) => [p.speakerId, p]))
  assert.equal(byId['조연'].via, 'storedClip')
  assert.equal(byId['주인공'].via, 'sourceRegion')
  assert.deepEqual(byId['주인공'].region, { start: 9.755, duration: 8.685 }, '저장된 구간 그대로')
  // 보관 클립이 성하지 않으면 원본으로 내려간다.
  const degraded = planWorkRestore(draft, { storedClipUsable: () => false, sourcePresent: () => false })
  assert.deepEqual(degraded.map((p) => p.phase), ['reconnect', 'reconnect'])
  assert.deepEqual(degraded.map((p) => p.via), [null, null])
})

test('복원 중에는 어떤 인물도 준비됨이 아니고, 재연결 인물은 다른 목소리로 대체되지 않는다', () => {
  const draft = buildWorkDraft(INPUT)
  const plans = planWorkRestore(draft, { storedClipUsable: () => true, sourcePresent: () => true })
  for (const p of plans) {
    const slot = slotForPlan(p)
    assert.equal(slot.ready, false)
    assert.equal(slot.clip, '')
    assert.equal(slot.message, '목소리 준비 중')
  }
  const lost = slotForPlan({ speakerId: 'x', source: 'E:/gone.wav', region: null, label: '', emotionEnabled: false, phase: 'reconnect', via: null })
  assert.equal(lost.message, '원본 다시 연결 필요')
  assert.equal(lost.source, 'E:/gone.wav', '원본 지정을 지우지 않는다')
  assert.equal(lost.ready, false)
})
