// 자동 저장의 **직렬화·병합 계약**을 실제로 돌려 본다(모양 검사가 아니다).
//
// 왜 이 파일이 있는가(2026-09-09 관리자 검수): 저장이 700ms 미뤄지는 동안 모드 전환·파일 교체·
// 종료가 일어나면 마지막 변경이 사라졌고, `settings.set` 의 응답을 버려서 실패해도 저장된 줄 알았다.
// 훅의 시점 처리(전환 직전 저장·종료 직전 동기 저장·실패 표시)는 실제 앱 검사가 재고,
// 여기서는 그 저장이 **기존 기록을 보존하는지**를 순수 함수 수준에서 고정한다.
//
//   · 다른 작업의 기록을 덮지 않는다
//   · 목소리 구성(voiceCasts)·전역 자산(referenceAssets) 은 이 키에 들어가지 않는다
//   · 빈 기록으로 쓸모 있는 기록을 대체하지 않는다
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  WORK_DRAFT_STORAGE_KEY, buildWorkDraft, deserializeWorkDrafts, findWorkDraft,
  putWorkDraft, serializeWorkDrafts, workDraftIsEmpty, workKeyOf,
} from './workDraft.ts'

const slot = (source: string) => ({
  source, clip: '', region: { start: 1, duration: 7 }, ready: true, message: '',
})

const draftFor = (path: string, text: string) => buildWorkDraft({
  sourcePath: path,
  ttsText: text,
  speakerMode: 'multi' as const,
  speakers: { spk_a: slot('C:/voice/A.wav') },
  labels: { spk_a: '인물A' },
  emotionEnabled: {},
  renames: {},
  inheritSpeakerId: null,
  sourceSha256: null,
})

test('저장 키는 하나다 — 목소리 구성·전역 자산이 섞이지 않는다', () => {
  assert.equal(WORK_DRAFT_STORAGE_KEY, 'workDrafts')
  const one = putWorkDraft({}, workKeyOf('C:/work/a.wav'), draftFor('C:/work/a.wav', '가'))
  const json = JSON.stringify(serializeWorkDrafts(one))
  assert.equal(json.includes('voiceCasts'), false)
  assert.equal(json.includes('referenceAssets'), false)
})

test('다른 작업의 기록을 덮지 않는다 — 저장은 그 작업 자리만 갱신한다', () => {
  const ka = workKeyOf('C:/work/a.wav')
  const kb = workKeyOf('C:/work/b.wav')
  let store = putWorkDraft({}, ka, draftFor('C:/work/a.wav', '가나'))
  store = putWorkDraft(store, kb, draftFor('C:/work/b.wav', '다라'))
  // a 를 다시 저장해도 b 는 그대로다.
  store = putWorkDraft(store, ka, draftFor('C:/work/a.wav', '가나다'))
  const back = deserializeWorkDrafts(serializeWorkDrafts(store))
  assert.equal(findWorkDraft(back.drafts, 'C:/work/a.wav')?.draft.ttsText, '가나다')
  assert.equal(findWorkDraft(back.drafts, 'C:/work/b.wav')?.draft.ttsText, '다라')
})

test('저장 → 읽기 왕복에서 인물·대사·구간이 살아남는다', () => {
  const k = workKeyOf('C:/work/a.wav')
  const store = putWorkDraft({}, k, draftFor('C:/work/a.wav', '한 줄'))
  const back = deserializeWorkDrafts(serializeWorkDrafts(store))
  const got = findWorkDraft(back.drafts, 'C:/work/a.wav')
  assert.ok(got, '같은 원본으로 다시 찾는다')
  assert.equal(got.draft.speakerMode, 'multi')
  assert.deepEqual(got.draft.speakers.spk_a.region, { start: 1, duration: 7 })
  assert.equal(got.draft.speakers.spk_a.source, 'C:/voice/A.wav')
})

test('빈 기록은 쓸모 있는 기록을 대체하지 않는다 — 호출부가 이 판정으로 걸러야 한다', () => {
  const empty = buildWorkDraft({
    sourcePath: 'C:/work/a.wav', ttsText: '', speakerMode: 'single',
    speakers: {}, labels: {}, emotionEnabled: {}, renames: {},
    inheritSpeakerId: null, sourceSha256: null,
  })
  assert.equal(workDraftIsEmpty(empty), true)
  assert.equal(workDraftIsEmpty(draftFor('C:/work/a.wav', '가')), false)
})

test('읽기 실패는 "없음" 과 다르다 — 사유가 남아 저장을 막을 수 있다', () => {
  const bad = deserializeWorkDrafts('이것은 JSON 이 아니다')
  assert.ok(bad.report.rootError, '사유가 있어야 저장을 멈출 수 있다')
  assert.deepEqual(bad.drafts, {})
})
