import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDubSession } from './dubSession.ts'
import { dubSteps } from '../../shared/dubSteps.ts'

test('더빙 메뉴 재진입은 영상·편집·소리·내보낸 결과와 진행단계를 유지한다', () => {
  const session = createDubSession()
  const front = { outDir: 'work', language: 'en', emptyIndexes: [], lines: [
    { index: 0, start: 0, end: 1, source: 'hello', korean: '안녕' },
  ] }
  const report = { video: 'out.mp4', srt: 'out.srt', lines: [], summary: {
    total: 1, fit: 1, stretched: 0, over: 0, overIndexes: [], missingIndexes: [],
    worstOverflowSec: 0, maxRatioUsed: 1, trimmed: 0,
  } }
  session.write({ ...session.read(), videoPath: 'in.mp4', workDir: 'work', front,
    edits: { 0: '안녕하세요' }, takes: { 0: 'take.wav' }, tailCut: { 0: false }, report,
    voice: { path: 'voice.wav', ref: { clip: 'voice-clip.wav', region: null }, message: '' },
    register: 'polite',
  })
  const reentered = session.read()
  assert.equal(reentered.videoPath, 'in.mp4')
  assert.equal(reentered.edits[0], '안녕하세요')
  assert.equal(reentered.takes[0], 'take.wav')
  assert.equal(reentered.report?.video, 'out.mp4')
  assert.equal(reentered.voice.ref?.clip, 'voice-clip.wav')
  assert.equal(reentered.register, 'polite')
  assert.equal(dubSteps({ video: !!reentered.videoPath, voice: !!reentered.voice.ref,
    front: !!reentered.front, made: Object.keys(reentered.takes).length,
    lines: reentered.front?.lines.length ?? 0 }).find((step) => step.active)?.key, 'render')
})

test('세션은 현재 작업 하나만 교체하고 busy·재생·대기 상태는 보존하지 않는다', () => {
  const session = createDubSession()
  const withTransient = { ...session.read(), videoPath: 'first.mp4', busy: 'synth',
    playIndex: 0, pending: () => {}, error: 'old', note: '만드는 중' }
  session.write(withTransient)
  for (const key of ['busy', 'playIndex', 'pending', 'error', 'note']) {
    assert.equal(key in session.read(), false)
  }
  session.write({ ...session.read(), videoPath: 'second.mp4', front: null, takes: {} })
  assert.equal(session.read().videoPath, 'second.mp4')
  assert.equal(createDubSession().read().videoPath, '', '새 앱 세션은 이전 경로를 자동 복원하지 않는다')
})

test('더빙 화면은 세션을 읽고 변경 내용을 저장하며 transient 상태는 새로 시작한다', () => {
  const source = readFileSync(new URL('../components/DubWorkspace.tsx', import.meta.url), 'utf8')
  assert.ok(source.includes('useRef(dubSession.read()).current'))
  for (const field of ['videoPath', 'workDir', 'workRoot', 'front', 'edits', 'takes', 'tailCut', 'report', 'voice', 'register']) {
    assert.ok(source.includes(`restored.${field}`), `${field} 복원 누락`)
  }
  assert.ok(source.includes('dubSession.write({ videoPath, workDir, workRoot, front, edits, takes, tailCut, report, voice, register })'))
  assert.ok(source.includes("useState<Busy>('')"))
  assert.ok(source.includes('useState<number | null>(null)'))
})
