// 로그 세척 계약 — **무엇을 지우고 무엇을 남기는가.**
//
// ★왜(2026-09-24 2차 감사): 진단 묶음이 로그를 통째로 복사하는데, 그 로그에는
//   Electron·Node 가 스스로 찍은 명령줄과 스택이 원문 그대로 들어 있었다.
//   ffprobe 가 한 번 실패한 날의 로그에는 사용자 음원의 절대 경로가 남는다.
//
// ★재료를 글자로 조립한다: 역슬래시가 소스를 오갈 때 한 겹 먹혀 **검사 재료가
//   조용히 UNC 가 아니게 되는 일**을 실제로 겪었다(그때 검사는 통과했다).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrubPathsForLog, hasAbsolutePath } from './log-scrub.ts'

const B = String.fromCharCode(92)           // 역슬래시 한 글자
const p = (...parts: string[]) => parts.join(B)

test('드라이브 경로는 폴더를 지우고 이름만 남긴다', () => {
  const s = scrubPathsForLog('Command failed: ' + p('E:', '작업', '더빙', '2026', '면담_원본.wav'))
  assert.ok(s.includes('면담_원본.wav'), '무슨 파일인지는 남아야 진단이 된다')
  assert.ok(!s.includes('작업'), `폴더가 남았다: ${s}`)
  assert.ok(!s.includes('더빙'), `폴더가 남았다: ${s}`)
})

// ★예전 규칙은 공백에서 끊겨 폴더 이름이 그대로 남았다.
test('공백이 든 폴더 이름도 지운다 — 예전 규칙이 못 잡던 것', () => {
  const s = scrubPathsForLog('열 수 없음: ' + p('E:', '내 작업', '면담 원본.wav'))
  assert.ok(!s.includes('내 작업'), `공백 폴더가 남았다: ${s}`)
  assert.ok(s.includes('면담 원본.wav'), `이름까지 지웠다: ${s}`)
})

// ★UNC 는 드라이브 문자로 시작하지 않아 예전 규칙이 아예 못 봤다.
test('UNC 경로도 지운다', () => {
  const s = scrubPathsForLog('ENOENT: ' + B + p('', '사내서버', '공유', '녹음', 'a.wav'))
  assert.ok(!s.includes('사내서버'), `서버 이름이 남았다: ${s}`)
  assert.ok(!s.includes('공유'), `공유 이름이 남았다: ${s}`)
  assert.ok(s.includes('a.wav'))
})

test('file:// 도 지운다 — 드라이브가 붙은 것과 서버 이름 둘 다', () => {
  const a = scrubPathsForLog('did-fail-load url=file:///E:/비밀폴더/index.html')
  assert.ok(!a.includes('비밀폴더'), a)
  assert.ok(a.includes('index.html'))
  const b = scrubPathsForLog('url=file://사내서버/공유/a.wav')
  assert.ok(!b.includes('사내서버'), b)
  assert.ok(b.includes('a.wav'))
})

test('POSIX 절대 경로도 지운다', () => {
  const s = scrubPathsForLog('ENOENT: /home/someone/작업/a.wav')
  assert.ok(!s.includes('someone'), s)
  assert.ok(s.includes('a.wav'))
})

// ★전부 지우면 '무엇이 실패했는지' 까지 사라진다 — 그러면 로그가 쓸모없어져 결국 꺼진다.
test('명령 이름은 남는다 — 진단 가치를 죽이지 않는다', () => {
  const s = scrubPathsForLog(
    'Command failed: ' + p('C:', '앱', 'bin', 'ffprobe.exe') + ' -of json ' + p('E:', '소리', 'a.wav'))
  assert.ok(s.includes('ffprobe.exe'), `무엇이 실패했는지가 사라졌다: ${s}`)
  assert.ok(!s.includes('소리'), s)
  assert.ok(!s.includes('앱'), s)
})

// ★한 줄에 경로가 둘이면 한 번 훑는 것으로는 뒤 경로가 남았다(실측).
test('한 줄에 경로가 여럿이어도 전부 지운다', () => {
  const s = scrubPathsForLog(
    p('E:', '소리', 'a.wav') + ' -of json ' + p('C:', '비밀', 'b.wav'))
  assert.ok(!s.includes('비밀'), `뒤 경로가 남았다: ${s}`)
  assert.ok(!s.includes('소리'), s)
  assert.equal(hasAbsolutePath(s), false, s)
})

test('여러 줄 스택도 전부 씻는다', () => {
  const s = scrubPathsForLog([
    'Error: ENOENT',
    '    at Object.openSync (' + p('E:', 'AI', '앱', 'node_modules', 'fs.js:1') + ')',
    '    at read (' + p('E:', '사용자작업', '녹음.wav') + ')',
  ].join('\n'))
  assert.ok(!s.includes('사용자작업'), s)
  assert.ok(!s.includes('node_modules'), s)
  assert.ok(s.includes('녹음.wav'))
})

test('경로가 없는 문구는 건드리지 않는다', () => {
  const t = '합성을 시작하지 못했습니다(GPU 메모리 부족)'
  assert.equal(scrubPathsForLog(t), t)
})

test('빈 값도 견딘다', () => {
  assert.equal(scrubPathsForLog(''), '')
  assert.equal(hasAbsolutePath(''), false)
})

test('남았는지 보는 눈이 세척 결과에 만족한다', () => {
  for (const raw of [
    p('E:', '작업', 'a.wav'),
    B + p('', '서버', '공유', 'a.wav'),
    'file:///E:/x/a.wav',
    'file://서버/공유/a.wav',
    '/home/u/x/a.wav',
  ]) {
    assert.equal(hasAbsolutePath(raw), true, `못 봤다: ${raw}`)
    const cleaned = scrubPathsForLog(raw)
    assert.equal(hasAbsolutePath(cleaned), false, `씻었는데 아직 경로로 보인다: ${cleaned}`)
  }
})
