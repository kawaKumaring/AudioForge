// runtimeStatusView 순수 매핑 회귀 — Node 내장 러너(node --test).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  runtimeStatusView,
  runtimeScreenState,
  runtimeScreenView,
  runtimeProblemSummary,
  RUNTIME_SCREEN_STATES,
  type RuntimeStatusReport,
} from './runtimeStatus.ts'
import { REASON_CODES } from './runtimeContract.ts'

function report(p: Partial<RuntimeStatusReport>): RuntimeStatusReport {
  return { resolved: false, interpreterBasename: null, ownership: null, reasonCode: null, ...p }
}

test('resolved → ready, 버튼 없음, basename·소유권 표기', () => {
  const v = runtimeStatusView(report({ resolved: true, interpreterBasename: 'python.exe', ownership: 'audioforge-managed' }))
  assert.equal(v.tone, 'ready')
  assert.equal(v.canSelectInterpreter, false)
  assert.match(v.detail, /python\.exe/)
  assert.match(v.detail, /전용 런타임/)
})

test('borrowed 소유권 라벨 — 기존 환경을 읽기 전용으로 쓰는 중임을 명시', () => {
  const v = runtimeStatusView(report({ resolved: true, interpreterBasename: 'python', ownership: 'external-borrowed' }))
  assert.equal(v.tone, 'ready')
  assert.match(v.detail, /기존 환경 사용 중/)
  assert.match(v.detail, /읽기 전용/)
  // 빌린 런타임은 다른 실행기로 바꿀 길을 열어둔다(managed는 우리가 설치한 것이므로 불필요).
  assert.equal(v.canSelectInterpreter, true)
})

test('출처 표기 — 자동 감지된 기존 환경 기록', () => {
  const v = runtimeStatusView(report({
    resolved: true,
    interpreterBasename: 'python.exe',
    ownership: 'external-borrowed',
    source: 'legacy-detected',
  }))
  assert.match(v.detail, /기존 환경 기록\(자동 감지\)/)
  assert.match(v.detail, /python\.exe/)
})

test('출처 미지(구버전 보고) → 출처 없이도 표현이 깨지지 않음', () => {
  const v = runtimeStatusView(report({ resolved: true, interpreterBasename: 'python.exe', ownership: 'audioforge-managed' }))
  assert.equal(v.detail, 'AudioForge 전용 런타임 · python.exe')
})

test('미해석 + reasonCode null → action, 인터프리터 선택 유도', () => {
  const v = runtimeStatusView(report({ resolved: false, reasonCode: null }))
  assert.equal(v.tone, 'action')
  assert.equal(v.canSelectInterpreter, true)
})

test('INTERPRETER_NOT_FOUND → action + 선택 버튼', () => {
  const v = runtimeStatusView(report({ reasonCode: 'INTERPRETER_NOT_FOUND' }))
  assert.equal(v.tone, 'action')
  assert.equal(v.canSelectInterpreter, true)
})

test('VENV_MISSING → incomplete(설치 필요), 자동 설치 문구 없음', () => {
  const v = runtimeStatusView(report({ reasonCode: 'VENV_MISSING' }))
  assert.equal(v.tone, 'incomplete')
  assert.equal(v.canSelectInterpreter, true)
  assert.doesNotMatch(v.detail, /자동|다운로드/)
})

test('MODEL_MISSING → incomplete', () => {
  assert.equal(runtimeStatusView(report({ reasonCode: 'MODEL_MISSING' })).tone, 'incomplete')
})

test('전체 25개 ReasonCode에 대해 안전한 View 반환(throw 없음, 유효 tone)', () => {
  const tones = new Set(['ready', 'action', 'incomplete'])
  for (const code of REASON_CODES) {
    const v = runtimeStatusView(report({ reasonCode: code }))
    assert.ok(tones.has(v.tone), `tone 유효: ${code} → ${v.tone}`)
    assert.equal(typeof v.title, 'string')
    assert.ok(v.title.length > 0)
    assert.equal(typeof v.detail, 'string')
    assert.ok(v.detail.length > 0)
  }
})

