// 분할 편집기가 **있는 이벤트 이름만** 쓰는가.
//
// ★2026-09-27 검수로 드러난 결함: `region-update-end` 에 묶기 종료를 걸어 두었는데
//   그 이름은 **이 플러그인에 없다.** 그래서 묶기가 한 번도 끊기지 않았고,
//   같은 경계를 두 번 따로 끌면 되돌리기 한 번에 둘이 뭉쳐 돌아갔다.
//   오타나 없는 이름은 조용히 아무 일도 하지 않으므로 화면만 봐서는 알 수 없다.
//
// ★그래서 **설치된 플러그인이 내는 이름 목록**과 대조한다. 목록이 바뀌면 여기서 걸린다.
//   (드래그 자체는 `shared/splitHistory` 검사가 본다. 실제 region 은 그림자 DOM 안
//    몇 픽셀짜리라 마우스로 잡는 검사는 흔들린다.)
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

/** 편집기가 `regions.on(...)` / `regions.un(...)` 으로 쓰는 이름들. */
const used = [...editor.matchAll(/regions\.(?:on|un)\(\s*'([^']+)'/g)].map((m) => m[1])

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

test('끄는 중과 놓았을 때를 **둘 다** 듣는다', () => {
  assert.ok(used.includes('region-update'), '끄는 중(region-update)을 듣지 않는다')
  assert.ok(used.includes('region-updated'), '놓았을 때(region-updated)를 듣지 않는다')
})

test('등록한 것은 모두 해제한다 — 핸들러를 남기지 않는다', () => {
  const on = [...editor.matchAll(/regions\.on\(\s*'([^']+)'/g)].map((m) => m[1])
  const un = [...editor.matchAll(/regions\.un\(\s*'([^']+)'/g)].map((m) => m[1])
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
