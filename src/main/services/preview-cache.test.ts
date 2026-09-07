import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cacheableResult, createResultCache, fileStamp, requestKey } from './preview-cache.ts'

test('파일 신원은 크기와 수정 시각이다 — 경로가 같아도 내용이 바뀌면 다른 것', () => {
  const a = fileStamp('x.wav', () => ({ size: 100, mtimeMs: 1000 }))
  const b = fileStamp('x.wav', () => ({ size: 100, mtimeMs: 2000 }))
  const c = fileStamp('x.wav', () => ({ size: 101, mtimeMs: 1000 }))
  assert.equal(a, '100:1000')
  assert.notEqual(a, b, '수정 시각이 다르면 다른 신원')
  assert.notEqual(a, c, '크기가 다르면 다른 신원')
})

test('파일을 못 읽으면 신원이 없다 — 그때는 캐시하지 않는다', () => {
  assert.equal(fileStamp('없다.wav', () => { throw new Error('ENOENT') }), null)
  assert.equal(fileStamp('x.wav', () => ({ size: NaN, mtimeMs: 1 })), null)
})

test('열쇠는 인자 하나만 달라도 달라진다', () => {
  const k1 = requestKey(['a.wav', '10:5', 'qwen3', 1.5, 6.5])
  assert.equal(k1, requestKey(['a.wav', '10:5', 'qwen3', 1.5, 6.5]))
  assert.notEqual(k1, requestKey(['a.wav', '10:5', 'qwen3', 1.5, 6.6]), '길이가 다르면 다른 요청')
  assert.notEqual(k1, requestKey(['a.wav', '10:5', 'gptsovits', 1.5, 6.5]), '엔진이 다르면 다른 요청')
  assert.notEqual(k1, requestKey(['a.wav', '11:5', 'qwen3', 1.5, 6.5]), '파일이 바뀌면 다른 요청')
  // 빈 값과 없는 값을 같은 자리로 둔다 — 자리 수가 어긋나 다른 요청이 같은 열쇠가 되지 않게.
  assert.equal(requestKey(['a', null, 'b']), requestKey(['a', undefined, 'b']))
  assert.notEqual(requestKey(['a', 'b']), requestKey(['a', null, 'b']))
  // 구분자가 공백이면 경로의 공백과 섞여 서로 다른 조합이 같은 열쇠가 된다.
  assert.notEqual(requestKey(['a b', 'c']), requestKey(['a', 'b c']))
})

test('캐시는 넣고 꺼낸다. 최대 개수를 넘으면 가장 오래 안 쓴 것부터 버린다', () => {
  const c = createResultCache<number>(2)
  c.set('a', 1); c.set('b', 2)
  assert.equal(c.get('a'), 1)      // a 를 최근 사용으로 올린다
  c.set('c', 3)                    // 넘쳤다 → 가장 오래 안 쓴 b 가 나간다
  assert.equal(c.size, 2)
  assert.equal(c.get('b'), undefined)
  assert.equal(c.get('a'), 1)
  assert.equal(c.get('c'), 3)
})

test('접두로 버릴 수 있다 — 그 인물의 클립을 놓았을 때 그 항목만 지운다', () => {
  const c = createResultCache<number>()
  c.set('spk:A a.wav', 1); c.set('spk:A b.wav', 2); c.set('spk:B a.wav', 3)
  c.dropPrefix('spk:A ')
  assert.equal(c.get('spk:A a.wav'), undefined)
  assert.equal(c.get('spk:A b.wav'), undefined)
  assert.equal(c.get('spk:B a.wav'), 3, '다른 인물 것은 남는다')
})

test('실패·차단 응답은 캐시하지 않는다 — 원인이 사라진 뒤에도 실패를 되돌려 주면 안 된다', () => {
  assert.equal(cacheableResult({ duration_sec: 3 }), true)
  assert.equal(cacheableResult({ status: 'failed' }), false)
  assert.equal(cacheableResult({ code: 'REFERENCE_REGION_BLOCKED' }), false)
  assert.equal(cacheableResult({ error_message: '분석 실패' }), false)
  assert.equal(cacheableResult(null), false)
  assert.equal(cacheableResult(undefined), false)
  // 빈 문자열 error_message 는 오류가 아니다.
  assert.equal(cacheableResult({ duration_sec: 3, error_message: '' }), true)
})
