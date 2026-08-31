// 줄 끝 정규화 — TS 파서도 Python 과 같은 입력 경계에서 CRLF·단독 CR 을 LF 로 만든다.
//
// CR 이 spoken text 에 남으면 tokenizer 결과·chunk 계획·실제 발화·시간 예측이 LF 입력과
// 갈라진다(실측). 정규화는 파서 내부에서만 일어나고 사용자 원문은 건드리지 않으며, 밖으로
// 나가는 offset 은 **원문 좌표**로 되돌아온다.
//
// Python 쪽 계약은 python/test_line_ending_normalization.py 가 같은 벡터로 고정한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeLineEndings, parseTtsScript } from './ttsGrammar.ts'

const CR = '\r'
const LF = '\n'
const BASE = `첫 줄입니다.${LF}[기쁨] 둘째 줄입니다.${LF}${LF}셋째 줄입니다. 넷째 문장도 같은 줄.${LF}다섯째 줄입니다.`

const variants = (lf: string) => ({
  lf,
  crlf: lf.split(LF).join(CR + LF),
  cr: lf.split(LF).join(CR),
})

const okPlan = (raw: string) => {
  const r = parseTtsScript(raw)
  assert.equal(r.ok, true, `파싱 실패: ${JSON.stringify(raw.slice(0, 16))}`)
  return (r as { ok: true; plan: ReturnType<typeof parseTtsScript> extends never ? never : any }).plan
}

test('LF 입력은 정규화가 건드리지 않는다', () => {
  const n = normalizeLineEndings(BASE)
  assert.equal(n.text, BASE)
  assert.equal(n.changed, false)
  assert.equal(n.u16Map[0], 0)
  assert.equal(n.u16Map[n.u16Map.length - 1], BASE.length)
})

test('CRLF·단독 CR 은 LF 가 되고 map 은 원문을 가리킨다', () => {
  for (const src of [BASE.split(LF).join(CR + LF), BASE.split(LF).join(CR)]) {
    const n = normalizeLineEndings(src)
    assert.equal(n.text, BASE)
    assert.equal(n.changed, true)
    assert.equal(n.text.includes(CR), false)
    assert.equal(n.u16Map[n.u16Map.length - 1], src.length, '끝 경계가 원문 길이여야 한다')
  }
})

test('astral 문자가 있어도 map 이 밀리지 않는다', () => {
  const src = `가${String.fromCodePoint(0x1f600)}${CR}${LF}나`
  const n = normalizeLineEndings(src)
  assert.equal(n.text, `가${String.fromCodePoint(0x1f600)}${LF}나`)
  assert.equal(n.u16Map[n.u16Map.length - 1], src.length)
  assert.equal(n.u16Map.length, n.text.length + 1)
})

test('원문 문자열은 어디서도 바뀌지 않는다', () => {
  const src = BASE.split(LF).join(CR + LF)
  const before = src
  normalizeLineEndings(src)
  parseTtsScript(src)
  assert.equal(src, before)
})

test('세 표기가 같은 계획과 같은 plan SHA 를 만든다', () => {
  const v = variants(BASE)
  const plans = Object.fromEntries(Object.entries(v).map(([k, t]) => [k, okPlan(t)]))
  assert.equal(plans.crlf.fullSha256, plans.lf.fullSha256)
  assert.equal(plans.cr.fullSha256, plans.lf.fullSha256)
  for (const k of ['crlf', 'cr'] as const) {
    assert.deepEqual(
      plans[k].segments.map((s: { spokenText: string }) => s.spokenText),
      plans.lf.segments.map((s: { spokenText: string }) => s.spokenText))
    for (const s of plans[k].segments as { spokenText: string }[]) {
      assert.equal(s.spokenText.includes(CR), false, 'CR 이 발화 텍스트에 남았다')
    }
  }
})

test('offset 은 정규화 좌표가 아니라 원문 좌표다', () => {
  for (const [k, t] of Object.entries(variants(BASE))) {
    const plan = okPlan(t)
    for (const s of plan.segments as {
      spokenText: string; offset: { uiStartUtf16: number; uiEndUtf16: number }
    }[]) {
      const got = t.slice(s.offset.uiStartUtf16, s.offset.uiEndUtf16)
      assert.equal(got.includes(CR), false, `${k}: 원문 조각에 CR 이 들어갔다`)
      assert.equal(got.includes(s.spokenText), true, `${k}: offset 이 발화 구간을 벗어났다`)
    }
  }
})

test('다중 문단에서 offset 이 한 글자씩 밀리지 않는다', () => {
  const lf = BASE
  const crlf = BASE.split(LF).join(CR + LF)
  const a = okPlan(lf).segments as { offset: { uiStartUtf16: number; uiEndUtf16: number } }[]
  const b = okPlan(crlf).segments as { offset: { uiStartUtf16: number; uiEndUtf16: number } }[]
  assert.equal(a.length, b.length)
  a.forEach((x, i) => {
    assert.equal(lf.slice(x.offset.uiStartUtf16, x.offset.uiEndUtf16),
      crlf.slice(b[i].offset.uiStartUtf16, b[i].offset.uiEndUtf16),
      `segment ${i} 좌표가 밀렸다`)
  })
})

test('고정 벡터에 LF·CRLF·CR 동형이 못박혀 있다', () => {
  const pinned = JSON.parse(readFileSync(
    fileURLToPath(new URL('./ttsGrammar.parity-hashes.json', import.meta.url)), 'utf-8'),
  ) as Record<string, string>
  const lfKey = `첫 줄입니다.${LF}둘째 줄입니다.${LF}${LF}셋째 줄입니다.`
  const crlfKey = lfKey.split(LF).join(CR + LF)
  const crKey = lfKey.split(LF).join(CR)
  for (const k of [lfKey, crlfKey, crKey]) {
    assert.ok(k in pinned, '동형 벡터가 고정되지 않았다')
  }
  assert.equal(pinned[crlfKey], pinned[lfKey])
  assert.equal(pinned[crKey], pinned[lfKey])
})
