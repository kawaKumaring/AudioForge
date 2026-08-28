// 감정 음향 판정 계약 단위테스트. 합성 데이터만 — GPU·모델·오디오·파일 생성 없음.
// 레포 규약대로 EXPLICIT '.ts' 확장자로 import 한다(node --test 가 로더 없이 type-strip 해 실행).
//
// 검증 축:
//   1) 같은 참조 하나로는 어떤 감정도 supported 가 되지 않는다(가짜 감정 차단선)
//   2) accepted 와 honored 가 분리되어 있고, honored 는 측정 없이 true 가 될 수 없다
//   3) 상태는 언제나 증거에서 파생된다(TS/Python 이 같은 표를 쓴다)
//   4) 상태·사유마다 서로 다른 문구가 나온다(조용한 무표시 금지)
//   5) parity: python/emotion_acoustic.py 소스를 파싱해 어휘 대조
//   6) 화면 문구가 '지원/됨'을 함부로 말하지 않는다
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EMOTION_REFERENCE_ROLES,
  EMOTION_ACOUSTIC_STATES,
  EMOTION_ACOUSTIC_REASONS,
  EMOTION_ACOUSTIC_SUPPORTED_REASON,
  EMOTION_ACOUSTIC_REASON_LABEL,
  EMOTION_ACOUSTIC_STATE_LABEL,
  EMOTION_ACOUSTIC_DEFAULT_VOICE_NOTICE,
  EMOTION_ACOUSTIC_SAMPLER_NOTICE,
  EMOTION_ACOUSTIC_NONE_CONFIRMED_NOTICE,
  classifyReferenceRole,
  emotionAcousticEvidence,
  emotionAcousticState,
  resolveEmotionAcoustic,
  describeEmotionAcoustic,
  summarizeEmotionAcoustic,
  EmotionAcousticHonestyError,
  type EmotionReferenceRole,
} from './emotionAcoustic.ts'

const PY_PATH = fileURLToPath(new URL('../../python/emotion_acoustic.py', import.meta.url))
const MANAGER_PATH = fileURLToPath(
  new URL('../renderer/components/EmotionReferenceManager.tsx', import.meta.url))
const SAMPLER_PANEL_PATH = fileURLToPath(
  new URL('../renderer/components/EmotionSamplerPanel.tsx', import.meta.url))

function readSource(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n')
}
const pySrc = readSource(PY_PATH)

/** `NAME = "값"` 형태의 python 문자열 상수 값을 찾는다. */
function pyStringConst(name: string): string {
  const m = pySrc.match(new RegExp(`^${name}\\s*=\\s*"([^"]+)"`, 'm'))
  assert.ok(m, `python 문자열 상수 누락: ${name}`)
  return (m as RegExpMatchArray)[1]
}

/**
 * python 튜플 상수의 **값** 목록.
 * 이 모듈의 튜플은 문자열 리터럴이 아니라 별칭 상수로 구성되어 있으므로(코드가 읽기 쉬워진다),
 * 별칭을 만나면 그 상수의 문자열 값까지 따라가 비교한다 — 이름이 아니라 값이 대조 대상이다.
 */
function pyTuple(name: string): string[] {
  const m = pySrc.match(new RegExp(`^${name}\\s*=\\s*\\(([\\s\\S]*?)^\\)`, 'm'))
  assert.ok(m, `python 상수 누락: ${name}`)
  const body = (m as RegExpMatchArray)[1]
  const out: string[] = []
  for (const raw of body.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim().replace(/,$/, '').trim()
    if (!line) continue
    const lit = line.match(/^"([^"]+)"$/)
    if (lit) { out.push(lit[1]); continue }
    const ident = line.match(/^([A-Z][A-Z0-9_]*)$/)
    if (ident) { out.push(pyStringConst(ident[1])); continue }
    assert.fail(`파싱하지 못한 python 튜플 항목: ${line}`)
  }
  return out
}

