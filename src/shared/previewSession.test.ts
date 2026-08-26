// 미리듣기 세션 모델 단위테스트(순수) — 세대 증가 / stale 결과 폐기 / 합법·불법 전이 / 빠른 교차 요청.
// 실행: npm test (node --test). 새 의존성 0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  IDLE_SESSION, beginRequest, invalidate, isStale, isLegalTransition, LEGAL_NEXT,
  applyEvent, decideAsyncResult, previewErrorText, PREVIEW_ERROR_TEXT,
  type PreviewSession, type PreviewPhase,
} from './previewSession.ts'

// 적용될 것으로 기대하는 이벤트를 밀어 넣고 다음 세션을 돌려주는 테스트 헬퍼.
function step(s: PreviewSession, gen: number, event: Parameters<typeof applyEvent>[2]): PreviewSession {
  const v = applyEvent(s, gen, event)
  assert.equal(v.apply, true, `${event.kind} 은(는) 적용되어야 한다 (phase=${s.phase})`)
  return (v as { apply: true; next: PreviewSession }).next
}

test('세대는 요청마다 단조 증가하고 loading으로 들어간다', () => {
  let s: PreviewSession = IDLE_SESSION
  assert.equal(s.gen, 0)
  assert.equal(s.phase, 'idle')
  const gens: number[] = []
  for (let i = 0; i < 5; i++) { s = beginRequest(s); gens.push(s.gen) }
  assert.deepEqual(gens, [1, 2, 3, 4, 5])
  assert.equal(s.phase, 'loading')
  assert.equal(s.errorMessage, null)
})

test('invalidate도 세대를 올린다(정지·소스 교체 시 진행 중 결과 전부 폐기)', () => {
  const a = beginRequest(IDLE_SESSION)
  const b = invalidate(a)
  assert.equal(b.gen, a.gen + 1)
  assert.equal(b.phase, 'idle')
  const c = invalidate(b, 'stopped')
  assert.equal(c.gen, b.gen + 1)
  assert.equal(c.phase, 'stopped')
})

test('isStale: 현재 세대만 최신, 그 외(옛 세대·미래 값)는 폐기 대상', () => {
  const s = beginRequest(beginRequest(IDLE_SESSION))   // gen 2
  assert.equal(isStale(s, 2), false)
  assert.equal(isStale(s, 1), true)
  assert.equal(isStale(s, 0), true)
  assert.equal(isStale(s, 3), true)
})

test('stale url 결과는 적용되지 않는다(늦게 온 이전 요청이 src를 덮어쓰지 못함)', () => {
  const s1 = beginRequest(IDLE_SESSION)     // 요청 1
  const s2 = beginRequest(s1)               // 요청 2 — 현재 세대
  const late = applyEvent(s2, s1.gen, { kind: 'url' })
  assert.deepEqual(late, { apply: false, reason: 'stale' })
  assert.equal(decideAsyncResult(s2, s1.gen), 'discard')
  const now = applyEvent(s2, s2.gen, { kind: 'url' })
  assert.equal(now.apply, true)
  assert.equal(decideAsyncResult(s2, s2.gen), 'apply')
})

test('stale 구간 종료 타이머는 현재 재생을 멈추지 못한다', () => {
  const old = beginRequest(IDLE_SESSION)                       // gen 1: 재생 시작
  let s = step(old, old.gen, { kind: 'ready' })
  s = step(s, old.gen, { kind: 'play' })
  assert.equal(s.phase, 'playing')
  const cur = beginRequest(s)                                  // gen 2: 곧바로 새 재생 요청
  // gen 1이 걸어둔 구간 종료 타이머가 이제 발화 → 새 재생을 멈추면 안 된다
  assert.deepEqual(applyEvent(cur, old.gen, { kind: 'region-end' }), { apply: false, reason: 'stale' })
  assert.equal(decideAsyncResult(cur, old.gen), 'discard')
  // 현재 세대의 타이머는 정상 적용된다
  let live = step(cur, cur.gen, { kind: 'ready' })
  live = step(live, cur.gen, { kind: 'play' })
  assert.equal(step(live, cur.gen, { kind: 'region-end' }).phase, 'stopped')
})

