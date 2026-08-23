// Python 종료 진단 회귀 테스트 — node:test, 순수 함수(spawn/GPU/미디어 0).
// G3 근본: 무해 경고(RequestsDependencyWarning)를 실패 원인으로 표면화하던 결함 방지.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diagnoseExit, type ExitReason } from './runner-diagnostics.ts'

const WARN =
  'E:/AI/py/site-packages/requests/__init__.py:109: RequestsDependencyWarning: urllib3 (2.0.0) ...\n' +
  '  warnings.warn(...)\n' +
  'C:/py/lib/site-packages/torch/x.py:5: FutureWarning: deprecated soon\n'

const ABS_PATH = "E:/사용자/비밀/절대경로/input.wav"

// 공통: renderer로 나가는 payload(userMessage)에 절대경로/traceback/raw 예외 메시지가 없어야 한다.
function assertRendererSafe(userMessage: string) {
  assert.ok(!userMessage.includes(ABS_PATH), 'userMessage에 절대경로 없음')
  assert.ok(!/[A-Za-z]:[\\/]/.test(userMessage), 'userMessage에 드라이브 경로 없음')
  assert.ok(!userMessage.includes('Traceback'), 'userMessage에 traceback 없음')
  assert.ok(!userMessage.includes('site-packages'), 'userMessage에 raw 스택 경로 없음')
  assert.ok(!/sha8|stderr\.len/.test(userMessage), 'userMessage에 sha8/length 없음')
}

test('① warning-only + exit 0 → null (표면화 안 함)', () => {
  const d = diagnoseExit({ code: 0, signal: null, stderr: WARN, hadStructuredError: false, hadStructuredResult: false })
  assert.equal(d, null)
})

test('① warning-only + nonzero exit 0가 아닌 경우는 ③에서 다룸 — 여기선 exit 0 확정', () => {
  const d = diagnoseExit({ code: 0, signal: null, stderr: '', hadStructuredError: false, hadStructuredResult: false })
  assert.equal(d, null)
})

test('② warning + 구조화 error → null (구조화 신호 권위, 이중 emit 금지)', () => {
  const d = diagnoseExit({ code: 1, signal: null, stderr: WARN, hadStructuredError: true, hadStructuredResult: false })
  assert.equal(d, null)
})

test('② 구조화 result 있으면 nonzero라도 null (result 권위)', () => {
  const d = diagnoseExit({ code: 1, signal: null, stderr: WARN, hadStructuredError: false, hadStructuredResult: true })
  assert.equal(d, null)
})

test('③ nonzero + 무해(경고뿐) → PYTHON_PROCESS_ABNORMAL_EXIT, 경고문구 미포함', () => {
  const d = diagnoseExit({ code: 3, signal: null, stderr: WARN, hadStructuredError: false, hadStructuredResult: false })
  assert.ok(d)
  const code: ExitReason = d!.reasonCode
  assert.equal(code, 'PYTHON_PROCESS_ABNORMAL_EXIT')
  assert.ok(d!.userMessage.includes('3'), '종료 코드 포함')
  assert.ok(!d!.userMessage.includes('RequestsDependencyWarning'), '경고 이름 미표면화')
  assert.ok(!d!.userMessage.includes('FutureWarning'))
  assertRendererSafe(d!.userMessage)
})

test('④ traceback + nonzero → PACKAGE_MISSING (경로/raw 없음, devLog에만 상세)', () => {
  const stderr =
    WARN +
    'Traceback (most recent call last):\n' +
    `  File "${ABS_PATH}", line 12, in <module>\n` +
    '    import qwen_omni\n' +
    "ModuleNotFoundError: No module named 'qwen_omni'\n"
  const d = diagnoseExit({ code: 1, signal: null, stderr, hadStructuredError: false, hadStructuredResult: false })
  assert.ok(d)
  assert.equal(d!.reasonCode, 'PACKAGE_MISSING')
  assertRendererSafe(d!.userMessage)
  assert.ok(!d!.userMessage.includes('qwen_omni'), 'raw 모듈명(예외 메시지) 미포함')
  // devLog(로컬 전용)에는 상세가 담겨야 한다.
  assert.ok(d!.devLog.includes('ModuleNotFoundError'), 'devLog에 예외 타입')
  assert.ok(/sha8=/.test(d!.devLog), 'devLog에 sha8')
})

test('④ FileNotFoundError + nonzero → INPUT_FILE_MISSING, 절대경로 renderer 미노출', () => {
  const stderr =
    'Traceback (most recent call last):\n' +
    `FileNotFoundError: [Errno 2] No such file or directory: '${ABS_PATH}'\n`
  const d = diagnoseExit({ code: 2, signal: null, stderr, hadStructuredError: false, hadStructuredResult: false })
  assert.ok(d)
  assert.equal(d!.reasonCode, 'INPUT_FILE_MISSING')
  assertRendererSafe(d!.userMessage)
  // 절대경로는 devLog(로컬)에는 stderr tail로 존재하지만 userMessage에는 없다.
  assert.ok(d!.devLog.includes(ABS_PATH), 'devLog(로컬)에는 상세 경로 보존')
})

test('④ RuntimeError는 경고로 오분류되지 않고 PYTHON_RUNTIME_ERROR', () => {
  const stderr =
    'Traceback (most recent call last):\n' +
    'RuntimeError: CUDA out of memory\n'
  const d = diagnoseExit({ code: 1, signal: null, stderr, hadStructuredError: false, hadStructuredResult: false })
  assert.ok(d)
  assert.equal(d!.reasonCode, 'PYTHON_RUNTIME_ERROR')
  assert.ok(d!.userMessage.includes('RuntimeError'), '예외 타입명은 안전하므로 포함 허용')
  assert.ok(!d!.userMessage.includes('CUDA out of memory'), 'raw 예외 메시지 미포함')
})

test('⑤ signal 종료(code null) → PYTHON_PROCESS_SIGNAL', () => {
  const d = diagnoseExit({ code: null, signal: 'SIGKILL', stderr: WARN, hadStructuredError: false, hadStructuredResult: false })
  assert.ok(d)
  assert.equal(d!.reasonCode, 'PYTHON_PROCESS_SIGNAL')
  assert.ok(d!.userMessage.includes('SIGKILL'))
  assertRendererSafe(d!.userMessage)
})

test('경계: code null + signal 없음 → null (settlement가 마감)', () => {
  const d = diagnoseExit({ code: null, signal: null, stderr: '', hadStructuredError: false, hadStructuredResult: false })
  assert.equal(d, null)
})
