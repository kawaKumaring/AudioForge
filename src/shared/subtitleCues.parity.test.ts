// 자막 손질이 **파이썬과 같은 답을 내는지 실제로 대조한다.**
//
// ★왜 이 방식인가(2026-09-24)
//   예제를 양쪽에 따로 적는 미러 검사는 이미 실패한 적이 있다 —
//   역슬래시 예제가 **양쪽 다 없어서** 파일 이름 규칙이 갈라진 채 지나갔다.
//   그래서 여기서는 같은 입력을 **두 구현에 실제로 넣고** 결과를 견준다.
//
//   파이썬을 못 부르는 환경이면 **건너뛰되 그 사실을 말한다** —
//   조용히 통과하면 없는 보증을 있다고 믿게 된다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCues, pickLimits, isDenseScript, toSrt, wrapText } from './subtitleCues.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')

/** 견줄 재료 — 언어·길이·붙은 정도를 섞는다. */
const CASES: Array<{ name: string; rows: Array<{ start: number; end: number; text: string }> }> = [
  { name: '한국어 보통', rows: [
    { start: 0, end: 2.0, text: '안녕하세요. 오늘은 날씨가 참 좋네요.' },
    { start: 3.0, end: 5.0, text: '네, 그러게요.' },
  ] },
  { name: '한 줄이 길다', rows: [{ start: 0, end: 5, text: '가'.repeat(35) }] },
  { name: '영어', rows: [
    { start: 0, end: 6, text: 'The wind comes over the hill and carries the sound of the sea' },
  ] },
  { name: '너무 짧은 큐', rows: [
    { start: 0, end: 0.2, text: '짧다' },
    { start: 0.5, end: 2.0, text: '바로 다음' },
  ] },
  // ★2026-09-24 2차 감사: 재료가 전부 start=0 이라 길이/절대시각 혼동을 지나쳤다.
  //   **파리티 검사는 '같음' 을 보증하지 '맞음' 을 보증하지 않는다** — 양쪽이
  //   같이 틀리면 대조는 통과한다. 그래서 start>0 재료를 넣는다.
  { name: '시작이 0이 아닌 짧은 큐', rows: [
    { start: 5.0, end: 5.6, text: '네' }, { start: 7.0, end: 9.0, text: '다음 문장입니다' },
  ] },
  { name: '시작이 0이 아니고 바짝 붙음', rows: [
    { start: 5.0, end: 5.6, text: '네' }, { start: 5.9, end: 7.0, text: '바짝' },
  ] },
  { name: '너무 긴 큐', rows: [{ start: 0, end: 30, text: '길다' }] },
  { name: '겹치는 큐', rows: [
    { start: 0, end: 4, text: '앞' }, { start: 2, end: 5, text: '뒤' },
  ] },
  { name: '너무 빠름', rows: [{ start: 0, end: 1, text: '가'.repeat(40) }] },
  { name: '빈 줄 섞임', rows: [
    { start: 0, end: 1, text: '   ' }, { start: 2, end: 4, text: '있다' },
  ] },
  { name: '일본어', rows: [{ start: 0, end: 4, text: 'こんにちは。今日はいい天気ですね。' }] },
  { name: '문법 경계', rows: [
    { start: 0, end: 5, text: '바람이 불어오는 언덕에서 우리는 오래 기다렸다' },
  ] },
  { name: '공백 여럿', rows: [{ start: 0, end: 3, text: '가   나    다' }] },
  { name: '섞인 글', rows: [{ start: 0, end: 4, text: '그의 perfect한 연주에 놀랐다' }] },
]