test('stale ended 이벤트도 폐기된다', () => {
  const s1 = beginRequest(IDLE_SESSION)
  const s2 = beginRequest(s1)
  assert.deepEqual(applyEvent(s2, s1.gen, { kind: 'ended' }), { apply: false, reason: 'stale' })
})

test('합법 전이: idle → loading → ready → playing → stopped', () => {
  assert.equal(isLegalTransition('idle', 'loading'), true)
  assert.equal(isLegalTransition('loading', 'ready'), true)
  assert.equal(isLegalTransition('ready', 'playing'), true)
  assert.equal(isLegalTransition('playing', 'stopped'), true)
  assert.equal(isLegalTransition('stopped', 'loading'), true)
  assert.equal(isLegalTransition('error', 'loading'), true)
  // 로드/재생 실패는 어느 단계에서든 error로 갈 수 있다(idle 제외 — 요청 전에는 실패가 없다)
  for (const p of ['loading', 'ready', 'playing'] as PreviewPhase[]) {
    assert.equal(isLegalTransition(p, 'error'), true, `${p} → error`)
  }
})

test('불법 전이는 거부된다(로드 건너뛴 재생·재생 중 되감기 등)', () => {
  const illegal: [PreviewPhase, PreviewPhase][] = [
    ['idle', 'playing'], ['idle', 'ready'], ['idle', 'stopped'], ['idle', 'error'],
    ['loading', 'playing'],          // ready(=loadedmetadata/canplay) 없이 재생 진입 금지
    ['ready', 'loading'], ['ready', 'ready'],
    ['playing', 'ready'], ['playing', 'playing'], ['playing', 'loading'],
    ['stopped', 'playing'], ['stopped', 'ready'], ['stopped', 'stopped'],
    ['error', 'playing'], ['error', 'ready'], ['error', 'stopped'],
  ]
  for (const [from, to] of illegal) {
    assert.equal(isLegalTransition(from, to), false, `${from} → ${to} 는 불법이어야 한다`)
  }
  // applyEvent도 같은 판정을 내린다
  const loading = beginRequest(IDLE_SESSION)
  assert.deepEqual(applyEvent(loading, loading.gen, { kind: 'play' }), { apply: false, reason: 'illegal' })
})

test('전이표는 모든 phase를 덮고, 목적지도 전부 알려진 phase다', () => {
  const all: PreviewPhase[] = ['idle', 'loading', 'ready', 'playing', 'stopped', 'error']
  for (const p of all) {
    assert.ok(Array.isArray(LEGAL_NEXT[p]), `${p} 항목 존재`)
    for (const to of LEGAL_NEXT[p]) assert.ok(all.includes(to), `${p} → ${to} 는 알려진 phase`)
  }
})

test('정상 1회 재생 시나리오: 세대 유지 + 각 단계 적용', () => {
  let s = beginRequest(IDLE_SESSION)
  const gen = s.gen
  for (const ev of [{ kind: 'url' }, { kind: 'ready' }, { kind: 'play' }] as const) {
    s = step(s, gen, ev)
    assert.equal(s.gen, gen, '세대는 요청 중 바뀌지 않는다')
  }
  assert.equal(s.phase, 'playing')
  assert.equal(step(s, gen, { kind: 'region-end' }).phase, 'stopped')
})

