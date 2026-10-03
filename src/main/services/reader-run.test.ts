import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { createLane, jsonLines, pythonReason, madeTrack, failureReason, readerRunConfig, testSkipsPrep, QWEN_REF_REPO_DIR, QWEN_REF_REVISION } from './reader-run.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('★줄은 한 번에 하나만 돌린다 — 동시에 돌면 같은 자리에 쓰다가 하나가 죽었다', async () => {
  const lane = createLane()
  let running = 0, most = 0
  const job = (ms: number) => async () => { running++; most = Math.max(most, running); await sleep(ms); running--; return ms }
  const got = await Promise.all([lane(job(30)), lane(job(5)), lane(job(10))])
  assert.deepEqual(got, [30, 5, 10], '차례가 뒤섞였다')
  assert.equal(most, 1, `동시에 ${most}개가 돌았다`)
})

test('앞 작업이 실패해도 다음 차례는 돈다', async () => {
  const lane = createLane()
  const a = lane(async () => { throw new Error('앞 실패') })
  const b = lane(async () => '다음')
  await assert.rejects(a, /앞 실패/)
  assert.equal(await b, '다음')
})

test('★참조 목소리는 그 파일을 입력으로 넘긴다 — 비우면 파이썬이 곧바로 거절했다', () => {
  const c = readerRunConfig('글', { kind: 'reference', path: 'E:/v/a.wav' }, 'E:/w/run-1')
  assert.equal(c.input, 'E:/v/a.wav')
  assert.equal(c.ttsReferenceOverride, 'E:/v/a.wav')
  assert.equal(c.ttsBuiltinModel, undefined)
})

test('기본 목소리는 입력을 비우고 모델을 넘긴다', () => {
  const c = readerRunConfig('글', { kind: 'builtin', path: 'E:/m/ko.onnx', engineId: 'piper' }, 'E:/w/run-2')
  assert.equal(c.input, '')
  assert.equal(c.ttsBuiltinModel, 'E:/m/ko.onnx')
  assert.equal(c.ttsEngine, 'piper')
  assert.equal(c.output, 'E:/w/run-2', '작업마다 제 폴더에 쓴다')
})

test('파이썬이 말한 사유를 읽는다 — 마지막 오류 한 줄', () => {
  const lines = jsonLines('진행 중\n{"type":"progress","p":1}\n{"type":"error","message":"첫째"}\n{"type":"error","message":"둘째"}\n')
  assert.equal(pythonReason(lines), '둘째')
  assert.equal(pythonReason(jsonLines('')), '')
})

test('만들어진 소리 파일을 찾는다', () => {
  const lines = jsonLines('{"type":"result","tracks":[{"path":"E:/w/a.wav"}]}\n{"type":"done"}')
  assert.equal(madeTrack(lines), 'E:/w/a.wav')
  assert.equal(madeTrack(jsonLines('{"tracks":[]}')), '')
})

test('★실패하면 명령줄이 아니라 파이썬의 사유를 보인다 — 경로는 파일 이름만', () => {
  // 사용자 화면에 붉게 번쩍였던 것 — 실행 명령줄 전체.
  const err = {
    message: 'Command failed: E:\\AI\\ComfyUI_windows_portable_python3.12\\python_embeded\\python.exe -X utf8 E:\\x\\python\\separate.py --config E:\\x\\readerChunks\\work\\chunk-1.json',
    stdout: '{"type":"error","message":"[WinError 32] 다른 프로세스가 파일을 사용 중이기 때문에 프로세스가 액세스 할 수 없습니다: \'E:\\\\x\\\\readerChunks\\\\work\\\\synthesized.wav\'"}\n',
  }
  const shown = failureReason(err)
  assert.ok(!/Command failed/.test(shown), shown)
  assert.ok(!/[A-Za-z]:[\\/]/.test(shown), `폴더 경로가 남았다: ${shown}`)
  assert.match(shown, /다른 프로세스가 파일을 사용 중/)
})

test('파이썬이 아무 말 없이 죽으면 일반 문구 — 명령줄은 보이지 않는다', () => {
  const shown = failureReason({ message: 'Command failed: E:\\py.exe x.py', stdout: '' })
  assert.equal(shown, '이 부분을 소리로 만들지 못했습니다')
})

test('우리가 던진 문구는 그대로 보인다', () => {
  assert.equal(failureReason(new Error('파이썬을 찾지 못했습니다')), '파이썬을 찾지 못했습니다')
})

test('시간 초과는 그렇다고 말한다', () => {
  assert.equal(failureReason({ killed: true, message: 'Command failed: …' }), '너무 오래 걸려 멈췄습니다')
})

test('검사 모드는 미리 준비를 끄고, 보통 준비(AF_E2E_NORMAL_PREP)·GPU 검사는 끄지 않는다(2026-10-03)', () => {
  assert.equal(testSkipsPrep({}), false, '보통 실행은 끄지 않는다')
  assert.equal(testSkipsPrep({ AF_E2E: '1' }), true)
  assert.equal(testSkipsPrep({ AF_E2E: '1', AF_E2E_NORMAL_PREP: '1' }), false)
  assert.equal(testSkipsPrep({ AF_E2E: '1', AF_E2E_GPU: '1' }), false)
})

test('미리 여는 참조 목소리 모델 = 합성 프로세스가 쓰는 고정판(tts_worker)', async () => {
  const { readFileSync } = await import('node:fs')
  const py = readFileSync(new URL('../../../python/tts_worker.py', import.meta.url), 'utf-8')
  assert.ok(py.includes(`_QWEN_REVISION = "${QWEN_REF_REVISION}"`), '고정판(revision)이 갈렸다')
  assert.ok(py.includes('"' + QWEN_REF_REPO_DIR + '"'), '모델 자리 이름이 갈렸다')
})
