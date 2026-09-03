// source patcher 계약 — 여러 명 화면이 원문을 고치는 유일한 통로.
//
// 이 계층이 위험해지는 지점
//   · 한 발화의 화자를 바꿨는데 뒤 발화까지 끌려간다
//   · 기본 감정을 바꿨는데 대사 중간 감정 태그가 사라진다
//   · 순서를 바꿨는데 쉼·문단 경계가 다른 발화에 붙는다
//   · 좌표가 낡은 채로 구간을 덮어써 엉뚱한 자리를 망친다
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  STRUCTURE_BLOCKERS, canMove, changeBaseEmotion, changeSpeaker,
  createInitialDialogue, deleteUtterance, insertUtteranceAfter, moveUtterance,
  nextInheritingIndex, sliceOf, speakerDirective, structurable,
} from './dialogueSourcePatcher.ts'
import type { StructureInput, UtteranceView } from './dialogueSourcePatcher.ts'

/**
 * 발화 구간을 **원문에서 찾아** 만든다(파서 대신 — 이 모듈은 파서가 아니다).
 *
 * 좌표를 손으로 세지 않는다. 손계산은 한 글자만 틀려도 검사가 엉뚱한 것을 재고,
 * 실제로 이 파일에서 그렇게 틀렸다.
 */
function spanOf(text: string, slice: string, from = 0): { start: number; end: number } {
  const start = text.indexOf(slice, from)
  if (start < 0) throw new Error(`fixture: 조각을 찾지 못했다: ${JSON.stringify(slice)}`)
  return { start, end: start + slice.length }
}

function viewOf(
  text: string, index: number, slice: string, label: string | null, own: boolean,
  opts: { from?: number; emotionId?: string | null } = {}
): UtteranceView {
  const { start, end } = spanOf(text, slice, opts.from ?? 0)
  return {
    index, sourceStart: start, sourceEnd: end,
    speakerId: label ? label.toLowerCase() : null, speakerLabel: label,
    emotionId: opts.emotionId ?? null, hasOwnSpeakerDirective: own, lineIndex: index,
  }
}

/** 좌표를 직접 주는 형태 — 판정 테스트에서 일부러 어긋난 값을 넣을 때만 쓴다. */
function view(
  index: number, start: number, end: number, label: string | null, own: boolean,
  emotionId: string | null = null
): UtteranceView {
  return {
    index, sourceStart: start, sourceEnd: end,
    speakerId: label ? label.toLowerCase() : null, speakerLabel: label,
    emotionId, hasOwnSpeakerDirective: own, lineIndex: index,
  }
}

function input(over: Partial<StructureInput> = {}): StructureInput {
  const text = over.text ?? '[화자 민수]\n안녕'
  return {
    text,
    textSha256: 'sha-current',
    planSourceSha256: 'sha-current',
    parserAuthority: true,
    utterances: [view(0, 0, text.length, '민수', true)],
    offsetsExact: [true],
    hasBlockingWarning: false,
    ...over,
  }
}

// ── 판정 ───────────────────────────────────────────────────────────────────

test('현재 SHA 와 계획 SHA 가 같아야 구조화 편집을 허용한다', () => {
  assert.equal(structurable(input()).structurable, true)
  const stale = structurable(input({ planSourceSha256: 'sha-old' }))
  assert.equal(stale.structurable, false)
  assert.deepEqual(stale.blockers, ['PLAN_STALE'])
  const missing = structurable(input({ planSourceSha256: null }))
  assert.deepEqual(missing.blockers, ['PLAN_MISSING'])
})

test('파서가 물러났거나 좌표가 근사하면 허용하지 않는다', () => {
  assert.deepEqual(structurable(input({ parserAuthority: false })).blockers,
    ['PARSER_FALLBACK'])
  assert.deepEqual(structurable(input({ offsetsExact: [false] })).blockers,
    ['OFFSETS_APPROXIMATE'])
  assert.deepEqual(structurable(input({ hasBlockingWarning: true })).blockers,
    ['BLOCKING_WARNING'])
})

test('구간 밖에 공백 아닌 것이 있으면 직접 입력을 유지한다', () => {
  // 쉼이 발화 밖에 있는 대본 — 초기 버전은 일부러 제외한다.
  const text = '[화자 민수]\n안녕\n[쉼 0.5]\n[화자 지은]\n응'
  const got = structurable(input({
    text,
    utterances: [
      viewOf(text, 0, '[화자 민수]\n안녕', '민수', true),
      viewOf(text, 1, '[화자 지은]\n응', '지은', true),
    ],
    offsetsExact: [true, true],
  }))
  assert.equal(got.structurable, false)
  assert.ok(got.blockers.includes('NON_WHITESPACE_OUTSIDE'))
})

