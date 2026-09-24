// 대화상자 시작 폴더 계약 — **비어서 돌아가지 않는다**가 핵심이다.
//
// ★왜(2026-09-25 사용자 신고): 시작 폴더를 주지 않으면 운영체제가 정하고, 그 기억은
//   실행 파일 이름 단위라 같은 방식으로 띄운 다른 툴과 섞인다.
//   2026-08-16 에 같은 신고로 한 자리를 고쳤는데, **그 한 자리마저** 기억해 둔 폴더가
//   저장소 이동으로 사라지면서 값이 비어 무력화돼 있었다(실측).
//   그러니 슬롯을 나누는 것보다 **빈손으로 돌아가지 않는 것**이 먼저다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FOLDER_SLOTS, SLOT_KEY, nearestExisting, rememberDir, rememberFile,
  saveTarget, startDir, type FolderHost, type FolderSlot,
} from './dialogFolders.ts'

/** 가짜 디스크·설정. 실제 파일을 만들지 않는다. */
function host(opts: {
  dirs?: string[]
  settings?: Record<string, unknown>
  fallback?: Partial<Record<FolderSlot, string>>
  writeThrows?: boolean
} = {}): FolderHost & { saved: Record<string, string>; writes: number } {
  const dirs = new Set(opts.dirs ?? [])
  const settings: Record<string, unknown> = { ...(opts.settings ?? {}) }
  const saved: Record<string, string> = {}
  const h = {
    saved,
    writes: 0,
    read: (k: string) => settings[k],
    write: (k: string, v: string) => {
      if (opts.writeThrows) throw new Error('디스크가 꽉 찼습니다')
      h.writes += 1
      settings[k] = v
      saved[k] = v
    },
    fallback: (s: FolderSlot) => opts.fallback?.[s],
    exists: (p: string) => dirs.has(p),
  }
  return h
}

const J = (a: string, b: string) => `${a}\\${b}`

test('기억한 폴더가 살아 있으면 그것을 쓴다', () => {
  const h = host({ dirs: ['E:\\소리'], settings: { lastDir: 'E:\\소리' } })
  assert.equal(startDir(h, 'source'), 'E:\\소리')
})

// ★이것이 이번 신고의 실제 원인이다 — 저장소를 옮겨 기억한 폴더가 사라졌다.
test('기억한 폴더가 사라졌으면 **살아 있는 윗폴더**로 내려앉는다', () => {
  const h = host({
    dirs: ['E:\\작업'],
    settings: { lastDir: 'E:\\작업\\옛날\\더 옛날\\out' },
  })
  assert.equal(startDir(h, 'source'), 'E:\\작업',
    '사라진 폴더에서 빈손으로 돌아가면 운영체제가 정하게 된다')
})

test('윗폴더도 전부 없으면 마지막 보루로 간다', () => {
  const h = host({
    dirs: ['C:\\내음악'],
    settings: { lastDir: 'Z:\\뽑아버린드라이브\\a' },
    fallback: { source: 'C:\\내음악' },
  })
  assert.equal(startDir(h, 'source'), 'C:\\내음악')
})

test('마지막 보루조차 없으면 그때만 비운다', () => {
  const h = host({ settings: {} })
  assert.equal(startDir(h, 'source'), undefined)
})

// ★한 통에 몰면 서로를 덮는다 — 영상을 고른 뒤 음원을 고르면 영상 폴더가 뜬다.
test('용도마다 따로 기억한다', () => {
  const h = host({
    dirs: ['E:\\소리', 'E:\\영상'],
    settings: { lastDir: 'E:\\소리', lastVideoDir: 'E:\\영상' },
  })
  assert.equal(startDir(h, 'source'), 'E:\\소리')
  assert.equal(startDir(h, 'video'), 'E:\\영상')
})

test('그 용도에 기억이 없으면 음원 폴더를 빌려 본다 — 대개 같은 자리에 있다', () => {
  const h = host({ dirs: ['E:\\소리'], settings: { lastDir: 'E:\\소리' } })
  for (const s of ['voice', 'video', 'export', 'restore'] as const) {
    assert.equal(startDir(h, s), 'E:\\소리', `${s}: 빌려 오지 않았다`)
  }
})

// ★파이썬 실행 파일을 음원 폴더에서 찾게 하면 더 헷갈린다.
test('파이썬 경로는 음원 폴더를 빌리지 않는다', () => {
  const h = host({ dirs: ['E:\\소리'], settings: { lastDir: 'E:\\소리' } })
  assert.equal(startDir(h, 'python'), undefined)
})

test('빌려 오기가 제자리를 돌지 않는다', () => {
  const h = host({ settings: {} })
  for (const s of FOLDER_SLOTS) assert.equal(startDir(h, s), undefined)
})

test('고른 파일에서 폴더만 기억한다', () => {
  const h = host({ dirs: ['E:\\소리'] })
  rememberFile(h, 'source', 'E:\\소리\\a.wav')
  assert.equal(h.saved[SLOT_KEY.source], 'E:\\소리')
})

