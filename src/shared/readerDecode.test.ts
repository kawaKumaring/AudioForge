import test from 'node:test'
import assert from 'node:assert/strict'
// @ts-ignore TS5097: node --test 가 이 파일을 곧바로 읽는다(저장소 관례).
import { decodeBookText } from './readerDecode.ts'

// ★글 파일을 다시 저장하라고 떠넘기지 않는다 — 흔한 세 가지를 알아서 읽는다(2026-09-30).
const SAMPLE = '그는 문을 열었다.\r\n"누구세요?" 하고 물었다.\r\n漢字(한자) 123'
const u16le = (s: string) => new Uint8Array(Buffer.from(s, 'utf16le'))
const u16be = (s: string) => { const b = Buffer.from(s, 'utf16le'); for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t } return new Uint8Array(b) }
const cat = (...parts: ArrayLike<number>[]) => { const out: number[] = []; for (const p of parts) out.push(...Array.from(p)); return new Uint8Array(out) }

test('UTF-8 — 머리표가 있든 없든', () => {
  assert.deepEqual(decodeBookText(new TextEncoder().encode(SAMPLE)), { text: SAMPLE, encoding: 'utf-8' })
  assert.deepEqual(decodeBookText(cat([0xef, 0xbb, 0xbf], new TextEncoder().encode(SAMPLE))), { text: SAMPLE, encoding: 'utf-8' })
})

test('UTF-16 — 메모장의 "유니코드" 저장(머리표 있음) · 앞뒤 순서 둘 다', () => {
  assert.deepEqual(decodeBookText(cat([0xff, 0xfe], u16le(SAMPLE))), { text: SAMPLE, encoding: 'utf-16le' })
  assert.deepEqual(decodeBookText(cat([0xfe, 0xff], u16be(SAMPLE))), { text: SAMPLE, encoding: 'utf-16be' })
})

test('UTF-16 — 머리표가 없어도 띄어쓰기·줄바꿈 자리의 0 바이트로 알아본다', () => {
  assert.deepEqual(decodeBookText(u16le(SAMPLE)), { text: SAMPLE, encoding: 'utf-16le' })
  assert.deepEqual(decodeBookText(u16be(SAMPLE)), { text: SAMPLE, encoding: 'utf-16be' })
})

test('CP949(EUC-KR) — 옛 메모장·뷰어로 만든 한국어 글', () => {
  // "안녕하세요" + 줄바꿈 + "abc" — 바이트는 표준 표에서 그대로.
  const bytes = new Uint8Array([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4, 0x0d, 0x0a, 0x61, 0x62, 0x63])
  assert.deepEqual(decodeBookText(bytes), { text: '안녕하세요\r\nabc', encoding: 'cp949' })
})

test('★어느 것도 아니면 읽지 않는다 — 깨진 글을 소리로 읽어 주지 않는다', () => {
  assert.equal(decodeBookText(new Uint8Array([0x80, 0xff, 0x00, 0xff, 0x81])), null)
  // ★0 바이트 하나만으로 UTF-16 이라 읽었던 작은 깨진 파일(실측) — 0 과 짝인 것이 ASCII 가 아니다.
  assert.equal(decodeBookText(new Uint8Array([0x80, 0xff, 0x00, 0xff, 0x81, 0x0a, 0x80, 0xff])), null)
  // 읽기는 되는데 제어 문자가 섞이면 글이 아니다.
  assert.equal(decodeBookText(new Uint8Array([0x61, 0x00, 0x62, 0x01, 0x63])), null)
  // 머리표가 UTF-8 이라고 말하는데 속이 틀리면 믿지 않는다.
  assert.equal(decodeBookText(new Uint8Array([0xef, 0xbb, 0xbf, 0xff, 0xfe, 0xfd])), null)
})

test('영문만 있는 글은 UTF-8 로 읽는다(CP949 로 잘못 가지 않는다)', () => {
  assert.equal(decodeBookText(new TextEncoder().encode('Chapter 1\nIt was a dark night.'))?.encoding, 'utf-8')
})