test('구간이 겹치거나 순서가 어긋나면 허용하지 않는다', () => {
  const text = '[화자 민수]\n안녕'
  const got = structurable(input({
    text,
    utterances: [view(0, 5, text.length, '민수', true), view(1, 0, 4, '지은', true)],
    offsetsExact: [true, true],
  }))
  assert.ok(got.blockers.includes('SPANS_OVERLAP'))
})

test('발화가 없으면 구조화할 것이 없다', () => {
  assert.deepEqual(structurable(input({ text: '', utterances: [], offsetsExact: [] })).blockers,
    ['NO_UTTERANCES'])
})

test('모든 차단 사유가 알려진 토큰이다', () => {
  const got = structurable(input({
    planSourceSha256: null, parserAuthority: false, offsetsExact: [false],
    hasBlockingWarning: true,
  }))
  for (const b of got.blockers) assert.ok(STRUCTURE_BLOCKERS.includes(b), b)
})

// ── 화자 유지 규칙 ──────────────────────────────────────────────────────────

test('화자를 바꾸면 뒤 발화의 원래 화자가 복원된다', () => {
  // 지시하신 사례 그대로.
  const text = '[화자 민수]\n첫 번째\n두 번째'
  const first = viewOf(text, 0, '[화자 민수]\n첫 번째', '민수', true)
  const second = viewOf(text, 1, '두 번째', '민수', false)
  assert.equal(sliceOf(text, first), '[화자 민수]\n첫 번째')
  assert.equal(sliceOf(text, second), '두 번째')
  assert.equal(nextInheritingIndex([first, second], 0), 1)

  const out = changeSpeaker(text, [first, second], 0, '지은')
  assert.equal(out.changed, true)
  assert.equal(out.text, '[화자 지은]\n첫 번째\n[화자 민수]\n두 번째')
})

test('뒤 발화가 자기 표기를 가지면 복원 표기를 넣지 않는다', () => {
  const text = '[화자 민수]\n첫 번째\n[화자 지은]\n두 번째'
  const first = viewOf(text, 0, '[화자 민수]\n첫 번째', '민수', true)
  const second = viewOf(text, 1, '[화자 지은]\n두 번째', '지은', true)
  assert.equal(nextInheritingIndex([first, second], 0), null)
  const out = changeSpeaker(text, [first, second], 0, '영희')
  assert.equal(out.text, '[화자 영희]\n첫 번째\n[화자 지은]\n두 번째')
})

test('물려받던 발화의 화자를 바꾸면 그 앞에 표기를 세운다', () => {
  const text = '[화자 민수]\n첫 번째\n두 번째'
  const first = viewOf(text, 0, '[화자 민수]\n첫 번째', '민수', true)
  const second = viewOf(text, 1, '두 번째', '민수', false)
  const out = changeSpeaker(text, [first, second], 1, '지은')
  assert.equal(out.text, '[화자 민수]\n첫 번째\n[화자 지은]\n두 번째')
  // 앞 발화는 글자 그대로다.
  assert.ok(out.text.startsWith('[화자 민수]\n첫 번째'))
})

test('같은 화자로 바꾸는 것은 원문을 건드리지 않는다', () => {
  const text = '[화자 민수]\n안녕'
  const u = view(0, 0, text.length, '민수', true)
  const out = changeSpeaker(text, [u], 0, '민수')
  assert.equal(out.changed, false)
  assert.equal(out.refusedCode, 'NO_CHANGE')
  assert.equal(out.text, text)
})

test('빈 이름으로는 바꾸지 않는다', () => {
  const text = '[화자 민수]\n안녕'
  const out = changeSpeaker(text, [view(0, 0, text.length, '민수', true)], 0, '   ')
  assert.equal(out.changed, false)
  assert.equal(out.refusedCode, 'SPEAKER_LABEL_EMPTY')
})

test('화자 표기는 파서가 받는 형태로 만든다', () => {
  assert.equal(speakerDirective('민수'), '[화자 민수]')
  assert.equal(speakerDirective(null), '[화자 기본]')
  assert.equal(speakerDirective('  '), '[화자 기본]')
})

// ── 감정 ───────────────────────────────────────────────────────────────────

test('기본 감정을 바꿔도 대사 중간 감정 태그가 남는다', () => {
  const text = '[화자 민수]\n[기쁨] 정말 [슬픔] 아니야'
  const u = view(0, 0, text.length, '민수', true, 'happy')
  const out = changeBaseEmotion(text, [u], 0, '[걱정]')
  assert.equal(out.changed, true)
  assert.equal(out.text, '[화자 민수]\n[걱정] 정말 [슬픔] 아니야')
  // 중간 태그가 그대로다.
  assert.ok(out.text.includes('[슬픔]'))
})