// ★죽은 경로를 기억하면 다음에 또 빈손이 된다.
test('없는 폴더는 기억하지 않는다', () => {
  const h = host({ dirs: [] })
  rememberDir(h, 'source', 'E:\\없는곳')
  assert.deepEqual(h.saved, {})
})

test('같은 값을 다시 쓰지 않는다 — 설정 파일을 헛되이 건드리지 않는다', () => {
  const h = host({ dirs: ['E:\\소리'], settings: { lastDir: 'E:\\소리' } })
  rememberDir(h, 'source', 'E:\\소리')
  assert.equal(h.writes, 0)
})

// ★폴더 기억 실패가 작업을 멈추면 안 된다.
test('쓰다 실패해도 던지지 않는다', () => {
  const h = host({ dirs: ['E:\\소리'], writeThrows: true })
  assert.doesNotThrow(() => rememberDir(h, 'source', 'E:\\소리'))
})

// ★파일 이름만 주면 폴더는 여전히 운영체제가 정한다 — 실제로 두 자리가 그랬다.
test('저장 대화상자는 폴더 + 파일 이름을 함께 준다', () => {
  const h = host({ dirs: ['E:\\내보낸것'], settings: { lastExportDir: 'E:\\내보낸것' } })
  assert.equal(saveTarget(h, 'export', '더빙.mp4', J), 'E:\\내보낸것\\더빙.mp4')
})

test('줄 폴더가 없으면 파일 이름만 준다 — 그때는 어쩔 수 없다', () => {
  const h = host({})
  assert.equal(saveTarget(h, 'export', '더빙.mp4', J), '더빙.mp4')
})

test('옛 이름을 버리지 않는다 — 쓰던 값이 그대로 살아난다', () => {
  assert.equal(SLOT_KEY.source, 'lastDir', '옛 설정 키를 바꾸면 쓰던 기억이 사라진다')
})

test('윗폴더 찾기가 끝없이 돌지 않는다', () => {
  const h = host({ dirs: [] })
  assert.equal(nearestExisting(h, 'E:\\'), undefined)
  assert.equal(nearestExisting(h, undefined), undefined)
})

// ── 본체가 실제로 이것을 쓰는가 ──────────────────────────────────────────
//
// ★2026-08-16 에 같은 신고로 고쳤는데 **아홉 자리 중 하나만** 덮었다.
//   파일 하나만 보는 검사는 두 번째 자리를 놓친다. 그래서 대화상자를 **전부 세어**
//   하나라도 시작 폴더를 빼먹으면 울리게 한다.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function mainSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p2 = path.join(dir, name)
      if (statSync(p2).isDirectory()) { walk(p2); continue }
      if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue
      out.push({ rel: path.relative(MAIN, p2).split(path.sep).join('/'), text: readFileSync(p2, 'utf-8') })
    }
  }
  walk(MAIN)
  return out
}

test('파일 대화상자는 **하나도 빠짐없이** 시작 폴더를 준다', () => {
  const bad: string[] = []
  let seen = 0
  for (const f of mainSources()) {
    const flat = f.text.split(/\r?\n/).join(' ')
    for (const m of flat.matchAll(/dialog\.show(?:Open|Save)Dialog\(/g)) {
      seen += 1
      // 호출 한 덩어리를 보고 defaultPath 가 있는지 센다.
      const chunk = flat.slice(m.index!, m.index! + 420)
      if (!chunk.includes('defaultPath')) bad.push(`${f.rel} :: ${chunk.slice(0, 90)}`)
    }
  }
  assert.ok(seen >= 9, `대화상자를 ${seen}개밖에 못 찾았다 — 검사가 눈이 멀었다`)
  assert.deepEqual(bad, [], `시작 폴더를 주지 않으면 **어디서 열릴지 우리가 정하지 못한다**: ${bad.join(', ')}`)
})

// ★저장 대화상자는 파일 이름만 주면 폴더를 운영체제가 정한다 — 실제로 두 곳이 그랬다.
test('저장 대화상자는 폴더까지 붙인다', () => {
  const bad: string[] = []
  for (const f of mainSources()) {
    const flat = f.text.split(/\r?\n/).join(' ')
    for (const m of flat.matchAll(/dialog\.showSaveDialog\(/g)) {
      const chunk = flat.slice(m.index!, m.index! + 420)
      if (!chunk.includes('saveTarget(') && !chunk.includes('join(')) {
        bad.push(`${f.rel} :: ${chunk.slice(0, 90)}`)
      }
    }
  }
  assert.deepEqual(bad, [], `파일 이름만 주면 폴더는 운영체제가 정한다: ${bad.join(', ')}`)
})

// ★기억 통로가 둘이면 한쪽이 기억한 것을 다른 쪽이 모른다.
test('폴더 기억은 한 창구를 함께 쓴다', () => {
  const audio = readFileSync(path.join(MAIN, 'ipc', 'audio.ipc.ts'), 'utf-8')
  assert.ok(audio.includes('export function dialogFolderHost'),
    'audio.ipc 가 기억 창구를 내보내지 않는다')
  const index = readFileSync(path.join(MAIN, 'index.ts'), 'utf-8')
  assert.ok(index.includes('dialogFolderHost()'), '본체 배선이 같은 창구를 넘기지 않는다')
})
