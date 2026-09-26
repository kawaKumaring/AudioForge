// 작업 폴더를 어디에 둘 것인가 — **옛 작업을 잃지 않는 것**이 가장 중요한 계약이다.
//
// ★왜(2026-09-26 신고: "왜 자꾸 C 드라이브에다 생산시키는건가")
//   작업 폴더가 앱 데이터 폴더로 코드에 박혀 있었고 옮길 설정도 없었다.
//   곡 하나에 약 100MB, 실측으로 이미 535MB 가 시스템 드라이브에 쌓여 있었다.
//   사용자 음원은 다른 드라이브에 있는데 산출물만 거기 쌓이는 구조였다.
//
// ★그러나 이미 쌓인 것을 옮기는 것은 하지 않는다 — 옮기다 실패하면 작업을 잃는다.
//   그래서 "새 작업은 고른 자리, 옛 작업은 있던 자리" 가 규칙이고,
//   이 검사가 지키는 것은 **옛 것이 사라지지 않는다**는 약속이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveWorkDir, workRootBlockReason, workRootOf, workRootNotice,
} from './workRoot.ts'

const DEF = 'C:/Users/me/AppData/Roaming/app'
const PICKED = 'E:/작업'

/** 있는 것으로 칠 경로들. */
const has = (...paths: string[]) => (p: string) =>
  paths.some((q) => q.replace(/\\/g, '/').toLowerCase() === p.replace(/\\/g, '/').toLowerCase())

test('고른 자리가 없으면 기본을 쓴다', () => {
  assert.equal(workRootOf('', DEF), DEF)
  assert.equal(workRootOf('   ', DEF), DEF)
  assert.equal(workRootOf(PICKED, DEF), PICKED)
})

test('새 작업은 고른 자리에 만든다', () => {
  const r = resolveWorkDir({
    chosenRoot: PICKED, defaultRoot: DEF, folder: '곡A', exists: has(),
  })
  assert.equal(r.dir, 'E:/작업/dub/곡A')
  assert.equal(r.legacy, false)
})

// ★이것이 이 파일의 존재 이유다.
test('옛 자리에 있는 작업은 옛 자리에서 연다 — 잃지 않는다', () => {
  const old = `${DEF}/dub/곡A`
  const r = resolveWorkDir({
    chosenRoot: PICKED, defaultRoot: DEF, folder: '곡A', exists: has(old),
  })
  assert.equal(r.dir, old, '자리를 바꿨다고 옛 작업을 못 찾으면 통째로 잃는다')
  assert.equal(r.legacy, true, '옛 자리에서 열었다는 사실을 알리지 않는다')
})

test('고른 자리에 이미 있으면 그것을 먼저 쓴다', () => {
  const here = `${PICKED}/dub/곡A`
  const old = `${DEF}/dub/곡A`
  const r = resolveWorkDir({
    chosenRoot: PICKED, defaultRoot: DEF, folder: '곡A', exists: has(here, old),
  })
  assert.equal(r.dir, here, '새 자리를 두고 옛 자리로 돌아갔다')
  assert.equal(r.legacy, false)
})

test('자리를 안 바꿨으면 옛 자리라는 개념이 없다', () => {
  const r = resolveWorkDir({
    chosenRoot: '', defaultRoot: DEF, folder: '곡A', exists: has(`${DEF}/dub/곡A`),
  })
  assert.equal(r.legacy, false, '같은 자리를 옛 자리라고 부른다')
  assert.equal(r.dir, `${DEF}/dub/곡A`)
})

test('경로 표기가 달라도 같은 자리로 본다', () => {
  const r = resolveWorkDir({
    chosenRoot: 'E:\\작업\\', defaultRoot: DEF, folder: '곡A', exists: has(),
  })
  assert.equal(r.dir, 'E:/작업/dub/곡A', '역슬래시나 끝 슬래시에 속는다')
})

test('빈 자리를 고르면 이유를 말한다', () => {
  assert.match(workRootBlockReason('', { exists: () => true }), /고르세요/)
})

test('없는 폴더는 막는다', () => {
  const why = workRootBlockReason('E:/없는곳', { exists: () => false })
  assert.match(why, /없습니다/)
})

// ★앱 안에 두면 앱을 지울 때 작업도 함께 사라진다.
//   이날 실제로 앱 폴더 안에 모델 캐시 2.4GB 가 쏟아진 일이 있었다.
test('앱이 설치된 자리에는 두지 못한다', () => {
  const app = 'E:/AI_Project/app'
  const why = workRootBlockReason(`${app}/안쪽`, { exists: () => true, appDir: app })
  assert.match(why, /앱/, '앱 안에 두는 것을 막지 않는다')
  assert.equal(workRootBlockReason('E:/딴곳', { exists: () => true, appDir: app }), '',
    '앱 밖인데도 막는다')
})

test('쓸 수 있는 자리는 막지 않는다', () => {
  assert.equal(workRootBlockReason('E:/작업', { exists: () => true }), '')
})

test('어디에 쌓이는지 화면이 말한다', () => {
  assert.ok(workRootNotice(PICKED, false).includes(PICKED), '자리를 알려 주지 않는다')
  assert.match(workRootNotice(PICKED, true), /예전 자리/, '옛 자리에서 열었음을 알리지 않는다')
})