test('기본 감정을 없앨 때도 중간 태그를 지우지 않는다', () => {
  const text = '[화자 민수]\n[기쁨] 정말 [슬픔] 아니야'
  const out = changeBaseEmotion(text, [view(0, 0, text.length, '민수', true)], 0, null)
  assert.equal(out.text, '[화자 민수]\n정말 [슬픔] 아니야')
  assert.ok(out.text.includes('[슬픔]'))
})

test('감정 태그가 없던 발화에 기본 감정을 세운다', () => {
  const text = '[화자 민수]\n정말 잘됐어'
  const out = changeBaseEmotion(text, [view(0, 0, text.length, '민수', true)], 0, '[기쁨]')
  assert.equal(out.text, '[화자 민수]\n[기쁨] 정말 잘됐어')
})

test('같은 값이면 원문을 건드리지 않는다', () => {
  const text = '[화자 민수]\n[기쁨] 안녕'
  const out = changeBaseEmotion(text, [view(0, 0, text.length, '민수', true)], 0, '[기쁨]')
  assert.equal(out.changed, false)
  assert.equal(out.refusedCode, 'NO_CHANGE')
})

// ── 삽입·삭제 ──────────────────────────────────────────────────────────────

test('새 발화는 화자 표기를 함께 세우고 뒤 화자를 복원한다', () => {
  const text = '[화자 민수]\n첫 번째\n두 번째'
  const first = viewOf(text, 0, '[화자 민수]\n첫 번째', '민수', true)
  const second = viewOf(text, 1, '두 번째', '민수', false)
  const out = insertUtteranceAfter(text, [first, second], 0, '지은', '아직이야')
  assert.equal(out.text,
    '[화자 민수]\n첫 번째\n[화자 지은]\n아직이야\n[화자 민수]\n두 번째')
})

test('새 발화에 감정을 함께 넣을 수 있다', () => {
  const text = '[화자 민수]\n안녕'
  const out = insertUtteranceAfter(text, [view(0, 0, text.length, '민수', true)], 0,
    '지은', '응', '[걱정]')
  assert.equal(out.text, '[화자 민수]\n안녕\n[화자 지은]\n[걱정] 응')
})

test('새 발화의 줄바꿈은 한 줄로 눌러 담는다', () => {
  const text = '[화자 민수]\n안녕'
  const out = insertUtteranceAfter(text, [view(0, 0, text.length, '민수', true)], 0,
    '지은', ' 첫\n둘 ')
  assert.equal(out.text, '[화자 민수]\n안녕\n[화자 지은]\n첫 둘')
})

test('빈 대본 최초 생성은 원문이 비어 있을 때만 한다', () => {
  const rows = [
    { speakerLabel: '민수', line: '정말 잘됐어!' },
    { speakerLabel: '지은', line: '아직 확정된 건 아니야.' },
  ]
  const out = createInitialDialogue('', rows)
  assert.equal(out.text,
    '[화자 민수]\n정말 잘됐어!\n[화자 지은]\n아직 확정된 건 아니야.')
  // 원문이 있으면 덮어쓰지 않는다.
  const kept = createInitialDialogue('기존 대본', rows)
  assert.equal(kept.changed, false)
  assert.equal(kept.refusedCode, 'TEXT_NOT_EMPTY')
  assert.equal(kept.text, '기존 대본')
  // 이름·대사가 비면 아무것도 쓰지 않는다(빈 인물 카드만 있는 상태).
  const nothing = createInitialDialogue('', [{ speakerLabel: '', line: '' }])
  assert.equal(nothing.changed, false)
  assert.equal(nothing.refusedCode, 'NOTHING_TO_WRITE')
})

test('발화를 지우면 뒤 발화의 화자가 복원된다', () => {
  const text = '[화자 민수]\n첫 번째\n두 번째'
  const first = viewOf(text, 0, '[화자 민수]\n첫 번째', '민수', true)
  const second = viewOf(text, 1, '두 번째', '민수', false)
  const out = deleteUtterance(text, [first, second], 0)
  assert.equal(out.text, '[화자 민수]\n\n두 번째')
})

test('뒤가 자기 표기를 가지면 삭제가 복원 표기를 넣지 않는다', () => {
  const text = '[화자 민수]\n첫 번째\n[화자 지은]\n두 번째'
  const first = viewOf(text, 0, '[화자 민수]\n첫 번째', '민수', true)
  const second = viewOf(text, 1, '[화자 지은]\n두 번째', '지은', true)
  const out = deleteUtterance(text, [first, second], 0)
  assert.equal(out.text, '\n[화자 지은]\n두 번째')
})

