'use strict'
// 검수 원문 연결(2026-10-09) — 기대 대사는 그 음원을 만든 실행 기록에서. 실제 MCP 표준입출력 · 합성 사인파 · 가짜 실행 기록 폴더만.
// 판정 넷(실행 출처 · 원문 저장 지문 · 전달문 근거 · 구간 대응)을 따로 본다. 반대 사례 포함.
// 실행: node test/e2e/audio-quality-source.cjs
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('node:assert/strict')
const ROOT = path.resolve(__dirname, '../..')
const dir = fs.mkdtempSync(path.join(ROOT, '_local/tmp/quality-source-'))
const LOCAL = path.join(dir, 'local'), RUNS = path.join(LOCAL, 'artifacts', 'runs')
process.env.AUDIOFORGE_LOCAL_ROOT = LOCAL              // 실행 기록 자리를 이 검사 폴더로(서버가 물려받는다)
const { McpClient } = require('../../tools/mcp/client.cjs')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

let freq = 0.03
function wav(name) {
  const n = 16000, b = Buffer.alloc(44 + n * 2); freq += 0.013
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i * freq) * 4000), 44 + i * 2)
  const p = path.join(dir, name + '.wav'); fs.writeFileSync(p, b); return p
}
const W = (d, rel, obj) => { const p = path.join(d, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj)); return { path: rel, sha256: sha(fs.readFileSync(p)) } }
/** 가짜 실행 기록 — chunk_publish 와 같은 모양. opts 로 근거를 하나씩 망가뜨린다. */
function run(id, raw, opts = {}) {
  const audio = wav(id), d = path.join(RUNS, id); fs.mkdirSync(d, { recursive: true })
  const arts = [W(d, 'script.private.json', { raw_text: raw })]
  let chunks = []
  if (opts.sent) {
    const segs = opts.sent.map((t, i) => ({ index: i, text: t, sha256: sha(t) }))
    if (opts.badSentSha) segs[0].sha256 = 'f'.repeat(64)
    arts.push(W(d, 'sent.private.json', { segments: segs }))
  }
  if (opts.chunks) {
    chunks = opts.chunks.map((t, i) => ({ chunk_index: i }))
    opts.chunks.forEach((t, i) => arts.push(W(d, `chunks/chunk-${String(i).padStart(3, '0')}.private.json`, { chunk_index: i, chunk_text: t, chunk_text_sha256: sha(t) })))
  }
  const m = { run_id: id, header: opts.noRawSha ? {} : { raw_text_sha256: sha(raw) }, result: { sha256: sha(fs.readFileSync(audio)) }, chunk_count: chunks.length, chunks, artifacts: arts }
  if (opts.mutate) opts.mutate(m, d)
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m))
  return audio
}
const RAW = '오늘은 7번째 수업이다.', OTHER = '오늘은 8번째 수업이다.', FIX = '오늘은 일곱 번째 수업이다.'
const A = run('run-a', RAW, { sent: [RAW] })                 // 보정 끔
const B = run('run-b', RAW, { sent: [FIX] })                 // 같은 원문, 보정한 글
const C = run('run-c', OTHER, { sent: [OTHER] })             // 원문이 다른 실행
const D = run('run-d', RAW)                                  // 전달문 기록 없음
const E = run('run-e', RAW, { sent: [RAW], badSentSha: true })   // 전달문 저장 지문 어긋남
const F = run('run-f', RAW, { noRawSha: true, sent: [RAW] })     // 원문 저장 지문 없음
const G = run('run-g', RAW, { chunks: ['오늘은 일곱 ', '번째 수업이다.'] })   // 배치 조각 — 정상
const H = run('run-h', RAW, { chunks: ['오늘은 일곱 ', '번째 수업이다.'], mutate: (m, d) => fs.rmSync(path.join(d, 'chunks/chunk-001.private.json')) })
const I = run('run-i', RAW, { chunks: ['오늘은 일곱 ', '번째 수업이다.'], mutate: (m, d) => { fs.writeFileSync(path.join(d, 'chunks/chunk-002.private.json'), JSON.stringify({ chunk_index: 1, chunk_text: 'x', chunk_text_sha256: sha('x') })) } })
const J = run('run-j', RAW, { chunks: ['오늘은 일곱 ', '번째 수업이다.'], mutate: (m) => { m.chunks = [{ chunk_index: 1 }, { chunk_index: 0 }] } })
const K = run('run-k', RAW, { chunks: ['오늘은 일곱 ', '번째 수업이다.'], mutate: (m) => { m.artifacts = m.artifacts.filter((x) => !x.path.startsWith('chunks/chunk-001')) } })
const L = run('run-l', RAW, { chunks: ['오늘은 일곱 ', '번째 수업이다.'], mutate: (m, d) => { fs.writeFileSync(path.join(d, 'chunks/chunk-000.private.json'), JSON.stringify({ chunk_index: 0, chunk_text: '바뀜 ', chunk_text_sha256: sha('바뀜 ') })) } })
const M = run('run-m', RAW, { sent: [RAW], mutate: (m) => { m.artifacts.push({ path: 'script.private.json', sha256: '0'.repeat(64) }) } })   // 원문 파일 중복 등록(충돌)
const N = wav('none')

