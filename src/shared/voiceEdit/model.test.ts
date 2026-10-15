// 음성 편집 모델 — 겹치기·크로스페이드·트림·스냅·음소거/솔로.
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097
import * as M from './model.ts'

const file = (name: string, duration: number) => ({ path: `C:/x/${name}.wav`, name, duration })
function two () {
  let p = M.addTrack(M.emptyProject(), 'A')
  p = M.addTrack(p, 'B')
  const [a, b] = p.tracks
  return { p, a: a.id, b: b.id }
}

test('트랙에 이어 놓으면 앞 클립 끝에서 시작한다', () => {
  let { p, a } = two()
  p = M.addClip(p, a, file('1', 3)); p = M.addClip(p, a, file('2', 2))
  assert.deepEqual(p.clips.map((c) => c.start), [0, 3])
})

test('다른 트랙끼리는 자유롭게 겹친다(끼어들기·동시 발화)', () => {
  let { p, a, b } = two()
  p = M.addClip(p, a, file('1', 5)); p = M.addClip(p, b, file('2', 3), 1)
  const s = M.mixSchedule(p)
  assert.equal(p.clips[1].start, 1)
  assert.ok(s.every((x) => x.fadeIn === 0 && x.fadeOut === 0), '트랙이 다르면 크로스페이드를 만들지 않는다')
})

test('같은 트랙 겹침 = 크로스페이드(같은 구간, EqualPower)', () => {
  let { p, a } = two()
  p = M.addClip(p, a, file('1', 4)); p = M.addClip(p, a, file('2', 4))
  p = M.moveClip(p, p.clips[1].id, 3.5)
  const [x, y] = M.mixSchedule(p)
  assert.equal(x.fadeOut, 0.5); assert.equal(y.fadeIn, 0.5)
  assert.equal(x.fadeOutShape, 'equalPower'); assert.equal(y.fadeInShape, 'equalPower')
})

test('같은 트랙 겹침은 한계(2초·통째로 덮지 않음)를 넘으면 그 자리에서 멈춘다', () => {
  let { p, a } = two()
  p = M.addClip(p, a, file('1', 10)); p = M.addClip(p, a, file('2', 3))
  p = M.moveClip(p, p.clips[1].id, 7)                      // 3초 겹침 원함 → 한계 2초
  assert.equal(p.clips[1].start, 8)
  p = M.moveClip(p, p.clips[1].id, 4)                      // 긴 클립 안으로 통째로 → 허용되는 가까운 자리
  const c = p.clips[1]
  assert.ok(!(c.start > 0 && c.start + c.duration < 10), '긴 클립 안에 통째로 들어가지 않는다')
})

test('겹쳐 있어도 반대쪽 끝은 자를 수 있고, 한계에 닿으면 그 자리에서 멈춘다', () => {
  let { p, a } = two()
  p = M.addClip(p, a, file('1', 7.5)); p = M.addClip(p, a, file('2', 2))
  p = M.moveClip(p, p.clips[1].id, 6.5)                    // 1초 겹침
  const id = p.clips[1].id
  p = M.trimClip(p, id, 'end', 8)                          // 길이 2 → 1.5 (겹치지 않은 쪽)
  assert.equal(p.clips[1].duration, 1.5)
  p = M.trimClip(p, id, 'end', 6.6)                        // 겹침(1초)보다 짧게는 못 한다 → 한계에서 멈춤
  assert.ok(p.clips[1].duration >= 1 + M.MIN_CLIP_SEC - 1e-6 && p.clips[1].duration < 1.5)
})