// 판정 조합을 한 자리에서 만든다 — 축이 늘어나도 테스트가 조합을 빠뜨리지 않게.
const SEPARATED: (boolean | undefined)[] = [undefined, false, true]
const FOLLOWED: (boolean | undefined)[] = [undefined, false, true]

// ── 1) 가짜 감정 차단선 ──────────────────────────────────────────────────────

test('같은 참조를 쓰는 감정은 degraded 이고 절대 supported 가 되지 않는다', () => {
  const v = resolveEmotionAcoustic('happy', { role: 'shared_default' })
  assert.equal(v.state, 'degraded')
  assert.equal(v.reason, 'EMOTION_REF_SHARED_DEFAULT')
  assert.equal(v.usable, false)
})

test('전용 참조가 없으면 degraded 이다', () => {
  const v = resolveEmotionAcoustic('sad', { role: 'absent' })
  assert.equal(v.state, 'degraded')
  assert.equal(v.reason, 'EMOTION_REF_ABSENT')
})

test('기본 참조 하나로 기쁨·화남·슬픔을 지원한다고 표시할 수 없다', () => {
  const verdicts = ['happy', 'angry', 'sad'].map((id) =>
    resolveEmotionAcoustic(id, { role: classifyReferenceRole('REF', 'REF') }))
  assert.deepEqual(verdicts.map((v) => v.state), ['degraded', 'degraded', 'degraded'])
  const s = summarizeEmotionAcoustic(verdicts)
  assert.equal(s.supported, 0)
  assert.equal(s.degraded, 3)
  assert.equal(s.notice, EMOTION_ACOUSTIC_NONE_CONFIRMED_NOTICE)
})

test('supported 로 가는 길은 distinct + 측정 + 추종 하나뿐이다', () => {
  const reached: { role: EmotionReferenceRole; reason: string }[] = []
  for (const role of EMOTION_REFERENCE_ROLES) {
    for (const separated of SEPARATED) {
      for (const followed of FOLLOWED) {
        const v = resolveEmotionAcoustic('x', { role, separated, followed })
        assert.ok(EMOTION_ACOUSTIC_REASONS.includes(v.reason), v.reason)
        assert.ok(EMOTION_ACOUSTIC_STATES.includes(v.state), v.state)
        if (v.state === 'supported') reached.push({ role, reason: v.reason })
      }
    }
  }
  assert.ok(reached.length > 0, 'supported 로 가는 길이 아예 없으면 계약이 죽은 것이다')
  for (const r of reached) {
    assert.equal(r.role, 'distinct')
    assert.equal(r.reason, EMOTION_ACOUSTIC_SUPPORTED_REASON)
  }
})

// ── 2) accepted / honored 분리 ───────────────────────────────────────────────

test('같은 참조는 accepted 이되 honored 가 아니다(받아들여진 것과 반영된 것은 다르다)', () => {
  const ev = emotionAcousticEvidence({ role: 'shared_default' })
  assert.equal(ev.accepted, true)
  assert.equal(ev.honored, false)
  assert.equal(emotionAcousticState(ev), 'degraded')
})

test('참조만 재고 결과를 안 재면 성공이 아니라 unknown 이다', () => {
  const ev = emotionAcousticEvidence({ role: 'distinct', separated: true })
  assert.equal(ev.accepted, true)     // 입력은 실제로 달라졌고
  assert.equal(ev.attempted, false)   // 프로브는 끝나지 않았다
  assert.equal(emotionAcousticState(ev), 'unknown')
  const v = resolveEmotionAcoustic('x', { role: 'distinct', separated: true })
  assert.equal(v.reason, 'EMOTION_RESULT_NOT_MEASURED')
})

test('측정하지 않음(undefined)과 측정해서 아님(false)은 다른 결론이다', () => {
  const notMeasured = resolveEmotionAcoustic('x', { role: 'distinct', separated: undefined })
  const measuredNo = resolveEmotionAcoustic('x', { role: 'distinct', separated: false })
  assert.equal(notMeasured.state, 'unknown')
  assert.equal(measuredNo.state, 'degraded')
  assert.notEqual(notMeasured.reason, measuredNo.reason)
})

