// 만든 것을 어디에 쌓는가 — **원본 경로에 휘둘리지 않는가.**
//
// 이 검사가 붙드는 것: 영상을 목소리로 쓰면 화면이 '꺼낸 wav' 를 건네는데,
// 그때도 결과가 C 드라이브 중간 폴더로 새지 않아야 한다.
import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import {
  planOutputDir, featureFolder, safeSegment, dayFolder, timeStamp, outputRootNotice,
  OUTPUT_ROOT_DIRNAME,
// @ts-ignore TS5097
} from './outputLayout.ts'

const AT = new Date(2026, 8, 28, 14, 5, 32)     // 2026-09-28 14:05:32
const none = () => false
const APP = 'E:/AI_Project/app/develop-run'

test('기본은 앱 자리 — 기능과 날짜로 갈라 모은다', () => {
  const p = planOutputDir({
    place: 'app', chosenRoot: '', appRoot: APP, sourceDir: '',
    mode: 'tts', name: '인터뷰', at: AT, exists: none,
  })
  assert.equal(p.dir, `${APP}/${OUTPUT_ROOT_DIRNAME}/음성합성/2026-09-28/14-05-32_인터뷰`)
})

test('★꺼낸 wav 의 폴더를 건네도 결과가 그쪽으로 새지 않는다', () => {
  // 이것이 이번 결함의 모양이다 — 화면이 원본 대신 중간 산출물을 건넸다.
  const p = planOutputDir({
    place: 'app', chosenRoot: '', appRoot: APP,
    sourceDir: 'C:/Users/me/AppData/Roaming/audio-forge/cardmedia/abc123',
    mode: 'tts', name: '인터뷰', at: AT, exists: none,
  })
  assert.ok(!p.dir.startsWith('C:/'), `C 드라이브로 샜다: ${p.dir}`)
  assert.ok(p.dir.startsWith(APP))
})

test('고른 자리가 있으면 그쪽이 이긴다 — 구조는 같다', () => {
  const p = planOutputDir({
    place: 'chosen', chosenRoot: 'D:/내작업', appRoot: APP, sourceDir: '',
    mode: 'music', name: '노래', at: AT, exists: none,
  })
  assert.equal(p.dir, `D:/내작업/${OUTPUT_ROOT_DIRNAME}/음악분리/2026-09-28/14-05-32_노래`)
})

test('체크하면 원본 옆 — 예전 모양 그대로(기능·날짜 칸을 끼우지 않는다)', () => {
  // 본체가 `<원본폴더>/AudioForge_output/*/session.json` 을 보므로 모양을 바꾸면 옛 작업을 못 찾는다.
  const p = planOutputDir({
    place: 'beside', chosenRoot: '', appRoot: APP, sourceDir: 'F:/음원/인터뷰',
    mode: 'tts', name: '인터뷰', at: AT, exists: none,
  })
  assert.equal(p.dir, `F:/음원/인터뷰/${OUTPUT_ROOT_DIRNAME}/14-05-32_인터뷰`)
  assert.ok(!p.dir.includes('음성합성'))
  assert.ok(!p.dir.includes('2026-09-28'))
})

test('★원본 옆을 골랐는데 원본 자리를 모르면 앱 자리로 물러난다', () => {
  // 조용히 C 로 가지 않는다 — 모르면 안전한 자리에 둔다.
  const p = planOutputDir({
    place: 'beside', chosenRoot: '', appRoot: APP, sourceDir: '',
    mode: 'tts', name: '기본목소리', at: AT, exists: none,
  })
  assert.ok(p.dir.startsWith(`${APP}/${OUTPUT_ROOT_DIRNAME}/음성합성/`))
})

test('고른 자리를 골랐는데 비어 있으면 앱 자리로 물러난다', () => {
  const p = planOutputDir({
    place: 'chosen', chosenRoot: '   ', appRoot: APP, sourceDir: '',
    mode: 'split', name: 'x', at: AT, exists: none,
  })
  assert.ok(p.dir.startsWith(`${APP}/${OUTPUT_ROOT_DIRNAME}/트랙분할/`))
})

test('같은 초에 두 번 시작해도 앞엣것을 덮지 않는다', () => {
  const taken = new Set([`${APP}/${OUTPUT_ROOT_DIRNAME}/음성합성/2026-09-28/14-05-32_같은이름`])
  const p = planOutputDir({
    place: 'app', chosenRoot: '', appRoot: APP, sourceDir: '',
    mode: 'tts', name: '같은이름', at: AT, exists: (x) => taken.has(x),
  })
  assert.equal(p.dir.endsWith('14-05-32_같은이름_2'), true, p.dir)
})

test('기능 이름은 사람이 읽는 말로', () => {
  assert.equal(featureFolder('tts'), '음성합성')
  assert.equal(featureFolder('music'), '음악분리')
  assert.equal(featureFolder('conversation'), '대화분리')
  assert.equal(featureFolder('dialogue-rebuild'), '대화분리')   // 같은 기능은 같은 폴더
  assert.equal(featureFolder('transcribe'), '텍스트추출')
  assert.equal(featureFolder('split'), '트랙분할')
  assert.equal(featureFolder('song'), '노래변환')
  assert.equal(featureFolder(''), '기타')
})

test('폴더 이름이 경로로 새지 않는다', () => {
  assert.equal(safeSegment('a/b'), 'a_b')
  assert.equal(safeSegment('a:b*c?'), 'a_b_c_')
  assert.equal(safeSegment('..\\..\\위'), '.._.._위')
  assert.equal(safeSegment('끝에점...'), '끝에점')       // 윈도우가 잘라 버린다
  assert.equal(safeSegment('끝에공백   '), '끝에공백')
  assert.equal(safeSegment('x'.repeat(200)).length, 80)
})

test('날짜와 시각 모양', () => {
  assert.equal(dayFolder(new Date(2026, 0, 3)), '2026-01-03')
  assert.equal(timeStamp(new Date(2026, 0, 3, 7, 8, 9)), '07-08-09')
})

test('어디에 쌓이는지 한 줄로 말한다', () => {
  assert.match(outputRootNotice('beside', ''), /원본 파일 옆/)
  assert.match(outputRootNotice('chosen', 'D:/x'), /D:\/x/)
  assert.match(outputRootNotice('app', `${APP}/AudioForge_output`), /앱 자리/)
})