test('빠른 교차: gen1 요청 → gen2 요청 → gen1 url 늦게 도착(폐기) → gen2 url 도착(적용)', () => {
  const s1 = beginRequest(IDLE_SESSION)     // 사용자가 감정 A 미리듣기
  const gen1 = s1.gen
  const s2 = beginRequest(s1)               // 곧바로 감정 B 미리듣기
  const gen2 = s2.gen
  assert.equal(gen2, gen1 + 1)

  // gen1의 url이 늦게 도착 — 절대 적용되면 안 된다(옛 src가 새 재생을 덮어쓰는 사고)
  assert.deepEqual(applyEvent(s2, gen1, { kind: 'url' }), { apply: false, reason: 'stale' })

  // gen2의 url 도착 → 적용
  let cur = step(s2, gen2, { kind: 'url' })

  // gen1의 로드 완료/재생/타이머가 뒤늦게 몰려와도 전부 폐기
  for (const ev of [{ kind: 'ready' }, { kind: 'play' }, { kind: 'region-end' }, { kind: 'ended' }] as const) {
    assert.deepEqual(applyEvent(cur, gen1, ev), { apply: false, reason: 'stale' }, `gen1 ${ev.kind}`)
  }

  // gen2는 정상 진행
  cur = step(cur, gen2, { kind: 'ready' })
  cur = step(cur, gen2, { kind: 'play' })
  assert.equal(cur.phase, 'playing')
  assert.equal(cur.gen, gen2)
})

test('gen1의 play() 거부는 stale이면 조용히 폐기, 현재 세대면 오류로 노출', () => {
  const s1 = beginRequest(IDLE_SESSION)
  const s2 = beginRequest(s1)
  // 새 요청이 이전 재생을 pause 해서 생긴 AbortError → 사용자에게 오류를 띄우면 안 된다
  assert.deepEqual(applyEvent(s2, s1.gen, { kind: 'error', message: 'x' }), { apply: false, reason: 'stale' })
  // 현재 세대의 실패는 오류 문구와 함께 error로 간다
  const next = step(s2, s2.gen, { kind: 'error', message: previewErrorText('play') })
  assert.equal(next.phase, 'error')
  assert.equal(next.errorMessage, PREVIEW_ERROR_TEXT.play)
})

test('오류 문구는 사용자 언어이고 경로·원시 오류를 담지 않는다', () => {
  const kinds = ['source', 'load', 'play'] as const
  for (const k of kinds) {
    const msg = previewErrorText(k)
    assert.ok(msg.length > 0, `${k} 문구 존재`)
    // 경로/URL 유출 금지 — 구분자·스킴·확장자·드라이브 문자가 들어가면 안 된다
    for (const bad of ['\\', '/', ':', 'file', 'local-file', '.wav', 'C:', 'Error', 'undefined']) {
      assert.ok(!msg.includes(bad), `${k} 문구에 '${bad}' 없음: ${msg}`)
    }
    // 자동 재시도를 약속하지 않는다(사용자가 직접 다시 시도)
    assert.ok(!msg.includes('자동'), `${k} 문구가 자동 재시도를 암시하지 않음`)
  }
  // 세 문구는 서로 구분된다(무엇이 실패했는지 알 수 있어야 한다)
  assert.equal(new Set(kinds.map(previewErrorText)).size, 3)
})

test('오류 상태에서 새 요청을 하면 오류 문구가 지워진다', () => {
  const s = beginRequest(IDLE_SESSION)
  const err = step(s, s.gen, { kind: 'error', message: previewErrorText('load') })
  assert.equal(err.errorMessage, PREVIEW_ERROR_TEXT.load)
  const again = beginRequest(err)
  assert.equal(again.errorMessage, null)
  assert.equal(again.phase, 'loading')
})

test('세션 객체는 불변으로 다룬다(입력을 변형하지 않는다)', () => {
  const s = beginRequest(IDLE_SESSION)
  const before = { ...s }
  applyEvent(s, s.gen, { kind: 'ready' })
  invalidate(s)
  beginRequest(s)
  assert.deepEqual({ ...s }, before)
  assert.deepEqual({ ...IDLE_SESSION }, { gen: 0, phase: 'idle', errorMessage: null })
})