test('결과가 참조를 따라가야만 honored 가 된다', () => {
  const no = resolveEmotionAcoustic('x', { role: 'distinct', separated: true, followed: false })
  assert.equal(no.honored, false)
  assert.equal(no.state, 'degraded')
  assert.equal(no.reason, 'EMOTION_RESULT_NOT_FOLLOWED')
  const yes = resolveEmotionAcoustic('x', { role: 'distinct', separated: true, followed: true })
  assert.equal(yes.honored, true)
  assert.equal(yes.state, 'supported')
})

// ── 3) 상태는 언제나 증거에서 파생 ───────────────────────────────────────────

test('state 는 언제나 emotionAcousticState(evidence) 와 같다', () => {
  for (const role of EMOTION_REFERENCE_ROLES) {
    for (const separated of SEPARATED) {
      for (const followed of FOLLOWED) {
        const input = { role, separated, followed }
        assert.equal(resolveEmotionAcoustic('x', input).state,
          emotionAcousticState(emotionAcousticEvidence(input)), JSON.stringify(input))
      }
    }
  }
})

test('사유와 상태가 어긋나면 예외로 막는다(가짜 성공 차단)', () => {
  // 내부 불변식이 살아 있는지 — supported 사유는 supported 상태에서만 나온다.
  for (const role of EMOTION_REFERENCE_ROLES) {
    for (const separated of SEPARATED) {
      for (const followed of FOLLOWED) {
        const v = resolveEmotionAcoustic('x', { role, separated, followed })
        assert.equal(v.reason === EMOTION_ACOUSTIC_SUPPORTED_REASON, v.state === 'supported')
      }
    }
  }
  assert.ok(EmotionAcousticHonestyError.prototype instanceof Error)
})

test('role 판정은 사실만 말한다', () => {
  assert.equal(classifyReferenceRole('a', 'b'), 'distinct')
  assert.equal(classifyReferenceRole('a', 'a'), 'shared_default')
  assert.equal(classifyReferenceRole(null, 'a'), 'absent')
  assert.equal(classifyReferenceRole('', 'a'), 'absent')
  // 기본 참조가 없으면 비교 대상이 없다 — distinct 로 승격하지 않는다.
  assert.equal(classifyReferenceRole('a', null), 'absent')
})

// ── 4) 표시 ─────────────────────────────────────────────────────────────────

test('사유마다 서로 다른 문구가 있다(조용한 무표시 금지)', () => {
  const labels = EMOTION_ACOUSTIC_REASONS.map((r) => EMOTION_ACOUSTIC_REASON_LABEL[r])
  assert.equal(new Set(labels).size, EMOTION_ACOUSTIC_REASONS.length)
  for (const l of labels) assert.ok(l.length > 0)
  assert.equal(new Set(Object.values(EMOTION_ACOUSTIC_STATE_LABEL)).size,
    EMOTION_ACOUSTIC_STATES.length)
})

test('describeEmotionAcoustic 는 상태별로 다른 톤을 준다', () => {
  const degraded = describeEmotionAcoustic(resolveEmotionAcoustic('x', { role: 'absent' }))
  const unknown = describeEmotionAcoustic(
    resolveEmotionAcoustic('x', { role: 'distinct' }))
  const ok = describeEmotionAcoustic(
    resolveEmotionAcoustic('x', { role: 'distinct', separated: true, followed: true }))
  assert.equal(degraded.tone, 'warn')
  assert.equal(unknown.tone, 'muted')
  assert.equal(ok.tone, 'ok')
  assert.equal(new Set([degraded.notice, unknown.notice, ok.notice]).size, 3)
})

// ── 5) parity — python 소스를 파싱해 어휘 대조 ──────────────────────────────

test('parity: role 어휘가 python 과 같다', () => {
  const py = pyTuple('EMOTION_REFERENCE_ROLES')
  assert.deepEqual([...EMOTION_REFERENCE_ROLES], py)
})

