// 설정 저장 허용 목록 — **화면이 쓰는 열쇠가 빠지면 조용히 거절된다.**
//
// ★왜 생겼나 (2026-09-28 실측)
//   전사 교정본(`transcriptDrafts`)과 대화 구간 수정본(`dialogueDrafts`)이
//   **만들어진 날부터 줄곧 저장되지 않고 있었다.** 목록에는 이름이 비슷한
//   `transcriptEdits`·`dialogueEdits` 만 있었다 — 서로 다른 열쇠다.
//
//   `settings:set` 은 모르는 열쇠를 `SETTINGS_KEY_NOT_ALLOWED` 로 **조용히 거절한다.**
//   새 열쇠를 만든 사람이 목록을 기억해야만 동작하는 구조라, 두 번 다 잊혔다.
//
// ★이 검사가 붙드는 것
//   화면·훅이 `saveSetting(...settings.set, X, ...)` 로 저장하는 열쇠를 **소스에서 긁어**
//   허용 목록 글자와 대조한다. 새 열쇠를 넣고 목록을 잊으면 여기서 걸린다.
//
//   글자를 읽는 검사다 — 실행으로는 이 구멍을 못 잡는다(거절이 조용하기 때문에
//   화면 검사가 저장 성공으로 착각하고 지나간다).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(process.cwd(), 'src')
const AUDIO_IPC = join(SRC, 'main', 'ipc', 'audio.ipc.ts')

/** 폴더를 훑어 .ts/.tsx 를 모은다. 검사 파일은 뺀다 — 검사가 저장하지는 않는다. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { out.push(...sourceFiles(full)); continue }
    if (!/\.tsx?$/.test(name)) continue
    if (/\.(test|contract\.test|parity\.test)\.tsx?$/.test(name)) continue
    out.push(full)
  }
  return out
}

/** `NAME = 'value'` 꼴의 열쇠 상수를 모은다. 이름 → 실제 글자. */
function keyConstants(): Map<string, string> {
  const map = new Map<string, string>()
  for (const file of sourceFiles(join(SRC, 'shared'))) {
    const text = readFileSync(file, 'utf-8')
    const re = /export const ([A-Z][A-Z0-9_]*(?:STORAGE_KEY|_KEY))\s*=\s*'([^']+)'/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) map.set(m[1], m[2])
  }
  return map
}

/**
 * 렌더러가 **실제로 저장하는** 열쇠 상수 이름들.
 *
 * ★저장하는 **모양이 여럿**이다. 하나만 훑으면 나머지 자리가 통째로 사각지대가 된다 —
 *   처음 쓴 규칙은 네 자리만 보고 있었다.
 *     · saveSetting(window.api.settings.set, KEY, …)
 *     · window.api.settings.set(KEY, …)
 *     · window.api.settings.setSync(KEY, …)
 */
