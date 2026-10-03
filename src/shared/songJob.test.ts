// 노래 변환 계약 — **작업 폴더가 부딪히지 않는가, 결과를 덮지 않는가.**
//
// ★2026-09-27 지시:
//   1 "같은 곡을 연속 실행해도 충돌하지 않게 만든다"
//   3 "내부 키 '화음없이'는 사용자에게 '변환 음원'으로 표시한다"
//   5 "원곡·참조·생성 결과와 같은 파일로 저장하지 못하도록 검사한다. 경로 별칭도 고려한다"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  songWorkFolderName, safeFolderName, songRequestFault, songExportFault,
  guardedFilesOf, songEventFault, RESULT_LABEL, HARMONY_NOTE,
  type SongResult,
} from './songJob.ts'
import type { PathProbe } from './joinOutputGuard.ts'

const probeOf = (ids: Record<string, string> = {}, real: Record<string, string> = {}): PathProbe => ({
  real: (p) => real[p] ?? p,
  fileId: (p) => ids[p] ?? null,
})

// ── 1. 작업 폴더 ─────────────────────────────────────────────────────────
test('같은 곡을 같은 초에 두 번 눌러도 폴더가 부딪히지 않는다', () => {
  const a = songWorkFolderName('사랑.mp3', '20260927-101500', 'aaaaaaaa-1111')
  const b = songWorkFolderName('사랑.mp3', '20260927-101500', 'bbbbbbbb-2222')
  assert.notEqual(a, b, '시각만 붙이면 같은 초에 겹친다')
})

test('같은 요청이면 같은 폴더 이름이다', () => {
  const id = 'aaaaaaaa-1111'
  assert.equal(songWorkFolderName('사랑.mp3', '20260927-101500', id),
    songWorkFolderName('사랑.mp3', '20260927-101500', id))
})

test('폴더 이름에 쓸 수 없는 글자를 걷어낸다', () => {
  assert.equal(safeFolderName('a/b:c*d?.mp3'), 'abcd')
  assert.equal(safeFolderName('   '), '노래')
  assert.equal(safeFolderName('x'.repeat(80)).length, 40)
})

test('확장자를 뗀다 — 폴더 이름에 .mp3 가 남지 않는다', () => {
  assert.equal(safeFolderName('내노래.flac'), '내노래')
})

// ── 2. 요청 판정 ─────────────────────────────────────────────────────────
test('원곡과 목소리가 있어야 보낸다', () => {
  const s = { path: 'a.mp3', name: 'a', duration: 200 }
  const v = { path: 'b.wav', name: 'b', duration: 60 }
  assert.equal(songRequestFault({ source: s, voice: v }), '')
  assert.match(songRequestFault({ source: null, voice: v }), /원곡/)
  assert.match(songRequestFault({ source: s, voice: null }), /목소리/)
})

test('원곡과 목소리가 같은 파일이면 막는다', () => {
  const s = { path: 'C:/x/a.mp3', name: 'a', duration: 200 }
  const v = { path: 'C:\\x\\A.MP3', name: 'a', duration: 200 }
  assert.match(songRequestFault({ source: s, voice: v }), /같은 파일/)
})

// ── 3. 표시 이름 ─────────────────────────────────────────────────────────
test("'화음없이' 를 사용자에게 그대로 보여 주지 않는다", () => {
  assert.equal(RESULT_LABEL.mix, '변환 음원')
  assert.doesNotMatch(RESULT_LABEL.mix, /화음/)
})

test('화음을 완전히 제거했다고 말하지 않는다', () => {
  assert.match(HARMONY_NOTE, /따로 걷어내지 않/)
  assert.doesNotMatch(HARMONY_NOTE, /제거|없앴/)
})

// ── 4. 내보내기 — 덮으면 안 되는 것 ───────────────────────────────────────
const result = (): SongResult => ({
  clientRequestId: 'r1',
  input: {
    source: { path: 'D:/곡/원곡.mp3', name: '원곡', duration: 200 },
    voice: { path: 'D:/목소리/사람.wav', name: '사람', duration: 90 },
    splitLead: false,
  },
  mixPath: 'D:/작업/song/x/완성_화음없이_사람.wav',
  sourceAudioPath: 'D:/작업/song/x/source.wav',
  vocalPath: 'D:/작업/song/x/바뀐주보컬_사람.wav',
  reference: {
    clipPath: 'D:/작업/song/x/참조_abcd.wav', fromPath: 'D:/목소리/사람.wav',
    startSec: 12.5, durationSec: 8, wholeFile: false,
  },
  settings: {}, workDir: 'D:/작업/song/x',
})

