// 개발툴 MCP 의 AudioForge 전용 규칙(tools/mcp/audioforge.cjs) — 앱을 띄우지 않고 규칙만 붙든다.
//
// ★가장 중요한 것은 개인정보 가드다(전역 정책: 사용자 음성·영상·이미지는 파일별·작업별 허락이 있을 때만).
//   MCP 는 AI 가 경로를 앱에 넘기는 창구라서, 검사용 자리 밖의 미디어 경로는 허락 표시 없이 통과하면 안 된다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const AF = require(path.join(ROOT, 'tools', 'mcp', 'audioforge.cjs'))
const TR = require(path.join(ROOT, 'tools', 'test-root.cjs'))   // 테스트 전용 폴더(_local/테스트)
const TEMP = path.join(TR.TEST_ROOT, TR.SUB.temp)
const session = { tmp: path.join(TEMP, 'mcp-test-session') }

test('★검사용 자리 밖 미디어 경로는 막는다 — 문자열 안에 묻혀 있어도', () => {
  for (const v of [
    'C:/Users/someone/Music/노래.mp3',
    ['D:\\개인\\목소리.wav'],
    { input: 'E:/Videos/clip.mp4' },
    'window.api.audio.getFileUrl("C:/Users/me/rec.m4a")',
    path.join(TEMP, '..', '..', 'resources', 'voice.wav'),   // .. 로 빠져나가기
  ]) assert.throws(() => AF.guardMedia(v, session, false), /허락/, JSON.stringify(v))
})

test('검사용 자리 안 · 미디어가 아닌 파일 · 허락 표시는 통과한다', () => {
  for (const v of [
    path.join(ROOT, 'test', 'fixtures', 'audio', 'ko-speech-region-18s.wav'),
    path.join(TEMP, 'x', 'a.wav'),
    path.join(session.tmp, 'inputs', '말소리-1.wav'),
    'C:/Users/someone/Documents/책.txt',
    { method: 'settings.get' },
  ]) assert.doesNotThrow(() => AF.guardMedia(v, session, false), JSON.stringify(v))
  assert.doesNotThrow(() => AF.guardMedia('C:/Users/someone/Music/노래.mp3', session, true), '허락 표시(userApproved)')
})

test('소리 수치 — 만든 사인파의 참값과 맞는다', () => {
  const dir = path.join(TEMP, 'mcp-contract')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'tone.wav')
  AF.writeTone(f, 1.5, 440)
  const r = AF.inspectWav(f)
  assert.equal(r.seconds, 1.5)
  assert.equal(r.sampleRate, 24000)
  assert.ok(Math.abs(r.peakDbfs - -10.46) < 0.1, String(r.peakDbfs))          // 진폭 0.3
  assert.ok(Math.abs(r.rmsDbfs - -13.47) < 0.2, String(r.rmsDbfs))            // 0.3/√2
  assert.equal(r.clippedSamples, 0)
  assert.equal(r.silentRatio, 0)
  assert.equal(r.empty, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('WAV 가 아니면 사유를 말한다', () => {
  const dir = path.join(TEMP, 'mcp-contract2')
  fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'x.wav')
  fs.writeFileSync(f, 'not a wav')
  assert.throws(() => AF.inspectWav(f), /WAV 가 아닙니다/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('화면 지도는 실제 작업 목록과 같다(ModeSelector)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'components', 'ModeSelector.tsx'), 'utf8')
  for (const id of Object.keys(AF.MODES)) assert.ok(src.includes(`${/-/.test(id) ? `'${id}'` : id}: { label: '${AF.MODES[id]}'`), `${id}(${AF.MODES[id]}) 가 ModeSelector 에 없다 — 화면이 바뀌면 지도도 고친다`)
})