;(async () => {
  const c = new McpClient(); await c.start()
  let n = 0; const ok = (v, label) => { assert.ok(v, label); n++; console.log('PASS', label) }
  const call = async (name, a) => { const r = await c.call('audio_quality_' + name, a); assert.equal(r.isError, false, r.text); return r.json }
  const fails = async (name, a, re) => { const r = await c.call('audio_quality_' + name, a); return r.isError && re.test(r.text) }
  const ts = async (p, extra = {}) => (await call('analyze', { path: p, ...extra })).textSource
  const confirmOmission = (reportId) => call('review', { reportId, action: 'append', start: 0, end: 0.4, category: 'omission', verdict: 'confirmed', basis: 'user_report', observer: 't', note: 'n', userStatement: '없다' })
  try {
    // ── 실행 출처 · 원문 ──
    const a = await call('analyze', { path: A })
    ok(a.textSource.runVerified && a.textSource.verified && a.textSource.rawTextState === 'verified' && a.textSource.sentState === 'verified' && a.textSource.windowAlignment === 'whole', '음원 지문으로 찾은 실행 기록 · 원문은 저장 지문으로 확인 · 전달문 확인')
    const prov = (await call('read', { reportId: a.reportId, section: 'provenance' })).data
    ok(prov.textSource.runId === 'run-a' && prov.textSource.sentSha256 === sha(RAW) && !('rawText' in prov.textSource), '출처에 실행 ID·지문(본문은 싣지 않음)')
    ok(await fails('analyze', { path: A, text: OTHER }, /원문과 다릅니다/), '넘긴 대사가 그 실행 원문과 다르면 거부')
    ok(await fails('analyze', { path: A, runId: 'run-c' }, /음원 지문이 분석 파일과 다릅니다/), '다른 실행 ID 는 거부(조각·파일 번호로 잇지 않음)')
    ok(await fails('analyze', { path: A, start: 0, end: 0.5, text: '없는 글' }, /원문 안에 없습니다/), '구간 대사가 원문에 없으면 거부')
    const f = await ts(F)
    ok(f.runVerified && !f.verified && f.rawTextState === 'stored_sha_missing', '원문 저장 지문 없음 → 새로 계산한 지문으로 확인하지 않음(출처는 맞음, 원문은 확인 불가)')
    fs.writeFileSync(path.join(RUNS, 'run-g', 'script.private.json'), JSON.stringify({ raw_text: RAW + '!' }))
    ok(await fails('analyze', { path: G }, /기록 손상/), '원문이 저장 지문과 다르면 거부')
    fs.writeFileSync(path.join(RUNS, 'run-g', 'script.private.json'), JSON.stringify({ raw_text: RAW }))

    // ── 전달문 근거 ──
    ok((await ts(D)).sentState === 'unrecorded', '전달문 기록 없음 = unrecorded')
    const e = await ts(E)
    ok(e.sentState === 'invalid' && e.sentIssues.includes('sent_sha_mismatch@0') && e.sentSha256 === null, '전달문 저장 지문 어긋남 = invalid(지문을 새로 만들어 대신하지 않음)')
    const g = await ts(G)
    ok(g.sentState === 'verified' && g.sentSha256 === sha('오늘은 일곱 \n번째 수업이다.'), '배치 조각 전달문 — manifest 조각·파일 지문·조각 지문 모두 맞음')
    ok((await ts(H)).sentIssues.includes('chunk_file_missing@1'), '조각 파일 누락')
    ok((await ts(I)).sentIssues.some((x) => x.startsWith('chunk_file_duplicate@1')), '조각 중복')
    ok((await ts(J)).sentIssues.includes('manifest_chunk_order'), '조각 순서 이상')
    ok((await ts(K)).sentIssues.includes('chunk_file_unlisted@1'), 'manifest 파일 목록에 없는 조각 파일 = 확인 불가')
    ok((await ts(L)).sentIssues.includes('chunk_file_file_sha_mismatch@0'), '조각 파일이 manifest 파일 지문과 다름')

    // ── 구간 대응 · 누락 확정 ──
    const u = await call('analyze', { path: N, text: RAW })
    ok(u.textSource.kind === 'unverified' && u.textSource.reason === 'no_run_record', '실행 기록이 없으면 출처 미확인')
    const r1 = await confirmOmission(u.reportId)
    ok(r1.verdict === 'uncertain' && r1.requestedVerdict === 'confirmed' && /출처/.test(r1.verdictHeldBecause) && r1.userStatement === '없다', '출처 미확인 → 누락 확정 막고 사용자 의견은 미확정으로 보존')
    const w1 = await call('analyze', { path: A, start: 0, end: 0.5, text: '7번째' })
    ok(w1.textSource.windowAlignment === 'unaligned' && w1.textSource.runVerified, '구간 대사가 원문에 들어 있어도 시간·대사 대응은 미확인')
    ok((await confirmOmission(w1.reportId)).verdictHeldBecause === '구간의 시간·대사 대응 근거 없음', '대응 미확인 구간 → 누락 확정 보류')
    const w2 = await call('analyze', { path: A, start: 0, end: 0.5 })
    ok((await confirmOmission(w2.reportId)).verdict === 'uncertain', '기대 대사 없는 구간 → 누락 확정 보류')
    ok((await confirmOmission((await call('analyze', { path: F })).reportId)).verdictHeldBecause === '원문 지문을 저장된 근거로 확인하지 못함', '원문 확인 불가 → 누락 확정 보류')
    const ok1 = await confirmOmission(a.reportId)
    ok(ok1.verdict === 'confirmed' && !ok1.verdictHeldBecause, '전체 구간·확인된 원문 → 사람 판정으로 누락 확정 가능')

    // ── 비교 ──
    const id = async (p) => (await call('analyze', { path: p })).reportId
    const rel = async (x, y, intendedDifference) => (await call('compare', { reportId: x, otherReportId: y, ...(intendedDifference ? { intendedDifference } : {}) })).textRelation
    const b = await id(B), cc = await id(C), d = await id(D), ee = await id(E), ff = await id(F)
    const s1 = await rel(a.reportId, b)
    ok(s1.status === 'same_source_different_sent' && s1.rawMatch === true && s1.sentMatch === false && s1.sentDiff.before === '7' && s1.sentDiff.after === '일곱 ' && s1.sentDiff.at === 4, '원문 같고 전달문 다름(서수 보정) — 바뀐 곳 표시')
    const s2 = await rel(a.reportId, d)
    ok(s2.status === 'same_source_sent_unrecorded' && s2.normal === true && s2.rawMatch === true && s2.sentMatch === null, '한쪽 전달문 기록 없음 → 같은 전달문이라 하지 않음(원문 일치는 따로) · 손상과 다른 상태')
    const s3 = await rel(a.reportId, ee)
    ok(s3.status === 'evidence_invalid' && s3.normal === false && s3.rawMatch === true && s3.sentMatch === null, '★전달문 손상 + 같은 원문 → normal=false(원문 일치 정보는 그대로)')
    const s3b = await rel(ee, cc, '숫자 7→8')
    ok(s3b.status === 'evidence_invalid' && s3b.normal === false && s3b.rawMatch === false && s3b.intendedDifference === '숫자 7→8', '★전달문 손상 + 다른 원문 + 사유 → normal=false')
    const mm = await call('analyze', { path: M })
    ok(mm.textSource.rawTextState === 'verified' && mm.textSource.rawFileListState === 'duplicate_listing' && mm.textSource.rawFileConflict && !mm.textSource.verified, '원문 지문 확인과 파일 목록 충돌을 구분해 보인다')
    const s6 = await rel(a.reportId, mm.reportId, '아무 사유')
    ok(s6.status === 'evidence_conflict' && s6.normal === false && s6.rawMatch === true, '★원문 파일 중복 등록(충돌) → 사유를 적어도 정상 판정 불가')
    const h6 = await confirmOmission(mm.reportId)
    ok(h6.verdict === 'uncertain' && /충돌/.test(h6.verdictHeldBecause), '★원문 파일 충돌 → 누락 확정 보류(의견 보존)')
    const h7 = await confirmOmission(ee)
    ok(h7.verdict === 'uncertain' && h7.verdictHeldBecause === '전달문 근거 손상', '★전달문 손상 → 누락 확정 보류(의견 보존)')
    ok((await rel(a.reportId, a.reportId)).status === 'same_text', '같은 실행 = 같은 글')
    const s4 = await rel(a.reportId, cc)
    ok(s4.status === 'undeclared_text_difference' && !s4.normal && s4.rawMatch === false && s4.rawDiff.after === '8', '원문이 다른데 의도를 적지 않으면 정상 아님 · 실제 차이 표시')
    const s5 = await rel(a.reportId, cc, '숫자 7→8')
    ok(s5.status === 'declared_text_difference' && s5.normal && s5.intendedDifference === '숫자 7→8', '의도를 적으면 의도와 실제 차이를 나란히')
    ok(!(await rel(a.reportId, u.reportId, '아무 사유')).normal, '출처 미확인 쪽이 있으면 사유를 적어도 정상 아님')
    ok((await rel(a.reportId, ff, '아무 사유')).status === 'unverified_basis', '원문 저장 지문이 없는 쪽이 있으면 사유를 적어도 정상 아님')
    console.log(`RESULT ${n} checks, 0 fail`)
  } catch (err) { console.log('FAIL', err.message); process.exitCode = 1 } finally { await c.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})()