test('다른 자리에 저장하는 것은 막지 않는다', () => {
  const r = result()
  assert.equal(songExportFault('D:/내보내기/결과.wav', guardedFilesOf(r), probeOf()), '')
})

test('원곡 위에 저장할 수 없다', () => {
  const r = result()
  const why = songExportFault('D:/곡/원곡.mp3', guardedFilesOf(r), probeOf())
  assert.match(why, /원곡/)
  assert.match(why, /저장할 수 없/)
})

test('목소리 원본 위에 저장할 수 없다', () => {
  const r = result()
  assert.match(songExportFault('D:/목소리/사람.wav', guardedFilesOf(r), probeOf()), /목소리/)
})

test('참조 클립 위에 저장할 수 없다', () => {
  const r = result()
  assert.match(songExportFault('D:/작업/song/x/참조_abcd.wav', guardedFilesOf(r), probeOf()), /참조 클립/)
})

test('생성 결과 위에 저장할 수 없다', () => {
  const r = result()
  assert.match(songExportFault(r.mixPath, guardedFilesOf(r), probeOf()), /변환 음원/)
  assert.match(songExportFault(r.vocalPath, guardedFilesOf(r), probeOf()), /변환 보컬만/)
})

// ★이름이 달라도 같은 파일이면 막는다.
test('대소문자·구분자만 다른 이름도 막는다', () => {
  const r = result()
  const win = 'D:' + String.fromCharCode(92) + '곡' + String.fromCharCode(92) + '원곡.MP3'
  assert.notEqual(songExportFault(win, guardedFilesOf(r), probeOf()), '')
})

test('이름이 달라도 파일 번호가 같으면 막는다(하드링크)', () => {
  const r = result()
  const probe = probeOf({ 'D:/딴이름.wav': 'dev:9', 'D:/곡/원곡.mp3': 'dev:9' })
  assert.match(songExportFault('D:/딴이름.wav', guardedFilesOf(r), probe), /원곡/)
})

test('상대 경로로 돌아와도 막는다', () => {
  const r = result()
  const probe = probeOf({}, { 'D:/작업/../곡/원곡.mp3': 'D:/곡/원곡.mp3' })
  assert.notEqual(songExportFault('D:/작업/../곡/원곡.mp3', guardedFilesOf(r), probe), '')
})

test('저장 자리가 비면 만들지 않는다', () => {
  assert.match(songExportFault('', guardedFilesOf(result()), probeOf()), /알 수 없/)
})

test('2차 가르기를 켠 결과도 목록에 들어간다', () => {
  const r = { ...result(), withHarmonyPath: 'D:/작업/song/x/완성_원래화음같이_사람.wav' }
  assert.equal(guardedFilesOf(r).length, 7)
  assert.match(songExportFault(r.withHarmonyPath!, guardedFilesOf(r), probeOf()), /원래 화음까지/)
})

// ★영상에서 꺼낸 비교용 원곡 소리 — 이것을 덮으면 원곡/변환본 비교가 깨진다.
test('비교용 원곡 소리 위에 저장할 수 없다', () => {
  const r = result()
  const why = songExportFault(r.sourceAudioPath, guardedFilesOf(r), probeOf())
  assert.match(why, /비교용 원곡 소리/)
  assert.match(why, /저장할 수 없/)
})

test('비교용 원곡 소리도 별칭으로 막는다', () => {
  const r = result()
  const probe = probeOf({ 'D:/딴이름.wav': 'dev:7', 'D:/작업/song/x/source.wav': 'dev:7' })
  assert.match(songExportFault('D:/딴이름.wav', guardedFilesOf(r), probe), /비교용 원곡 소리/)
})

// ── 5. 늦게 온 응답 ──────────────────────────────────────────────────────
test('내 요청의 응답만 받는다', () => {
  assert.equal(songEventFault({ clientRequestId: 'r1' }, 'r1'), '')
  assert.match(songEventFault({ clientRequestId: 'r2' }, 'r1'), /지난 요청/)
  assert.match(songEventFault({}, 'r1'), /식별자 없음/)
  assert.match(songEventFault({ clientRequestId: 'r1' }, ''), /기다리는 요청이 없/)
})