function savedKeyNames(): { name: string; file: string }[] {
  const found: { name: string; file: string }[] = []
  const shapes = [
    /saveSetting\(\s*window\.api\.settings\.setSync\s*,\s*([A-Z][A-Z0-9_]*)/g,
    /saveSetting\(\s*window\.api\.settings\.set\s*,\s*([A-Z][A-Z0-9_]*)/g,
    /window\.api\.settings\.setSync\(\s*([A-Z][A-Z0-9_]*)/g,
    /window\.api\.settings\.set\(\s*([A-Z][A-Z0-9_]*)/g,
  ]
  for (const file of sourceFiles(join(SRC, 'renderer'))) {
    const text = readFileSync(file, 'utf-8')
    for (const re of shapes) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) found.push({ name: m[1], file })
    }
  }
  return found
}

/** 허용 분기에 없는 열쇠 이름들. **순수 함수** — 이빨을 소스 손대지 않고 확인한다. */
function missingFrom(branch: string, names: readonly string[]): string[] {
  return [...new Set(names.filter((n) => !branch.includes(`key === ${n}`)))]
}

/**
 * 허용 분기의 본문만 잘라 낸다.
 *
 * ★끝을 **거절하는 줄**로 잡는다. 거절 코드 글자는 바로 위 주석에도 나오므로
 *   그냥 첫 등장에서 자르면 목록의 뒷부분이 통째로 빠진다 — 실제로 한 번 당했다.
 */
function allowBranch(allow: string): string {
  const from = allow.indexOf("ipcMain.handle('settings:set'")
  assert.ok(from > 0, '허용 분기를 찾지 못했다 — 이 검사를 먼저 고쳐라')
  const to = allow.indexOf("return { ok: false, code: 'SETTINGS_KEY_NOT_ALLOWED' }", from)
  assert.ok(to > from, '거절하는 줄을 찾지 못했다 — 이 검사를 먼저 고쳐라')
  return allow.slice(from, to)
}

test('★화면이 저장하는 열쇠가 하나도 빠짐없이 허용 목록에 있다', () => {
  const allow = readFileSync(AUDIO_IPC, 'utf-8')
  // 허용 분기만 본다 — 파일 어딘가에 이름이 스쳐 지나가는 것으로는 통과시키지 않는다.
  const branch = allowBranch(allow)

  const saved = savedKeyNames()
  const names = [...new Set(saved.map((x) => x.name))]
  // 실측 2026-09-28: 서로 다른 열쇠 6종. 이보다 적게 찾으면 긁는 규칙이 낡은 것이다.
  assert.ok(names.length >= 6,
    `저장하는 열쇠를 너무 적게 찾았다(${names.length}: ${names.join(', ')}) — 긁는 규칙이 낡았다`)

  assert.deepEqual(missingFrom(branch, names), [],
    '허용 목록에 없다 — 저장이 SETTINGS_KEY_NOT_ALLOWED 로 조용히 거절된다')
})

test('★이 검사에 이빨이 있다 — 열쇠가 빠지면 잡는다', () => {
  // 제품 소스를 건드리지 않고 확인한다. 사용자의 앱이 그 파일을 물고 있을 수 있다.
  const whole = allowBranch(readFileSync(AUDIO_IPC, 'utf-8'))
  const names = [...new Set(savedKeyNames().map((x) => x.name))]
  assert.deepEqual(missingFrom(whole, names), [], '지금은 빠진 것이 없다')

  for (const victim of names) {
    const broken = whole.split(`key === ${victim}`).join('key === 없는열쇠')
    assert.deepEqual(missingFrom(broken, names), [victim],
      `${victim} 를 빼도 잡지 못한다 — 이 검사는 이빨이 없다`)
  }
})

/**
 * `settings:get` 이 렌더러에게 **돌려주는** 열쇠 목록.
 *
 * ★저장 목록과 **따로** 있다. 여기서 빠지면 저장은 되는데 **다시 켜면 사라진다** —
 *   저장 실패보다 알아채기 어렵다(화면은 "저장했습니다" 라고 말한 뒤 조용히 잃는다).
 */
function readBranch(allow: string): string {
  const from = allow.indexOf("ipcMain.handle('settings:get'")
  assert.ok(from > 0, '읽기 분기를 찾지 못했다 — 이 검사를 먼저 고쳐라')
  const to = allow.indexOf('})', allow.indexOf('return {', from))
  assert.ok(to > from, '읽기 분기의 끝을 찾지 못했다')
  return allow.slice(from, to)
}

test('★화면이 저장하는 열쇠를 settings:get 도 전부 돌려준다', () => {
  const allow = readFileSync(AUDIO_IPC, 'utf-8')
  const branch = readBranch(allow)
  const names = [...new Set(savedKeyNames().map((x) => x.name))]
  const missing = names.filter((n) => !branch.includes(`[${n}]`))
  assert.deepEqual(missing, [],
    'settings:get 이 돌려주지 않는다 — 저장은 되는데 다시 켜면 사라진다')
})

test('★읽기 검사에도 이빨이 있다', () => {
  const branch = readBranch(readFileSync(AUDIO_IPC, 'utf-8'))
  const names = [...new Set(savedKeyNames().map((x) => x.name))]
  for (const victim of names) {
    const broken = branch.split(`[${victim}]`).join('[없는열쇠]')
    assert.deepEqual(names.filter((n) => !broken.includes(`[${n}]`)), [victim],
      `${victim} 를 빼도 잡지 못한다`)
  }
})

test('★이름이 비슷한 두 열쇠를 섞어 쓰지 않는다 (Edits ≠ Drafts)', () => {
  const keys = keyConstants()
  const pairs = [
    ['TRANSCRIPT_EDIT_STORAGE_KEY', 'TRANSCRIPT_DRAFTS_STORAGE_KEY'],
    ['DIALOGUE_EDIT_STORAGE_KEY', 'DIALOGUE_DRAFTS_STORAGE_KEY'],
  ]
  for (const [a, b] of pairs) {
    const va = keys.get(a)
    const vb = keys.get(b)
    assert.ok(va && vb, `열쇠 상수를 못 찾았다: ${a} / ${b}`)
    assert.notEqual(va, vb, `${a} 와 ${b} 가 같은 글자다 — 하나가 다른 하나를 덮는다`)
  }
})

test('허용 목록에 적힌 열쇠 상수가 실제로 존재한다', () => {
  const allow = readFileSync(AUDIO_IPC, 'utf-8')
  const branch = allowBranch(allow)
  const names = [...branch.matchAll(/key === ([A-Z][A-Z0-9_]*)/g)].map((m) => m[1])
  assert.ok(names.length >= 8, `허용 목록이 너무 짧다(${names.length}) — 분기를 잘못 잘랐다`)
  const keys = keyConstants()
  // pythonPath 는 위에서 따로 처리되고 상수가 아니다 — 목록에 나오지 않는다.
  const unknown = names.filter((n) => !keys.has(n) && !allow.includes(`const ${n} =`) && !allow.includes(`${n} }`))
  assert.deepEqual(unknown, [], '목록에 있는데 정의를 못 찾은 열쇠')
})
