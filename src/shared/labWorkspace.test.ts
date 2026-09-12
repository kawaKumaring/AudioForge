// 테스트개발 작업실의 **판정 규칙**을 실제로 돌려 본다.
//
// 이 규칙들이 흔들리면 사용자가 "고른 것이 바뀌었다" 거나 "빠진 문장이 조용히 빠졌다" 를 겪는다.
// 화면·저장·내보내기가 전부 이 함수들을 쓰므로 여기서 막는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adoptedTake, emptyDoc, exportReadiness, lineStatus, linesNeedingWork, newLine,
  parseDoc, shouldAutoAdopt, takeBadge, voiceKeyOf,
  type LabDoc, type LabLine, type LabTake,
} from './labWorkspace.ts'

const VOICE = 'C:/voice/A.wav'
const vk = voiceKeyOf(VOICE)

function take(over: Partial<LabTake> = {}): LabTake {
  return { id: 't1', path: 'C:/takes/t1.wav', text: '안녕하세요', voiceKey: vk, createdAt: 1, ...over }
}
function line(over: Partial<LabLine> = {}): LabLine {
  return { id: 'l1', text: '안녕하세요', takes: [], adoptedTakeId: null, ...over }
}
function doc(lines: LabLine[], voicePath = VOICE): LabDoc {
  return { voicePath, voiceLabel: 'A', lines, updatedAt: 0 }
}

test('첫 성공 결과는 기본 채택한다', () => {
  const l = line()
  assert.equal(shouldAutoAdopt(l, take(), vk), true)
})

test('이미 고른 것이 있으면 새 테이크가 그것을 밀어내지 않는다', () => {
  const t1 = take({ id: 'a' })
  const l = line({ takes: [t1], adoptedTakeId: 'a' })
  assert.equal(shouldAutoAdopt(l, take({ id: 'b' }), vk), false,
    '사용자가 고른 결과를 자동 교체하면 안 된다')
})

test('생성 도중 대사를 고쳤으면 늦게 온 결과를 자동 채택하지 않는다', () => {
  // 요청은 '안녕하세요' 로 나갔는데 그 사이 대사가 바뀌었다.
  const l = line({ text: '반갑습니다' })
  const late = take({ text: '안녕하세요' })
  assert.equal(shouldAutoAdopt(l, late, vk), false)
  assert.equal(takeBadge(late, l, vk), '수정 전 대사')
})

test('목소리를 바꾸면 이전 결과는 보존되고 꼬리표가 붙는다', () => {
  const l = line({ takes: [take()], adoptedTakeId: 't1' })
  const other = voiceKeyOf('C:/voice/B.wav')
  assert.equal(l.takes.length, 1, '테이크는 지워지지 않는다')
  assert.equal(takeBadge(l.takes[0], l, other), '이전 목소리')
  assert.equal(lineStatus(l, other), 'stale_voice')
})

test('줄 상태 — 빈 줄·미생성·수정 전·이전 목소리·준비됨', () => {
  assert.equal(lineStatus(line({ text: '   ' }), vk), 'empty')
  assert.equal(lineStatus(line(), vk), 'none')
  const t = take()
  assert.equal(lineStatus(line({ takes: [t], adoptedTakeId: 't1' }), vk), 'ready')
  assert.equal(lineStatus(line({ text: '다른 말', takes: [t], adoptedTakeId: 't1' }), vk), 'stale_text')
  assert.equal(lineStatus(line({ takes: [t], adoptedTakeId: 't1' }), 'other'), 'stale_voice')
})

test('변경된 문장만 다시 만든다 — 준비된 줄은 목록에 없다', () => {
  const ready = line({ id: 'a', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const edited = line({ id: 'b', text: '고친 말', takes: [take({ id: 'tb' })], adoptedTakeId: 'tb' })
  const fresh = line({ id: 'c', text: '새 말' })
  const blank = line({ id: 'd', text: '' })
  const ids = linesNeedingWork(doc([ready, edited, fresh, blank])).map((l) => l.id)
  assert.deepEqual(ids, ['b', 'c'], '준비된 줄과 빈 줄은 다시 만들지 않는다')
})

test('내보내기 — 준비 안 된 자리가 있으면 막고 어디인지 알린다', () => {
  const ok = line({ id: 'a', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const bad = line({ id: 'b', text: '아직' })
  const r = exportReadiness(doc([ok, bad]))
  assert.equal(r.ready, false, '빠진 문장을 조용히 빼고 내보내면 안 된다')
  assert.equal(r.blocking.length, 1)
  assert.equal(r.blocking[0].index, 1)
  assert.equal(r.blocking[0].status, 'none')
})

test('내보내기 — 전부 준비되면 대본 순서대로 경로를 준다', () => {
  const a = line({ id: 'a', text: '하나', takes: [take({ id: 'ta', text: '하나', path: 'p1' })], adoptedTakeId: 'ta' })
  const b = line({ id: 'b', text: '둘', takes: [take({ id: 'tb', text: '둘', path: 'p2' })], adoptedTakeId: 'tb' })
  const r = exportReadiness(doc([a, b]))
  assert.equal(r.ready, true)
  assert.deepEqual(r.paths, ['p1', 'p2'], '대본 순서를 지킨다')
})

test('내보내기 — 빈 줄은 건너뛰되 몇 줄인지 알린다', () => {
  const a = line({ id: 'a', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const r = exportReadiness(doc([a, line({ id: 'x', text: '' }), line({ id: 'y', text: '  ' })]))
  assert.equal(r.ready, true)
  assert.equal(r.skippedEmpty, 2)
})

test('내보내기 — 낡은 결과를 최신인 것처럼 내보내지 않는다', () => {
  const stale = line({ id: 'a', text: '고친 말', takes: [take({ id: 'ta' })], adoptedTakeId: 'ta' })
  const r = exportReadiness(doc([stale]))
  assert.equal(r.ready, false)
  assert.equal(r.blocking[0].status, 'stale_text')
  assert.deepEqual(r.paths, [])
})

test('저장본 복원 — 모양이 맞으면 되살리고, 어긋나면 지어내지 않는다', () => {
  const d = doc([line({ takes: [take()], adoptedTakeId: 't1' })])
  const back = parseDoc(JSON.parse(JSON.stringify(d)))
  assert.ok(back)
  assert.equal(back!.lines[0].takes.length, 1)
  assert.equal(back!.lines[0].adoptedTakeId, 't1')
  assert.equal(back!.voicePath, VOICE)

  assert.equal(parseDoc(null), null)
  assert.equal(parseDoc({}), null)
  assert.equal(parseDoc({ lines: [{ id: 1 }] }), null)
})

test('저장본 복원 — 없는 테이크를 가리키던 채택은 조용히 풀린다', () => {
  const back = parseDoc({ voicePath: VOICE, lines: [{ id: 'l1', text: 'x', takes: [], adoptedTakeId: 'gone' }] })
  assert.ok(back)
  assert.equal(back!.lines[0].adoptedTakeId, null, '없는 파일을 고른 상태로 두면 내보내기가 거짓말을 한다')
})

test('빈 작업실은 줄 하나로 시작한다', () => {
  const d = emptyDoc()
  assert.equal(d.lines.length, 1)
  assert.equal(lineStatus(d.lines[0], ''), 'empty')
  assert.equal(adoptedTake(newLine('x')), null)
})