// ── 메인 화면 상태 권위(5개) ─────────────────────────────────────────────────
test('runtimeScreenState: 보고 없음=checking, resolved=ready', () => {
  assert.equal(runtimeScreenState(null), 'checking')
  assert.equal(runtimeScreenState(report({ resolved: true, ownership: 'external-borrowed' })), 'ready')
})

test('runtimeScreenState: 구성 불완전=invalid, 그 외 미해석=setup-required', () => {
  assert.equal(runtimeScreenState(report({ resolved: false, reasonCode: 'VENV_MISSING' })), 'invalid')
  assert.equal(runtimeScreenState(report({ resolved: false, reasonCode: 'PACKAGE_MISSING' })), 'invalid')
  assert.equal(runtimeScreenState(report({ resolved: false, reasonCode: 'NO_RUNTIME_ROOT' })), 'setup-required')
  assert.equal(runtimeScreenState(report({ resolved: false, reasonCode: null })), 'setup-required')
})

test('runtimeScreenState: installing이 다른 모든 상태를 덮는다', () => {
  assert.equal(runtimeScreenState(report({ resolved: true }), { installing: true }), 'installing')
  assert.equal(runtimeScreenState(null, { installing: true }), 'installing')
})

test('ready 화면은 한 줄 + 관리 버튼 하나 — 설치 불가 경고를 섞지 않는다', () => {
  const v = runtimeScreenView(report({ resolved: true, ownership: 'external-borrowed', source: 'legacy-detected' }))
  assert.equal(v.state, 'ready')
  assert.equal(v.headline, '음성 엔진 준비됨')
  assert.equal(v.suffix, '기존 환경 사용 중')
  assert.equal(v.actionLabel, '관리')
  assert.equal(v.action, 'manage')
  // 모순 방지: ready 문구에 설치·미선택·불가 같은 말이 들어가면 안 된다.
  const line = `${v.headline} ${v.suffix ?? ''}`
  for (const bad of ['설치', '미선택', '불가', '준비 불가']) assert.ok(!line.includes(bad), bad)
})

test('managed로 준비되면 독립 환경 사용 중으로 표기', () => {
  const v = runtimeScreenView(report({ resolved: true, ownership: 'audioforge-managed' }))
  assert.equal(v.suffix, '독립 환경 사용 중')
})

test('setup-required 화면의 기본 CTA는 설정 시작 하나', () => {
  const v = runtimeScreenView(report({ resolved: false, reasonCode: 'NO_RUNTIME_ROOT' }))
  assert.equal(v.state, 'setup-required')
  assert.equal(v.headline, '음성 엔진 설정이 필요합니다')
  assert.equal(v.actionLabel, '설정 시작')
  assert.equal(v.suffix, null)
})

test('invalid 화면은 원인 요약 + 문제 해결 버튼, 기술 상세는 문구에 없음', () => {
  const r = report({ resolved: false, reasonCode: 'PYTHON_VERSION_INCOMPATIBLE' })
  const v = runtimeScreenView(r)
  assert.equal(v.state, 'invalid')
  assert.equal(v.headline, '음성 엔진을 사용할 수 없습니다')
  assert.equal(v.actionLabel, '문제 해결')
  // reasonCode 문자열이 메인 화면 문구로 새지 않는다.
  assert.ok(!v.headline.includes('PYTHON_VERSION_INCOMPATIBLE'))
  assert.match(runtimeProblemSummary(r), /파이썬 버전/)
})

test('checking/installing에는 기본 버튼이 없다', () => {
  assert.equal(runtimeScreenView(null).action, null)
  assert.equal(runtimeScreenView(null).actionLabel, null)
  assert.equal(runtimeScreenView(report({ resolved: true }), { installing: true }).action, null)
})

test('모든 상태가 정확히 하나의 표현을 갖는다(상태 권위 5개)', () => {
  assert.deepEqual([...RUNTIME_SCREEN_STATES], ['checking', 'ready', 'setup-required', 'invalid', 'installing'])
})
