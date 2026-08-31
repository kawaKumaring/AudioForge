// E2E 가 **저장소 밖**을 보지 않는지 고정한다.
//
// 왜 필요한가
// -----------
// 기본 E2E 사슬이 작업 트리에 없는 자산을 찾다 멈추길래, 후보 경로에
// `../../AudioForge/resources/...` 를 넣어 통과시킨 적이 있다. 그 자산은 저장소에 추적되지
// 않는 사용자 소유 파일이고, 경로도 이 PC 의 배치에만 맞는다. 그런데도 detached clean
// worktree 에서 초록이 나왔다 — 상대 경로가 그 밖으로 뻗어 같은 파일에 닿았기 때문이다.
// clean clone·다른 PC·CI 에서는 재현되지 않는 검증이 초록으로 보이는 것이 가장 나쁘다.
//
// 그래서 규칙을 코드로 못 박는다.
//   · 절대 경로(드라이브 문자, `\\\\` UNC, `/` 시작) 금지
//   · 저장소 밖으로 나가는 상대 경로 금지 — 단 `test/e2e` 기준으로 저장소 안을 가리키는
//     `..` 두 단계(= repo root)는 정상이다
//   · 자산이 필요하면 저장소 안의 자리이거나 **명시 환경 변수**여야 한다
//
// 자산이 없을 때의 올바른 결말은 '조용한 초록' 이 아니라 전제 미충족(exit 2)이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const E2E_DIR = fileURLToPath(new URL('../../test/e2e/', import.meta.url))
// 검사 대상은 **실제로 앱을 띄우고 자산을 여는** E2E 와 그 공용 helper 다.
// `*.test.mjs` 는 문자열 파서 단위 테스트라 경로가 데이터로만 쓰인다 — 그 안의 경로는
// 파일을 열지 않으므로 이 규칙의 대상이 아니다.
const FILES = readdirSync(E2E_DIR)
  .filter((f) => f.endsWith('.e2e.mjs') || f === '_e2e-helper.mjs')

/** 코드 줄만 본다 — 주석에서 문제를 설명하는 것까지 막으면 이유를 적을 수 없다. */
function codeLines(src: string): { n: number; text: string }[] {
  return src.split(/\r?\n/)
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.text))
}

test('E2E 목록이 비어 있지 않다(검사가 헛돌지 않게)', () => {
  assert.ok(FILES.length > 5, `E2E 파일 ${FILES.length}개`)
})

test('E2E 가 이 PC 에 실재하는 절대 경로를 박아 두지 않는다', () => {
  // 존재하지 않는 가짜 경로(`X:/in.wav`, `Z:/definitely/missing.bin`)는 '없는 경로' 자체가
  // 검사 대상이라 정상이다. 문제는 **이 기계에 실제로 있는 것**을 가리키는 경로다 —
  // 그러면 이 기계에서만 초록이 된다. 그래서 실재 여부로 가른다.
  // 자산을 가진 기계에서 실패하므로, 고칠 수 있는 사람 앞에서 드러난다.
  // 역슬래시는 fromCharCode 로 만든다 — 소스에 직접 쓰면 도구를 거치며 escape 가 어긋난다.
  const BS = String.fromCharCode(92)
  const DRIVE = new RegExp(`['"\`]([A-Za-z]:[${BS}${BS}/][^'"\`]*)['"\`]`, 'g')
  const SEP = new RegExp(`[${BS}${BS}/]`)
  const bad: string[] = []
  for (const f of FILES) {
    for (const l of codeLines(readFileSync(join(E2E_DIR, f), 'utf-8'))) {
      for (const m of l.text.matchAll(DRIVE)) {
        const raw = m[1].split(BS + BS).join(BS)
        // 경로 전체는 남기지 않는다 — 드라이브와 파일명이면 어디를 고칠지 충분하다.
        if (existsSync(raw)) bad.push(`${f}:${l.n} ${raw.slice(0, 3)}…${raw.split(SEP).pop()}`)
      }
    }
  }
  assert.deepEqual(bad, [],
    `이 PC 에만 있는 경로에 기대면 다른 곳에서 재현되지 않는다:\n${bad.join('\n')}`)
})

