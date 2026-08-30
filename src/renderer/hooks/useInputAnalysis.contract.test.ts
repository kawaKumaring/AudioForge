// 분석 훅의 **수명 계약**. 개발 실행에서만 나던 무한 `준비 중…` 의 회귀다.
//
// React 개발 빌드의 StrictMode 는 effect 를 setup → cleanup → setup 으로 두 번 부른다.
// 첫 cleanup 이 `alive` 를 내려두고 두 번째 setup 이 그것을 되살리지 않으면, 그 훅
// 인스턴스는 살아 있는 화면을 그리면서도 **모든 응답과 watchdog 을 무시**한다.
// 화면은 `대사 분석 준비 중…` 에서 영원히 멈춘다.
//
// 실제 동작 검증은 개발 경로 E2E(`test/e2e/analysis-dev-path.e2e.mjs`)가 한다.
// 여기서는 그 E2E 없이도 `npm test` 가 즉시 잡아내도록 소스의 계약을 고정한다 —
// 훅을 렌더하려면 테스트 전용 DOM 런타임을 새로 들여야 하는데, 이 한 줄을 지키자고
// 그만한 무게를 얹지는 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('./useInputAnalysis.ts', import.meta.url)), 'utf-8')

/** 마운트 effect 본문. `counters.mount` 을 세는 그 effect 하나만 골라 낸다. */
function mountEffect(): { setup: string; cleanup: string } {
  const marker = 'counters.mount += 1'
  const at = SRC.indexOf(marker)
  assert.notEqual(at, -1, '마운트 effect 를 찾지 못했다 — 계측 이름이 바뀌었다면 이 테스트도 고쳐라')
  const start = SRC.lastIndexOf('useEffect(() => {', at)
  const cleanupAt = SRC.indexOf('return () => {', at)
  const end = SRC.indexOf('}, [clearWatchdog])', cleanupAt)
  assert.ok(start !== -1 && cleanupAt !== -1 && end !== -1, '마운트 effect 구조를 읽지 못했다')
  return { setup: SRC.slice(start, cleanupAt), cleanup: SRC.slice(cleanupAt, end) }
}

test('마운트 effect 는 재진입할 때마다 alive 를 되살린다', () => {
  const { setup } = mountEffect()
  assert.ok(setup.includes('alive.current = true'),
    'StrictMode 는 setup 을 두 번 부른다. 두 번째 setup 이 alive 를 되살리지 않으면 '
    + '그 훅 인스턴스는 영원히 죽은 채로 남는다')
})

test('alive 를 내리는 곳은 cleanup 뿐이다', () => {
  const { cleanup } = mountEffect()
  assert.ok(cleanup.includes('alive.current = false'), 'cleanup 이 소유권을 놓아야 한다')
  // 소유자가 사라질 때 말고 다른 곳에서 내리면 어떤 재진입도 복구할 수 없다.
  assert.equal(SRC.split('alive.current = false').length - 1, 1,
    'alive 를 내리는 지점은 마운트 cleanup 한 곳뿐이어야 한다')
})

test('watchdog 은 마운트 cleanup 에서만 풀린다', () => {
  const { cleanup } = mountEffect()
  assert.ok(cleanup.includes('clearWatchdog()'), '소유자가 사라지면 안전망도 걷는다')
  // debounce effect 의 cleanup 이 watchdog 까지 지우면, 재렌더 한 번에 안전망이 사라져
  // `준비 중…` 이 풀리지 않는다 — 실제로 겪은 2차 결함이다.
  // cleanup **본문만** 본다. 의존성 배열에도 `clearWatchdog` 이 들어 있어, 뒤쪽을 넉넉히
  // 잘라 보면 없는 결함을 있다고 읽는다.
  const at = SRC.indexOf('counters.cleanup += 1')
  const end = SRC.indexOf('}', SRC.indexOf('clearTimeout(timer)', at))
  assert.ok(at !== -1 && end !== -1, 'debounce cleanup 을 찾지 못했다')
  assert.ok(!SRC.slice(at, end).includes('clearWatchdog'),
    'debounce cleanup 은 debounce 타이머만 지운다')
})
