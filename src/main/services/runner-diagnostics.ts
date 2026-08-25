// Python 프로세스 종료 진단 — 순수 함수(spawn/GPU/미디어 의존 0, 단위 테스트 대상).
//
// 목적: nonzero/신호 종료 시 '무엇이 실패인지'를 stderr 꼬리 휴리스틱이 아니라
// 명시적 규칙으로 판정한다. RequestsDependencyWarning 같은 무해 경고를 실패 원인으로
// 표면화하던 결함(G3)의 근본을 없앤다.
//
// 권위 순서: 구조화 stdout 신호(error/result) > Traceback/fatal 예외라인 > nonzero/신호.
//  - 구조화 error/result가 이미 왔으면 그것이 권위 → 여기서 이중 표면화하지 않는다(return null).
//  - warning(`*Warning:`)만으로는 절대 fatal 메시지를 만들지 않는다.
//  - 신호 종료(code===null)는 PYTHON_PROCESS_SIGNAL.
//  - nonzero인데 fatal 예외가 없으면 PYTHON_PROCESS_ABNORMAL_EXIT.
//
// renderer 노출 경계: userMessage(안전 안내 + 예외 '타입'명까지만)와 reasonCode만 밖으로.
// stderr 전문·절대경로·raw 예외 메시지·sha8·length는 devLog(로컬 console.log 전용)에만 담는다.

import { createHash } from 'crypto'

// 고정 union(자유문자열 금지). 통합 시 contract의 ReasonCode union과 정합하는 canonical 값.
export type ExitReason =
  | 'PACKAGE_MISSING'
  | 'INPUT_FILE_MISSING'
  | 'PYTHON_RUNTIME_ERROR'
  | 'PYTHON_PROCESS_ABNORMAL_EXIT'
  | 'PYTHON_PROCESS_SIGNAL'

export interface ExitInput {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  hadStructuredError: boolean
  hadStructuredResult: boolean
}

export interface ExitDiagnosis {
  reasonCode: ExitReason
  /** renderer용 — 안전(절대경로·traceback·raw 예외 메시지 없음). 예외 '타입'명까지만 허용. */
  userMessage: string
  /** 로컬 console.log 전용 — stderr 꼬리 + sha8 + length + code/signal + 예외 타입. IPC 금지. */
  devLog: string
}

// benign warning 라인: `SomeWarning: ...` 형태(WarningType 토큰 + 콜론).
// `RuntimeError:` 등 Error는 매칭되지 않는다(끝이 Error). RuntimeWarning은 경고로 취급.
const WARNING_LINE = /(^|[\s.])[A-Za-z_][A-Za-z0-9_]*Warning:\s/

// fatal 종결 예외라인: `ModuleNotFoundError: ...`, `ValueError: ...`, `RuntimeError: ...` 등.
// 경고(위 WARNING_LINE)로 분류된 라인은 제외한다.
const EXCEPTION_LINE = /^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception)):/
const TRACEBACK_HEADER = 'Traceback (most recent call last):'

function sha8(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)
}

// stderr에서 fatal 예외 타입을 찾는다(꼬리에서 위로). 경고 라인은 건너뛴다.
// 반환: 예외 타입명(예: 'ModuleNotFoundError') 또는 null.
function findExceptionType(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    if (WARNING_LINE.test(line)) continue // 무해 경고는 fatal 아님
    const m = EXCEPTION_LINE.exec(line)
    if (m) return m[1]
  }
  return null
}

// 예외 타입 → canonical reasonCode + 안전 안내.
function mapException(type: string): { reasonCode: ExitReason; userMessage: string } {
  if (type === 'ModuleNotFoundError' || type === 'ImportError') {
    return {
      reasonCode: 'PACKAGE_MISSING',
      userMessage: '필요한 Python 패키지가 설치되어 있지 않습니다. 환경 설정을 확인해주세요.'
    }
  }
  if (type === 'FileNotFoundError') {
    return {
      reasonCode: 'INPUT_FILE_MISSING',
      userMessage: '처리에 필요한 파일을 찾을 수 없습니다.'
    }
  }
  return {
    reasonCode: 'PYTHON_RUNTIME_ERROR',
    userMessage: `처리 중 오류가 발생했습니다 (${type}). 로그를 확인해주세요.`
  }
}

/**
 * 프로세스 종료를 진단한다. 에러로 표면화할 게 없으면 null(정상 종료·구조화 신호 권위).
 */
export function diagnoseExit(i: ExitInput): ExitDiagnosis | null {
  // 1) 구조화 stdout 신호가 권위 — 이중 표면화 금지(warning 오표면화·reasonCode 유실 방지).
  if (i.hadStructuredError || i.hadStructuredResult) return null

  const lines = i.stderr.split('\n')
  const excType = findExceptionType(lines)
  const hasTraceback = i.stderr.includes(TRACEBACK_HEADER)

  // devLog 공통 조각(로컬 전용). stderr 꼬리는 마지막 20줄로 제한.
  const tail = lines.filter((l) => l.trim().length > 0).slice(-20).join('\n')
  const stderrTrimmed = i.stderr.trim()
  const devBase =
    `exit code=${i.code} signal=${i.signal ?? 'null'} ` +
    `stderr.len=${stderrTrimmed.length} stderr.sha8=${stderrTrimmed ? sha8(stderrTrimmed) : 'none'} ` +
    `excType=${excType ?? 'none'} traceback=${hasTraceback}`

  // 2) 신호 종료(code===null && signal) — PYTHON_PROCESS_SIGNAL.
  if (i.code === null && i.signal) {
    return {
      reasonCode: 'PYTHON_PROCESS_SIGNAL',
      userMessage: `처리 프로세스가 강제 종료되었습니다 (신호 ${i.signal}).`,
      devLog: `[SIGNAL] ${devBase}\n--- stderr tail ---\n${tail}`
    }
  }

  // 3) fatal 예외(Traceback 또는 예외 종결라인)가 있으면 그것으로 판정.
  if (excType) {
    const { reasonCode, userMessage } = mapException(excType)
    return {
      reasonCode,
      userMessage,
      devLog: `[FATAL] ${devBase}\n--- stderr tail ---\n${tail}`
    }
  }

  // 4) 정상 종료(code 0) + fatal 없음 → 표면화할 것 없음. 경고만 있어도 여기서 null.
  if (i.code === 0) return null

  // 5) nonzero인데 명시적 fatal(예외/traceback) 없음 → 비정상 종료.
  //    warning만 있는 경우도 여기로 온다(경고를 원인으로 삼지 않음).
  if (i.code !== null && i.code !== 0) {
    return {
      reasonCode: 'PYTHON_PROCESS_ABNORMAL_EXIT',
      userMessage: `처리가 예기치 않게 종료되었습니다 (종료 코드 ${i.code}). Python 환경과 로그를 확인해주세요.`,
      devLog: `[ABNORMAL] ${devBase}\n--- stderr tail ---\n${tail}`
    }
  }

  // code===null이며 signal도 없는 예외적 경우(관측상 드묾) — 표면화 안 함(done/settlement가 마감).
  return null
}