test('자르기는 원본 길이를 넘지 못하고, 앞을 자르면 원본 안 위치가 따라간다', () => {
  let { p, a } = two()
  p = M.addClip(p, a, file('1', 4))
  const id = p.clips[0].id
  p = M.trimClip(p, id, 'start', 1)
  assert.deepEqual([p.clips[0].start, p.clips[0].offset, p.clips[0].duration], [1, 1, 3])
  p = M.trimClip(p, id, 'start', -5)
  assert.deepEqual([p.clips[0].start, p.clips[0].offset], [0, 0], '원본 앞을 넘지 않는다')
  p = M.trimClip(p, id, 'end', 99)
  assert.equal(p.clips[0].duration, 4, '원본 끝을 넘지 않는다')
  p = M.trimClip(p, id, 'end', 0)
  assert.equal(p.clips[0].duration, M.MIN_CLIP_SEC)
})

test('사용자 페이드가 크로스페이드보다 길면 사용자 값과 곡선을 쓴다', () => {
  let { p, a } = two()
  p = M.addClip(p, a, file('1', 4)); p = M.addClip(p, a, file('2', 4))
  p = M.moveClip(p, p.clips[1].id, 3.8)
  p = M.setFade(p, p.clips[1].id, 'in', 1)
  p = M.setClip(p, p.clips[1].id, { shape: 'linear' })
  const y = M.mixSchedule(p)[1]
  assert.equal(y.fadeIn, 1); assert.equal(y.fadeInShape, 'linear')
})

test('음소거·솔로', () => {
  let { p, a, b } = two()
  p = M.addClip(p, a, file('1', 1)); p = M.addClip(p, b, file('2', 1))
  assert.equal(M.mixSchedule(M.setTrack(p, a, { mute: true })).length, 1)
  assert.deepEqual(M.mixSchedule(M.setTrack(p, b, { solo: true })).map((x) => x.trackId), [b])
})

test('스냅: 가까운 끝에 붙고, 멀면 그대로', () => {
  assert.equal(M.snapTime(3.02, [0, 3, 5], 0.05), 3)
  assert.equal(M.snapTime(3.2, [0, 3, 5], 0.05), 3.2)
})

test('저장된 작업 정리: 깨진 항목은 버리고 값은 범위 안으로', () => {
  const raw = { tracks: [{ id: 't1', name: 'A', gainDb: 99 }], clips: [
    { id: 'c1', trackId: 't1', path: 'a.wav', start: -3, offset: 9, duration: 9, sourceDuration: 2, fadeIn: 5 },
    { id: 'c2', trackId: 'nope', path: 'b.wav' }, null] }
  const p = M.sanitizeProject(raw)
  assert.equal(p.tracks[0].gainDb, 12)
  assert.equal(p.clips.length, 1)
  const c = p.clips[0]
  assert.ok(c.start === 0 && c.offset + c.duration <= 2 + 1e-9 && c.fadeIn <= c.duration)
})

// @ts-ignore TS5097
import { clipHit } from './hit.ts'
test('클립 위 자리 판정: 손잡이 > 모서리 > 자르기 > 옮기기', () => {
  const w = 200, h = 64
  assert.equal(clipHit(100, 40, w, h, 0, 0), 'move')
  assert.equal(clipHit(2, 40, w, h, 0, 0), 'trimStart')
  assert.equal(clipHit(-3, 40, w, h, 0, 0), 'trimStart', '바깥 4px 도 자르기')
  assert.equal(clipHit(-6, 40, w, h, 0, 0), null)
  assert.equal(clipHit(197, 40, w, h, 0, 0), 'trimEnd')
  assert.equal(clipHit(8, 10, w, h, 0, 0), 'fadeIn', '위쪽 모서리 = 페이드 만들기')
  assert.equal(clipHit(192, 10, w, h, 0, 0), 'fadeOut')
  assert.equal(clipHit(56, 6, w, h, 50, 0), 'fadeIn', '있는 페이드 손잡이 ±8px')
  assert.equal(clipHit(56, 40, w, h, 50, 0), 'move', '손잡이는 위쪽 띠에서만')
  assert.equal(clipHit(4, 40, 9, h, 0, 0), 'move', '짧은 클립은 안쪽 자르기 폭이 1/3')
})
