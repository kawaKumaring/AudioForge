// provision IPC의 순수 헬퍼(Agent Q) — electron/fs/spawn 무접촉이라 node --test로 직접 검증 가능.
// provision.ipc.ts가 이 함수들을 소비한다(electron 의존은 그쪽에만 둔다).
import { isReasonCode, type ReasonCode } from '../../shared/runtimeContract.ts'

// plan에서 보여줄 선택(optional) extra component 집합.
// Python cli(_resolve_engine_ids)는 "Explicit extras only" — wildcard를 fail-closed로 거부한다
// (UNRESOLVED_COMPONENT). 따라서 여기서 "*"를 보내면 plan/verify가 통째로 실패한다.
// 기본 미리보기는 profile(minimal-qwen)이 정의한 구성요소만 보여주면 되므로 extras는 비운다.
// 개별 extra는 사용자가 선택할 때 명시 id로 전달한다(TS가 id를 하드코딩하지 않는 원칙 유지).
export const ALL_OPTIONAL: readonly string[] = []

// provisioner 실행용 Python 경로를 **명시 주입원**에서만 고른다. 자동 스캔·벤더(외부 배포판/system) 하드코딩 0.
//   1) env AUDIOFORGE_PROVISION_PYTHON (ops/E2E 주입)
//   2) settings.provisionPythonPath (전용 설정)
//   3) settings.pythonPath (사용자가 인터프리터 선택 흐름으로 명시 지정한 값 — 자동 채택이 아님)
// 셋 다 없으면 null → 호출부는 BOOTSTRAP_PYTHON_UNRESOLVED로 표면화(production 해석은 STOP 표 항목).
export function pickProvisionPython(
  env: Record<string, string | undefined>,
  settings: Record<string, unknown>,
): string | null {
  const fromEnv = env.AUDIOFORGE_PROVISION_PYTHON
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const fromProvSetting = settings.provisionPythonPath
  if (typeof fromProvSetting === 'string' && fromProvSetting.length > 0) return fromProvSetting
  const fromInterp = settings.pythonPath
  if (typeof fromInterp === 'string' && fromInterp.length > 0) return fromInterp
  return null
}

// provision_cli.py의 stdout에서 마지막 provision envelope 라인을 파싱. 경고/비-JSON 라인은 건너뛴다.
// 반환: {ok, result?, error?} 또는 null(봉투 없음).
export function parseProvisionEnvelope(stdout: string): {
  ok: boolean
  result?: unknown
  error?: { code?: unknown; message?: unknown }
} | null {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (!t.startsWith('{')) continue
    try {
      const obj = JSON.parse(t)
      if (obj && (obj.type === 'provision-result' || obj.type === 'provision-error')) {
        return { ok: obj.ok === true, result: obj.result, error: obj.error }
      }
    } catch { /* keep scanning older lines */ }
  }
  return null
}

// envelope의 error.code를 계약 ReasonCode로 정규화(미상/비계약 코드는 APPLY_DISABLED로 접음 — 자유 문자열 금지).
export function envelopeReasonCode(error: { code?: unknown } | undefined): ReasonCode {
  const c = error?.code
  return isReasonCode(c) ? c : 'APPLY_DISABLED'
}
