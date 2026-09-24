// 설정 저장의 **응답을 버리지 않는** 통로와, 그 실수를 막는 소스 검사.
//
// ★왜 있는가(2026-09-24 감사): `settings.set` 은 실패를 예외로 던지지 않고
//   `{ok:false, code}` 를 돌려준다. `void ...set(...)` 로 부르면 실패가 사라지고,
//   설정 파일이 깨진 뒤로는 작업이 하나도 저장되지 않는데 화면이 아무 말도 안 한다.
//   같은 사고를 2026-09-09 에 고쳤는데 **세 곳이 그대로 남아 있었다.**
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { saveSetting, saveFailureText } from './saveSetting.ts'

const ok = async () => ({ ok: true })
const bad = async () => ({ ok: false, code: 'SETTINGS_CORRUPT' })
const badNoCode = async () => ({ ok: false })
const boom = async () => { throw new Error('디스크가 꽉 찼습니다') }

test('성공이면 사유가 없다', async () => {
  assert.equal(await saveSetting(ok, 'k', { a: 1 }), null)
})

test('실패하면 사유 코드를 돌려준다', async () => {
  assert.equal(await saveSetting(bad, 'k', {}), 'SETTINGS_CORRUPT')
})

test('코드가 없어도 실패를 성공으로 읽지 않는다', async () => {
  assert.equal(await saveSetting(badNoCode, 'k', {}), 'SAVE_FAILED')
})

test('던져도 화면을 무너뜨리지 않는다 — 다만 조용히 넘기지도 않는다', async () => {
  const why = await saveSetting(boom, 'k', {})
  assert.ok(why && why.includes('디스크'))
})

test('보일 문구는 무엇을 잃는지 먼저 말한다', () => {
  const t = saveFailureText('SETTINGS_CORRUPT')
  assert.ok(t.includes('손상'))
  assert.ok(t.includes('저장되지 않았습니다'), '무엇을 잃는지 말해야 한다')
  assert.equal(saveFailureText(null), '', '성공이면 아무 말도 하지 않는다')
})

test('모르는 코드도 숨기지 않는다', () => {
  assert.ok(saveFailureText('WEIRD').includes('WEIRD'))
})

// ── 같은 실수가 다시 들어오지 못하게 ──────────────────────────────────────
//
// ★한 번 고친 사고가 세 곳에 남아 있었다. 사람이 기억으로 막을 수 없다.
test('응답을 버리는 표기가 소스에 없다', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, '..')          // src/
  const bannedRe = /void\s+window\.api\.settings\.set\s*\(/
  const hits: string[] = []

  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(name)) continue
      const text = readFileSync(p, 'utf-8')
      // 이 검사 파일 자신과, 사연을 적어 둔 주석은 뺀다.
      if (p === fileURLToPath(import.meta.url)) continue
      for (const line of text.split('\n')) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue
        if (bannedRe.test(line)) hits.push(`${path.relative(root, p)}: ${line.trim()}`)
      }
    }
  }
  walk(root)
  assert.deepEqual(hits, [],
    `저장 실패가 조용히 사라진다 — saveSetting 을 쓰세요:\n${hits.join('\n')}`)
})