const PY_SCRIPT = `
import io, json, os, sys
sys.path.insert(0, os.path.join(sys.argv[1], 'python'))
import subtitle_cues as sc
cases = json.loads(io.open(sys.argv[2], encoding='utf-8').read())
out = []
for c in cases:
    text = ' '.join(r['text'] for r in c['rows'])
    lim = sc.pick_limits(text)
    cues = sc.build_cues(c['rows'], max_cps=lim['max_cps'], max_chars=lim['max_chars'])
    out.append({
        'name': c['name'],
        'dense': sc.is_dense_script(text),
        'limits': lim,
        'cues': [{'start': round(x['start'], 6), 'end': round(x['end'], 6),
                  'lines': x['lines'], 'warnings': len(x['warnings'])} for x in cues],
        'srt': sc.to_srt(cues, lambda t: '%.3f' % t),
    })
print(json.dumps(out, ensure_ascii=False))
`

function runPython(): unknown[] | null {
  const casesPath = path.join(tmpdir(), 'af-subtitle-parity-cases.json')
  const scriptPath = path.join(tmpdir(), 'af-subtitle-parity.py')
  writeFileSync(casesPath, JSON.stringify(CASES), 'utf-8')
  writeFileSync(scriptPath, PY_SCRIPT, 'utf-8')
  for (const exe of ['python', 'python3']) {
    const r = spawnSync(exe, ['-X', 'utf8', scriptPath, REPO, casesPath], {
      encoding: 'utf-8', timeout: 120_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    if (r.status === 0 && r.stdout) return JSON.parse(r.stdout) as unknown[]
  }
  return null
}

test('파이썬 손질과 **같은 답**을 낸다', (t) => {
  const py = runPython()
  if (!py) {
    // ★조용히 통과하지 않는다 — 보증이 없다는 사실을 남긴다.
    t.skip('파이썬을 부르지 못해 대조하지 못했다 — 이 실행에는 파리티 보증이 없다')
    return
  }
  assert.equal(py.length, CASES.length)

  CASES.forEach((c, i) => {
    const want = py[i] as {
      dense: boolean
      limits: { max_cps: number; max_chars: number }
      cues: Array<{ start: number; end: number; lines: string[]; warnings: number }>
      srt: string
    }
    const text = c.rows.map((r) => r.text).join(' ')

    assert.equal(isDenseScript(text), want.dense, `${c.name}: 문자 종류 판정이 다르다`)
    const lim = pickLimits(text)
    assert.equal(lim.maxChars, want.limits.max_chars, `${c.name}: 줄 길이 상한이 다르다`)
    assert.equal(lim.maxCps, want.limits.max_cps, `${c.name}: 읽기 속도 상한이 다르다`)

    const got = buildCues(c.rows, { maxCps: lim.maxCps, maxChars: lim.maxChars })
    assert.equal(got.length, want.cues.length, `${c.name}: 큐 수가 다르다`)
    got.forEach((g, j) => {
      const w = want.cues[j]
      assert.ok(Math.abs(g.start - w.start) < 1e-6, `${c.name} #${j}: 시작이 다르다`)
      assert.ok(Math.abs(g.end - w.end) < 1e-6, `${c.name} #${j}: 끝이 다르다 (${g.end} vs ${w.end})`)
      assert.deepEqual(g.lines, w.lines, `${c.name} #${j}: 줄 나눔이 다르다`)
      assert.equal(g.warnings.length, w.warnings, `${c.name} #${j}: 경고 수가 다르다`)
    })

    assert.equal(toSrt(got, (x) => x.toFixed(3)), want.srt, `${c.name}: 자막 글이 다르다`)
  })
})

// ── 파이썬 없이도 도는 기본 검사 ─────────────────────────────────────────
test('글자를 잃지 않는다', () => {
  const src = '가'.repeat(100)
  assert.equal(wrapText(src, 20, 2).join('').replace(/ /g, ''), src)
})

test('빈 글은 빈 결과다', () => {
  assert.deepEqual(wrapText(''), [])
  assert.deepEqual(wrapText('   '), [])
})

test('시각이 없으면 몇 번째인지 말한다', () => {
  assert.throws(
    () => buildCues([{ start: 0, end: 1, text: '가' }, { text: '나' } as never]),
    /2번째/)
})