test('parity: 사유 코드 집합이 python 과 같다', () => {
  const py = pyTuple('EMOTION_ACOUSTIC_REASONS')
  assert.deepEqual([...EMOTION_ACOUSTIC_REASONS], py)
})

test('parity: supported 사유가 python 과 같다', () => {
  const m = pySrc.match(/^EMOTION_ACOUSTIC_SUPPORTED_REASON\s*=\s*(\w+)\s*$/m)
  assert.ok(m, 'python 의 supported 사유 상수 누락')
  // python 은 별칭 상수로 가리킨다 → 그 별칭의 문자열 값을 다시 찾아 비교한다.
  assert.equal(EMOTION_ACOUSTIC_SUPPORTED_REASON, pyStringConst((m as RegExpMatchArray)[1]))
})

test('parity: python 은 honored 를 인자로 받지 않는다', () => {
  // "받아들여졌으니 됐다" 가 성공으로 새는 길을 양쪽 언어에서 동시에 막는다.
  const defs = [...pySrc.matchAll(/^def\s+(\w+)\s*\(([^)]*)\)/gm)]
  const guarded = ['emotion_acoustic_evidence', 'resolve_emotion_acoustic', 'instruct_probe_evidence']
  for (const name of guarded) {
    const d = defs.find((x) => x[1] === name)
    assert.ok(d, `python 함수 누락: ${name}`)
    assert.ok(!/\bhonored\b/.test((d as RegExpMatchArray)[2]), `${name} 가 honored 를 인자로 받는다`)
  }
})

test('parity: production 컨텍스트에서 instruct probe 가 꺼지는 규칙이 python 에 있다', () => {
  assert.match(pySrc, /def\s+instruct_probe_allowed/)
  assert.match(pySrc, /if\s+context\s*==\s*"production":\s*\n\s*return\s+False/)
})

// ── 6) 화면 배선 ────────────────────────────────────────────────────────────

test('화면 문구가 감정이 거의 들리지 않는다는 사실을 말한다', () => {
  for (const s of [EMOTION_ACOUSTIC_DEFAULT_VOICE_NOTICE, EMOTION_ACOUSTIC_SAMPLER_NOTICE]) {
    assert.ok(s.length > 0)
    assert.match(s, /거의/)
  }
  // 기술 용어가 사용자 문구로 새지 않는다.
  for (const s of [...Object.values(EMOTION_ACOUSTIC_REASON_LABEL),
    EMOTION_ACOUSTIC_DEFAULT_VOICE_NOTICE, EMOTION_ACOUSTIC_SAMPLER_NOTICE]) {
    assert.doesNotMatch(s, /instruct|probe|honored|accepted|degraded|F0|ProbeEvidence/i)
  }
})

test('감정 참조 관리 화면이 이 계약을 실제로 소비한다', () => {
  const src = readSource(MANAGER_PATH)
  assert.match(src, /from '\.\.\/\.\.\/shared\/emotionAcoustic'/)
  assert.match(src, /describeEmotionAcoustic/)
  assert.match(src, /EMOTION_ACOUSTIC_DEFAULT_VOICE_NOTICE/)
})

test('미리듣기 패널이 기본 목소리 한계를 화면에 밝힌다', () => {
  const src = readSource(SAMPLER_PANEL_PATH)
  assert.match(src, /EMOTION_ACOUSTIC_SAMPLER_NOTICE/)
})

test('웃음은 이 계약으로 승격되지 않는다(LAUGH_NO_STRATEGY 유지)', () => {
  // 이 모듈은 감정 참조만 판정한다 — 웃음 어휘를 아예 갖고 있지 않아야 한다.
  const src = readSource(fileURLToPath(new URL('./emotionAcoustic.ts', import.meta.url)))
  assert.doesNotMatch(src, /LAUGH|laugh/)
  assert.doesNotMatch(pySrc, /LAUGH_NO_STRATEGY/)
})
