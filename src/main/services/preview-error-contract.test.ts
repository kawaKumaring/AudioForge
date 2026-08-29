// 참조 구간 오류 계약 회귀 — 구조화 오류가 문자열로 뭉개져 UI가 사유를 잃던 결함.
//
// 실사용 실패: 구간 확정 시 Python 이 REFERENCE_REGION_BLOCKED + blocking 을 구조화로 보냈는데,
// runPreview 의 error 콜백이 `String(msg)` 로 객체를 [object Object] 로 만들어 버려서
// renderer 는 metrics 를 못 찾고 "형식 불일치"만 표시했다. 실제 차단 사유가 사라진다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPreview, type PreviewRunnerLike } from './preview-transcribe.ts'

// 러너 흉내 — on 으로 받은 콜백을 테스트가 직접 발화시킨다(실제 EventEmitter 계약과 동형).
function fakeRunner() {
  const handlers: Record<string, ((a?: unknown) => void)[]> = {}
  return {
    runner: {
      on(ev: string, cb: (a?: unknown) => void) { (handlers[ev] ??= []).push(cb) },
      run() { /* 발화는 테스트가 한다 */ },
      cancel() { /* noop */ },
    } as PreviewRunnerLike,
    emit(ev: string, arg?: unknown) { (handlers[ev] ?? []).forEach(cb => cb(arg)) },
  }
}

function opts(runner: PreviewRunnerLike) {
  return {
    runner, scriptPath: 's.py', args: [], timeoutMs: 10_000,
    cleanup: () => {},
    setTimeoutFn: (_fn: () => void, _ms: number) => 1 as unknown,
    clearTimeoutFn: (_h: unknown) => {},
  }
}

test('구조화 차단 오류의 code·blocking·구간이 보존된다(문자열로 뭉개지지 않음)', async () => {
  const f = fakeRunner()
  const p = runPreview(opts(f.runner))
  f.emit('error', {
    message: '구간이 승인되지 않았습니다.',
    code: 'REFERENCE_REGION_BLOCKED',
    blocking: ['REGION_HEAD_TRUNCATED'],
    requested_region: { start_sec: 1, dur_sec: 9 },
    effective_region: { start_sec: 1, dur_sec: 9 },
    validation: { ready: false },
  })
  f.emit('done')
  const res = await p
  assert.equal(res.status, 'failed')
  assert.equal(res.code, 'REFERENCE_REGION_BLOCKED')
  assert.deepEqual(res.blocking, ['REGION_HEAD_TRUNCATED'])
  assert.ok(res.effective_region, 'effective_region 보존')
  // 예전 결함의 지문 — 이게 남아 있으면 사유가 사라진 것이다.
  assert.notEqual(res.error_message, '[object Object]')
})

test('snap 재확정 코드도 보존된다', async () => {
  const f = fakeRunner()
  const p = runPreview(opts(f.runner))
  f.emit('error', {
    message: '구간을 옮겨야 합니다.',
    code: 'REFERENCE_REGION_BLOCKED',
    blocking: ['REGION_SNAP_RECONFIRM_REQUIRED'],
    snap: { moved_sec: 1.4 },
  })
  f.emit('done')
  const res = await p
  assert.deepEqual(res.blocking, ['REGION_SNAP_RECONFIRM_REQUIRED'])
  assert.ok(res.snap, 'snap 보존')
})

test('문자열 오류는 기존 의미 그대로(하위 호환)', async () => {
  const f = fakeRunner()
  const p = runPreview(opts(f.runner))
  f.emit('error', '전사 실패: 파일을 읽을 수 없습니다')
  f.emit('done')
  const res = await p
  assert.equal(res.status, 'failed')
  assert.equal(res.error_message, '전사 실패: 파일을 읽을 수 없습니다')
  assert.equal(res.code, undefined)
})

test('허용 목록 밖 필드(경로·전사 원문)는 renderer 로 넘기지 않는다', async () => {
  const f = fakeRunner()
  const p = runPreview(opts(f.runner))
  f.emit('error', {
    message: '차단',
    code: 'REFERENCE_REGION_BLOCKED',
    blocking: ['REGION_TOO_SHORT'],
    clip_path: 'E:/secret/user/voice.wav',
    transcript_text: '사용자 대사 원문',
    stack: 'Traceback ...',
  })
  f.emit('done')
  const res = await p
  assert.equal(res.clip_path, undefined, '절대경로 미노출')
  assert.equal(res.transcript_text, undefined, '전사 원문 미노출')
  assert.equal(res.stack, undefined, '스택 미노출')
  assert.equal(res.code, 'REFERENCE_REGION_BLOCKED')
})

test('전사 미리보기 성공 계약 불변(transcript 래핑 유지)', async () => {
  const f = fakeRunner()
  const p = runPreview(opts(f.runner))
  f.emit('result', { type: 'result', transcript: { status: 'ok', text: 'x', language: 'ko' } })
  f.emit('done')
  const res = await p
  assert.equal(res.status, 'ok')
  assert.equal(res.language, 'ko')
})
