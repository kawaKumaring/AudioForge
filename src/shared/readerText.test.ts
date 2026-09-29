import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { speakableText, parseReaderPrefs, DEFAULT_READER_PREFS } from './readerText.ts'

const ON = { skipHanjaInParens: true }
const OFF = { skipHanjaInParens: false }

test('★끄면 원문 그대로 읽는다 — 켜기 전에는 예전과 같다', () => {
  assert.equal(speakableText('학교(學校)에 갔다.', OFF), '학교(學校)에 갔다.')
  assert.equal(DEFAULT_READER_PREFS.skipHanjaInParens, false)
})

test('★괄호 속 한자를 뺀다 — 중국어로 읽지 않는다', () => {
  assert.equal(speakableText('학교(學校)에 갔다.', ON), '학교에 갔다.')
  assert.equal(speakableText('그는 인간(人間)이었다. 그리고 신(神)이었다.', ON),
    '그는 인간이었다. 그리고 신이었다.')
})

test('앞의 띄어쓰기도 함께 뺀다 — 말 사이가 벌어지지 않는다', () => {
  assert.equal(speakableText('대한민국 (大韓民國) 의 역사', ON), '대한민국 의 역사')
  assert.equal(speakableText('대한민국 (大韓民國)', ON), '대한민국')
})

test('전각 괄호도 본다', () => {
  assert.equal(speakableText('학교（學校）에', ON), '학교에')
})

test('한자 사이의 띄어쓰기·가운뎃점·쉼표는 한자와 함께 뺀다', () => {
  assert.equal(speakableText('사군자(梅 蘭 菊 竹)를', ON), '사군자를')
  assert.equal(speakableText('사군자(梅·蘭·菊·竹)를', ON), '사군자를')
  assert.equal(speakableText('사군자(梅, 蘭)를', ON), '사군자를')
})

test('★한자가 아닌 것이 섞인 괄호는 건드리지 않는다 — 읽는 내용이다', () => {
  for (const s of ['학교(학교)에', '그해(1920년)에', '학교(學校, school)에', '(웃음)', '학교(學校 1)에']) {
    assert.equal(speakableText(s, ON), s, s)
  }
})

test('괄호 밖 한자는 이 설정이 다루지 않는다 — 지시가 괄호 속이다', () => {
  assert.equal(speakableText('人間은 생각한다.', ON), '人間은 생각한다.')
})

test('호환 한자·확장 한자도 한자로 본다', () => {
  assert.equal(speakableText('이(李)', ON), '이')      // 호환 한자
  assert.equal(speakableText('가(㐀)', ON), '가')      // 확장 A 첫 글자
  assert.equal(speakableText('나(鿿)', ON), '나')      // 통합 한자 끝
})

test('빼고 나서 남는 것이 없으면 빈 글 — 부르는 쪽이 건너뛴다', () => {
  assert.equal(speakableText('(一)', ON).trim(), '')
})

test('저장본을 믿지 않는다 — 모르는 값은 기본으로', () => {
  assert.deepEqual(parseReaderPrefs(null), DEFAULT_READER_PREFS)
  assert.deepEqual(parseReaderPrefs({ follow: 'yes', skipHanjaInParens: 1 }), DEFAULT_READER_PREFS)
  assert.deepEqual(parseReaderPrefs({ follow: false, skipHanjaInParens: true, fontSize: 18 }),
    { follow: false, skipHanjaInParens: true, fontSize: 18 })
})

test('★글자 크기 기본은 16 — 예전 19 는 크다는 지시', () => {
  assert.equal(DEFAULT_READER_PREFS.fontSize, 16)
  assert.equal(parseReaderPrefs({}).fontSize, 16, '예전 저장본(글자 크기 없음)도 16 으로 연다')
})

test('글자 크기는 범위 안으로만 — 모르는 값은 기본', () => {
  assert.equal(parseReaderPrefs({ fontSize: 99 }).fontSize, 24)
  assert.equal(parseReaderPrefs({ fontSize: 2 }).fontSize, 13)
  assert.equal(parseReaderPrefs({ fontSize: 17.6 }).fontSize, 18)
  assert.equal(parseReaderPrefs({ fontSize: '20' }).fontSize, 16)
  assert.equal(parseReaderPrefs({ fontSize: NaN }).fontSize, 16)
})

// ★기호를 소리 내지 않는다 (2026-09-30 사용자 신고: "' \" * 등을 소리 내려고 '에 에 에' 한다").
test('★따옴표·별표는 빼고 안의 글은 읽는다 — 설정과 무관하게 늘', () => {
  for (const p of [OFF, ON]) {
    assert.equal(speakableText('"누구세요?" 하고 그가 물었다.', p), '누구세요? 하고 그가 물었다.')
    assert.equal(speakableText("'설마…' 그는 생각했다.", p), '설마… 그는 생각했다.')
    assert.equal(speakableText('그건 *정말* 중요했다.', p), '그건 정말 중요했다.')
    assert.equal(speakableText('“좋아.” ‘그래.’ 「알았어」 『책』', p), '좋아. 그래. 알았어 책')
  }
})

test('웹소설 꾸밈 — 괄호류·기호는 빼고 내용만', () => {
  assert.equal(speakableText('[퀘스트 완료] <보상: 경험치> ※주의 ♡', OFF), '퀘스트 완료 보상: 경험치 주의')
  assert.equal(speakableText('아~ 그래~~', OFF), '아 그래')
  assert.equal(speakableText('10~20명이 왔다.', OFF), '10에서 20명이 왔다.')
})

test('★문장 부호·괄호·하이픈·영어 줄임말은 남긴다 — 쉼과 억양, 읽는 내용', () => {
  assert.equal(speakableText("그래, 좋아! 정말? 음… 그런데(웃음) e-mail 이야. I don't know.", OFF),
    "그래, 좋아! 정말? 음… 그런데(웃음) e-mail 이야. I don't know.")
  assert.equal(speakableText('50% 할인', OFF), '50% 할인')
})

test('★기호만 남은 줄은 소리 없이 건너뛴다 — 장면 구분 줄', () => {
  assert.equal(speakableText('* * *', OFF), '')
  assert.equal(speakableText('◆◇◆', OFF), '')
  assert.equal(speakableText('"……"', OFF), '')
})

test('괄호 속 한자 빼기와 함께 써도 된다', () => {
  assert.equal(speakableText('"학교(學校)에 가자."', ON), '학교에 가자.')
})
