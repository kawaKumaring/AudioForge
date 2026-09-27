// 분할 편집기가 **있는 이벤트 이름만** 쓰는가.
//
// ★2026-09-27 검수로 드러난 결함: `region-update-end` 에 묶기 종료를 걸어 두었는데
//   그 이름은 **이 플러그인에 없다.** 그래서 묶기가 한 번도 끊기지 않았고,
//   같은 경계를 두 번 따로 끌면 되돌리기 한 번에 둘이 뭉쳐 돌아갔다.
//   오타나 없는 이름은 조용히 아무 일도 하지 않으므로 화면만 봐서는 알 수 없다.
//
// ★그래서 **설치된 플러그인이 내는 이름 목록**과 대조한다. 목록이 바뀌면 여기서 걸린다.
//   실제 포인터로 끄는 것은 `test/e2e/split-editing.component.mjs` 가 본다 — 여기는 보조다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const editor = readFileSync(join(ROOT, 'src/renderer/components/SplitEditor.tsx'), 'utf-8')
const pluginTypes = readFileSync(
  join(ROOT, 'node_modules/wavesurfer.js/dist/plugins/regions.d.ts'), 'utf-8')

/** 플러그인이 실제로 내는 이름들. */
const known = new Set(pluginTypes.match(/region-[a-z-]+/g) || [])

/** 주석을 걷어 낸 **실제 코드**. 설명글에 적은 이름·함수명을 사실로 세지 않는다. */
const code = editor.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

/** 편집기가 `regions.on(...)` / `regions.un(...)` 으로 쓰는 이름들. */
const used = [...code.matchAll(/regions\.(?:on|un)\(\s*'([^']+)'/g)].map((m) => m[1])

test('플러그인 이벤트 목록을 읽을 수 있다', () => {
  assert.ok(known.size >= 5, `이벤트 목록을 읽지 못했다(${known.size}개)`)
  assert.ok(known.has('region-updated'), '기대하던 이름이 목록에 없다')
})

test('편집기가 등록하는 이벤트가 있기는 하다', () => {
  assert.ok(used.length > 0, 'regions.on 등록을 찾지 못했다 — 검사가 헛돌고 있다')
})

// ★이것이 이 파일의 존재 이유다.
test('편집기가 **없는 이벤트 이름**을 쓰지 않는다', () => {
  const missing = used.filter((name) => !known.has(name))
  assert.deepEqual(missing, [],
    `이 플러그인에 없는 이름이다(조용히 아무 일도 하지 않는다): ${missing.join(', ')}`)
})

test('놓았을 때(region-updated)를 듣는다', () => {
  assert.ok(used.includes('region-updated'), '놓았을 때(region-updated)를 듣지 않는다')
})

// ★드래그가 끊기던 진짜 원인. 이름은 두 번째 문제였다.
test('끄는 **중**에는 상태를 건드리지 않는다', () => {
  assert.ok(!used.includes('region-update'),
    '끄는 중(region-update)에 상태를 바꾸면 아래 동기화가 끌던 선을 다시 만든다')
})

test('마커가 바뀔 때 선을 **전부 지웠다 다시 만들지 않는다**', () => {
  assert.ok(!/clearRegions\s*\(/.test(code),
    'clearRegions() 로 싹 지우면 끌고 있던 선까지 사라진다 — ID 별로 고쳐야 한다')
  assert.ok(/regions\.getRegions\s*\(/.test(code), 'ID 별 갱신을 하려면 현재 선 목록을 읽어야 한다')
  assert.ok(/\.setOptions\s*\(/.test(code), '남아 있는 선은 새로 만들지 말고 자리만 고쳐야 한다')
})

test('등록한 것은 모두 해제한다 — 핸들러를 남기지 않는다', () => {
  const on = [...code.matchAll(/regions\.on\(\s*'([^']+)'/g)].map((m) => m[1])
  const un = [...code.matchAll(/regions\.un\(\s*'([^']+)'/g)].map((m) => m[1])
  for (const name of on) {
    assert.ok(un.includes(name), `${name} 을(를) 등록만 하고 해제하지 않는다`)
  }
})

// 없는 이름을 쓰면 이 검사가 실제로 잡는지 — 검사의 이빨을 확인한다(파일은 건드리지 않는다).
test('없는 이름을 쓰면 잡힌다', () => {
  const pretend = ['region-update', 'region-update-end']
  const missing = pretend.filter((name) => !known.has(name))
  assert.deepEqual(missing, ['region-update-end'], '이 검사가 없는 이름을 놓친다')
})