// ── 순서 변경 ──────────────────────────────────────────────────────────────

test('완전히 독립적인 이웃만 순서를 바꿀 수 있다', () => {
  const text = '[화자 민수]\n첫\n[화자 지은]\n둘'
  const a = viewOf(text, 0, '[화자 민수]\n첫', '민수', true)
  const b = viewOf(text, 1, '[화자 지은]\n둘', '지은', true)
  assert.deepEqual(canMove(text, [a, b], 0, 1), { allowed: true, code: null })
  const out = moveUtterance(text, [a, b], 0, 1)
  assert.equal(out.text, '[화자 지은]\n둘\n[화자 민수]\n첫')
})

test('물려받는 발화는 이동을 잠근다', () => {
  const text = '[화자 민수]\n첫\n둘'
  const a = viewOf(text, 0, '[화자 민수]\n첫', '민수', true)
  const b = viewOf(text, 1, '둘', '민수', false)
  assert.deepEqual(canMove(text, [a, b], 0, 1),
    { allowed: false, code: 'SPEAKER_INHERITED' })
  const out = moveUtterance(text, [a, b], 0, 1)
  assert.equal(out.changed, false)
  assert.equal(out.text, text)
})

test('발화 사이에 내용이 있으면 이동을 잠근다', () => {
  const text = '[화자 민수]\n첫\n[쉼 0.5]\n[화자 지은]\n둘'
  const a = viewOf(text, 0, '[화자 민수]\n첫', '민수', true)
  const b = viewOf(text, 1, '[화자 지은]\n둘', '지은', true)
  assert.deepEqual(canMove(text, [a, b], 0, 1),
    { allowed: false, code: 'CONTENT_BETWEEN' })
})

test('이웃이 아니면 이동하지 않는다', () => {
  const text = '[화자 민수]\n첫\n[화자 지은]\n둘\n[화자 영희]\n셋'
  const a = viewOf(text, 0, '[화자 민수]\n첫', '민수', true)
  const b = viewOf(text, 1, '[화자 지은]\n둘', '지은', true)
  const c = viewOf(text, 2, '[화자 영희]\n셋', '영희', true)
  assert.deepEqual(canMove(text, [a, b, c], 0, 2),
    { allowed: false, code: 'NOT_ADJACENT' })
})

test('뒤에 이어받는 발화가 있으면 이동을 잠근다', () => {
  const text = '[화자 민수]\n첫\n[화자 지은]\n둘\n셋'
  const a = viewOf(text, 0, '[화자 민수]\n첫', '민수', true)
  const b = viewOf(text, 1, '[화자 지은]\n둘', '지은', true)
  const c = viewOf(text, 2, '셋', '지은', false)
  assert.deepEqual(canMove(text, [a, b, c], 0, 1),
    { allowed: false, code: 'FOLLOWER_INHERITS' })
  void c
})

// ── 원문 보존 ──────────────────────────────────────────────────────────────

test('어떤 명령도 구간 밖 글자를 건드리지 않는다', () => {
  // 앞뒤에 주석 같은 알 수 없는 표기를 두고, 그것이 그대로 남는지 본다.
  const head = '## 메모: 이 줄은 파서가 모른다\n'
  const tail = '\n## 끝 메모'
  const body = '[화자 민수]\n첫\n[화자 지은]\n둘'
  const text = head + body + tail
  const a = viewOf(text, 0, '[화자 민수]\n첫', '민수', true)
  const b = viewOf(text, 1, '[화자 지은]\n둘', '지은', true)

  for (const out of [
    changeSpeaker(text, [a, b], 0, '영희'),
    changeBaseEmotion(text, [a, b], 0, '[기쁨]'),
    insertUtteranceAfter(text, [a, b], 1, '민수', '셋'),
    deleteUtterance(text, [a, b], 1),
    moveUtterance(text, [a, b], 0, 1),
  ]) {
    assert.ok(out.text.startsWith(head), '앞 메모가 사라졌다')
    assert.ok(out.text.endsWith(tail), '뒤 메모가 사라졌다')
  }
})

test('없는 발화를 가리키면 아무것도 하지 않는다', () => {
  const text = '[화자 민수]\n안녕'
  const u = view(0, 0, text.length, '민수', true)
  for (const out of [
    changeSpeaker(text, [u], 9, '지은'),
    changeBaseEmotion(text, [u], 9, '[기쁨]'),
    insertUtteranceAfter(text, [u], 9, '지은', '응'),
    deleteUtterance(text, [u], 9),
  ]) {
    assert.equal(out.changed, false)
    assert.equal(out.refusedCode, 'UTTERANCE_NOT_FOUND')
    assert.equal(out.text, text)
  }
})
