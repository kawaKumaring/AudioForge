// 독립 실행(standalone) 런타임 상태의 렌더러 표면 계약(R4).
// main의 settings:get이 돌려주는 보고 형태와, 그 보고를 "사용자가 무엇을 해야 하는가"로
// 번역하는 순수 함수를 한곳에 둔다. renderer는 ReasonCode를 직접 해석하지 않고 이 함수만 쓴다.
// (자유 문자열 금지 — 코드→문구 매핑의 단일 소스. 설치/다운로드는 여기서 하지 않는다: PROVISION 단계 소관.)
// 순수 type-only import — node의 타입 제거가 런타임에 이 줄을 지우므로 확장자가 필요없고,
// tsc(web/node) 양쪽 bundler 해석으로 충분하다(비-test shared 파일의 확장자 무표기 관례 준수).
import type { ReasonCode, RuntimeOwnership } from './runtimeContract'

// main(settings:get)이 renderer로 넘기는 상태 보고. 전체 경로는 절대 포함하지 않는다(basename만).
export interface RuntimeStatusReport {
  resolved: boolean
  interpreterBasename: string | null
  ownership: RuntimeOwnership | null
  reasonCode: ReasonCode | null
}

// UI가 그릴 표현. tone으로 색을, canSelectInterpreter로 "인터프리터 선택" 버튼 노출을 결정한다.
// tone: ready=구성 완료 / action=사용자가 인터프리터를 지정하면 해결 / incomplete=런타임은 있으나 구성 미완(설치 단계 필요).
export interface RuntimeStatusView {
  tone: 'ready' | 'action' | 'incomplete'
  title: string
  detail: string
  canSelectInterpreter: boolean
}

function ownershipLabel(o: RuntimeOwnership | null): string {
  if (o === 'audioforge-managed') return 'AudioForge 전용 런타임'
  if (o === 'external-borrowed') return '외부에서 빌려온 런타임(읽기 전용)'
  return '런타임'
}

// 인터프리터 지정으로 해결되는 사유(구성 이전 단계) — "인터프리터 선택" 버튼을 띄운다.
const SELECTABLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'NO_RUNTIME_ROOT',
  'USER_SELECTION_FAILED',
  'INTERPRETER_NOT_FOUND',
  'DANGLING_JUNCTION',
  'DUPLICATE_CANDIDATE',
])

// 런타임은 찾았으나 구성이 완전하지 않은 사유 — 이 앱에서 자동 설치하지 않는다(사용자 안내만).
const INCOMPLETE_MESSAGE: Partial<Record<ReasonCode, string>> = {
  VENV_MISSING: '파이썬은 찾았지만 필요한 가상환경이 없습니다. 런타임 설치가 필요합니다.',
  MODEL_MISSING: '런타임은 준비됐지만 필요한 모델 파일이 없습니다. 모델을 갖춰야 합니다.',
  MODEL_CHECKSUM_MISMATCH: '모델 파일이 손상되었거나 버전이 다릅니다. 모델을 다시 갖춰야 합니다.',
  PACKAGE_MISSING: '필요한 파이썬 패키지가 설치되어 있지 않습니다.',
  PACKAGE_VERSION_INCOMPATIBLE: '설치된 파이썬 패키지 버전이 맞지 않습니다.',
  PACKAGE_DRIFT: '설치된 파이썬 패키지 구성이 기대와 어긋납니다.',
  PIP_CHECK_FAILED: '파이썬 패키지 의존성 점검에 실패했습니다.',
  PYTHON_VERSION_INCOMPATIBLE: '파이썬 버전이 맞지 않습니다. 지원되는 버전이 필요합니다.',
  ARCHITECTURE_INCOMPATIBLE: '파이썬 실행기의 아키텍처(32/64비트 등)가 맞지 않습니다.',
  PREFLIGHT_FAILED: '런타임 사전 점검에 실패했습니다. 인터프리터 구성을 확인하세요.',
  TOOL_MISSING: '필요한 보조 도구를 찾을 수 없습니다.',
  PATH_OUTSIDE_ROOT: '런타임 경로가 허용된 위치를 벗어났습니다.',
  EVIDENCE_STALE: '런타임 점검 정보가 오래되었습니다. 다시 확인이 필요합니다.',
  BORROWED_RUNTIME_READ_ONLY: '빌려온 런타임은 읽기 전용이라 구성을 바꿀 수 없습니다.',
}

// 순수 함수: 상태 보고 → UI 표현. renderer는 이 결과만 그린다(코드 해석 없음).
export function runtimeStatusView(report: RuntimeStatusReport): RuntimeStatusView {
  if (report.resolved) {
    const name = report.interpreterBasename ?? '파이썬'
    return {
      tone: 'ready',
      title: '런타임 준비됨',
      detail: `${ownershipLabel(report.ownership)} · ${name}`,
      canSelectInterpreter: false,
    }
  }
  const code = report.reasonCode
  if (code && INCOMPLETE_MESSAGE[code]) {
    return {
      tone: 'incomplete',
      title: '런타임 구성 미완',
      detail: INCOMPLETE_MESSAGE[code] as string,
      canSelectInterpreter: true, // 다른 인터프리터를 고르면 해결될 수도 있으므로 재선택은 허용
    }
  }
  if (code && SELECTABLE.has(code)) {
    return {
      tone: 'action',
      title: '런타임이 구성되지 않았습니다',
      detail: 'AI 실행에 쓸 파이썬 실행기를 지정하면 시작할 수 있습니다.',
      canSelectInterpreter: true,
    }
  }
  // reasonCode가 null이거나(아직 미해석) 위 분류 밖 — 기본 안내(인터프리터 지정 유도).
  return {
    tone: 'action',
    title: '런타임이 구성되지 않았습니다',
    detail: 'AI 실행에 쓸 파이썬 실행기를 지정하면 시작할 수 있습니다.',
    canSelectInterpreter: true,
  }
}
