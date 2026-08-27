// 실패 문구 선택 테스트 — 실패 '판정'이 아니라 '설명'만 다룬다.
//
// 지키는 것:
//   · 경고는 실패를 만들지 않고, 실패 문구도 되지 않는다
//   · 진짜 예외(ModuleNotFoundError·ImportError·traceback)는 절대 숨기지 않는다
//   · 안전하게 고를 것이 없으면 지어내지 않고 호출부가 exit code 문구를 쓰게 한다
//   · 사용자 문구에 절대 경로가 남지 않는다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPythonErrorMessage } from './python-runner.ts'

// 실제로 관측된 경고 모양(외부 패키지 import 단계에서 stderr 로 나온다).
const WARNING_ONLY = [
  '  import pynvml  # type: ignore[import]',
  'E:\\AI\\ComfyUI_windows_portable_python3.12\\python_embeded\\Lib\\site-packages\\requests\\__init__.py:113: RequestsDependencyWarning: urllib3 (2.6.3) or chardet (7.4.0.post2)/charset_normalizer (3.4.5) doesn\'t match a supported version!',
  '  warnings.warn(',
].join('\n')

test('경고만 있으면 문구 후보가 없다 → 호출부가 exit code 문구를 쓴다', () => {
  assert.equal(selectPythonErrorMessage(WARNING_ONLY), '')
  assert.equal(selectPythonErrorMessage(''), '')
  assert.equal(selectPythonErrorMessage('   \n  \n'), '')
})

test('경고 + 실제 traceback → 경고가 아니라 진짜 예외를 고른다', () => {
  const stderr = [
    WARNING_ONLY,
    'Traceback (most recent call last):',
    '  File "E:\\AI\\...\\python\\separate.py", line 412, in main',
    '    run_tts(cfg)',
    '  File "E:\\AI\\...\\python\\tts_worker.py", line 88, in run_tts',
    '    model = load_model()',
    'RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB',
  ].join('\n')
  const msg = selectPythonErrorMessage(stderr)
  assert.match(msg, /^RuntimeError: CUDA out of memory/)
  assert.ok(!msg.includes('RequestsDependencyWarning'), '경고문이 문구가 되지 않는다')
  assert.ok(!msg.includes('pynvml'), '외부 소스 인용 줄이 문구가 되지 않는다')
})

test('경고 + traceback 없음 → 빈 문구(일반 exit-code 메시지로 넘어간다)', () => {
  const stderr = [WARNING_ONLY, 'some unrelated chatter from a library'].join('\n')
  assert.equal(selectPythonErrorMessage(stderr), '')
})

test('실제 ImportError / ModuleNotFoundError 는 그대로 구조화 원인으로 남는다', () => {
  const missing = [WARNING_ONLY, "ModuleNotFoundError: No module named 'soundfile'"].join('\n')
  assert.match(selectPythonErrorMessage(missing), /^패키지 미설치: ModuleNotFoundError: No module named 'soundfile'/)

  const imp = [WARNING_ONLY, 'ImportError: DLL load failed while importing _ctypes'].join('\n')
  assert.match(selectPythonErrorMessage(imp), /^Import 오류: ImportError: DLL load failed/)

  const notFound = ['FileNotFoundError: [Errno 2] No such file or directory'].join('\n')
  assert.match(selectPythonErrorMessage(notFound), /^파일 없음: FileNotFoundError/)
})

test('절대 경로는 사용자 문구에서 파일명만 남는다', () => {
  const win = 'FileNotFoundError: [Errno 2] No such file: E:\\AI_Project\\secret\\voice_b.wav'
  const msgWin = selectPythonErrorMessage(win)
  assert.ok(!msgWin.includes('E:\\AI_Project'), 'Windows 절대경로 제거')
  assert.ok(!msgWin.includes('secret'), '중간 폴더 이름도 남지 않는다')
  assert.ok(msgWin.includes('voice_b.wav'), '파일명은 남아 원인 파악이 가능하다')

  const posix = 'RuntimeError: cannot open /home/user/private/ref.wav'
  const msgPosix = selectPythonErrorMessage(posix)
  assert.ok(!msgPosix.includes('/home/user'), 'POSIX 절대경로 제거')
  assert.ok(msgPosix.includes('ref.wav'))
})

test('site-packages 경로 줄은 후보에서 빠지되, 그 줄에 예외가 있으면 남는다', () => {
  const pathOnly = [
    'C:\\py\\Lib\\site-packages\\urllib3\\__init__.py:35: NotOpenSSLWarning: urllib3 v2 only supports OpenSSL',
    '  warnings.warn(',
  ].join('\n')
  assert.equal(selectPythonErrorMessage(pathOnly), '', '경고 줄만 있으면 고르지 않는다')

  const withError = 'C:\\py\\Lib\\site-packages\\torch\\cuda\\__init__.py: RuntimeError: no CUDA GPUs are available'
  const msg = selectPythonErrorMessage(withError)
  assert.match(msg, /RuntimeError: no CUDA GPUs are available/)
  assert.ok(!msg.includes('C:\\py'), '경로는 지운다')
})

test('여러 traceback 이 있으면 마지막 것의 예외를 고른다', () => {
  const stderr = [
    'Traceback (most recent call last):',
    '  File "a.py", line 1, in <module>',
    'ValueError: first failure',
    'During handling of the above exception, another exception occurred:',
    'Traceback (most recent call last):',
    '  File "b.py", line 2, in <module>',
    'KeyError: \'second\'',
  ].join('\n')
  assert.match(selectPythonErrorMessage(stderr), /^KeyError/)
})

test('임의의 예외 종류도 인식한다(알려진 5종에 갇히지 않는다)', () => {
  for (const line of [
    'PermissionError: [Errno 13] Permission denied',
    'torch.cuda.OutOfMemoryError: CUDA out of memory',
    'json.decoder.JSONDecodeError: Expecting value',
  ]) {
    const msg = selectPythonErrorMessage([WARNING_ONLY, line].join('\n'))
    assert.ok(msg.length > 0, line)
    assert.ok(!msg.includes('RequestsDependencyWarning'), line)
  }
})

test('소스 인용 줄(들여쓰기)은 문구가 되지 않는다', () => {
  const stderr = [
    'Traceback (most recent call last):',
    '  File "worker.py", line 10, in run',
    '    result = synthesize(text, ref)',
    'AssertionError',
  ].join('\n')
  const msg = selectPythonErrorMessage(stderr)
  assert.ok(!msg.includes('synthesize(text, ref)'), '코드 줄이 사용자 문구가 되지 않는다')
})

test('전사 원문처럼 보이는 평문은 문구로 승격되지 않는다', () => {
  // 예전 fallback(마지막 3줄)이었다면 이런 평문이 그대로 사용자에게 나갔다.
  const stderr = [WARNING_ONLY, '안녕하세요. 오늘은 날씨가 참 좋습니다.'].join('\n')
  assert.equal(selectPythonErrorMessage(stderr), '', '평문은 원인 후보가 아니다')
})