test('E2E 가 저장소 밖 자산을 찾아 나가지 않는다', () => {
  const bad: string[] = []
  for (const f of FILES) {
    for (const l of codeLines(readFileSync(join(E2E_DIR, f), 'utf-8'))) {
      // 본체 저장소 이름을 경로 조각으로 쓰는 순간 그 PC 의 배치에 묶인다.
      // 경로 조각으로 쓰인 것만 본다 — `includes('AudioForge')` 같은 문구 검사는 정상이다.
      if (/,\s*['"`]AudioForge['"`]/.test(l.text)) bad.push(`${f}:${l.n} 본체 저장소 경로 조각`)
      // `APP` 기준으로 두 단계 이상 올라가면 저장소 밖이다.
      if (/APP\s*,\s*['"`]\.\.['"`]\s*,\s*['"`]\.\.['"`]/.test(l.text)) {
        bad.push(`${f}:${l.n} 저장소 밖으로 올라가는 상대 경로`)
      }
    }
  }
  assert.deepEqual(bad, [],
    `추적되지 않은 사용자 자산에 기대면 clean clone 에서 재현되지 않는다:\n${bad.join('\n')}`)
})

test('음성이 필요한 E2E 는 저장소가 가진 fixture 만 쓴다', () => {
  // 이 둘은 참조 클립 생성(무음 경계 + 전사)을 지나야 해서 실제 말이 든 오디오가 필요하다.
  // 그 자산은 이제 저장소 안에 있다 — 밖을 보지 않으므로 어디서 받아도 같은 결과가 난다.
  for (const f of ['synthesize.e2e.mjs', 'reset-cleanup.e2e.mjs']) {
    const src = readFileSync(join(E2E_DIR, f), 'utf-8')
    assert.ok(src.includes("'test', 'fixtures', 'audio'"), `${f}: 저장소 fixture 를 써야 한다`)
    assert.ok(!src.includes('AF_E2E_REFERENCE'),
      `${f}: 바깥 자산으로 갈아탈 우회로를 남기지 않는다`)
    assert.ok(/process\.exit\(2\)/.test(src), `${f}: fixture 가 없으면 멈춰야 한다`)
  }
})

test('음성 fixture 두 개가 각자의 계약대로 실재한다', () => {
  // 목적이 다르므로 파일도 둘이다. 7.5초는 3~10초 band 라 앱이 원본을 그대로 참조로 쓰는
  // `valid_whole` 경로를, 18초는 구간을 잘라 파생 클립을 만드는 `needs_region` 경로를 탄다.
  // 하나로 합치면 두 경로 중 하나는 검증하지 못한다.
  const cases = [
    { name: 'ko-speech-7s.wav', min: 5, max: 8 },
    { name: 'ko-speech-region-18s.wav', min: 10.001, max: 20 },
  ]
  for (const c of cases) {
    const p = fileURLToPath(new URL(`../../test/fixtures/audio/${c.name}`, import.meta.url))
    assert.ok(existsSync(p), `${c.name} 이 저장소에 있어야 한다`)
    const buf = readFileSync(p)
    // RIFF/WAVE 헤더에서 형식과 길이를 읽는다(디코딩하지 않는다).
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF', c.name)
    assert.equal(buf.subarray(8, 12).toString('ascii'), 'WAVE', c.name)
    assert.equal(buf.readUInt16LE(20), 1, `${c.name}: PCM 이어야 한다`)
    assert.equal(buf.readUInt16LE(22), 1, `${c.name}: mono 여야 한다`)
    assert.equal(buf.readUInt32LE(24), 24000, `${c.name}: 24kHz 여야 한다`)
    assert.equal(buf.readUInt16LE(34), 16, `${c.name}: 16-bit 여야 한다`)
    const seconds = buf.readUInt32LE(40) / (24000 * 2)
    assert.ok(seconds >= c.min && seconds <= c.max,
      `${c.name}: ${c.min}~${c.max}초여야 한다 (실제 ${seconds.toFixed(2)}초)`)
  }
})

test('두 E2E 가 서로 다른 fixture 를 쓴다', () => {
  const syn = readFileSync(join(E2E_DIR, 'synthesize.e2e.mjs'), 'utf-8')
  const rst = readFileSync(join(E2E_DIR, 'reset-cleanup.e2e.mjs'), 'utf-8')
  assert.ok(syn.includes("'ko-speech-7s.wav'"), 'synthesize 는 valid_whole 경로용 7.5초')
  assert.ok(rst.includes("'ko-speech-region-18s.wav'"), 'reset-cleanup 은 needs_region 경로용 18초')
})

test('대본 fixture 는 환경 변수로만 받는다', () => {
  for (const f of ['analysis-lifecycle.e2e.mjs', 'analysis-phase45.e2e.mjs']) {
    const src = readFileSync(join(E2E_DIR, f), 'utf-8')
    assert.ok(/AF_E2E_(GOBACK|SAMPLE4)_SCRIPT/.test(src),
      `${f}: 승인 대본 경로를 코드에 박지 않는다`)
    assert.ok(!/goback-longform\.txt['"`]\s*\)/.test(src),
      `${f}: 대본 파일 경로를 직접 조립하지 않는다`)
  }
})
