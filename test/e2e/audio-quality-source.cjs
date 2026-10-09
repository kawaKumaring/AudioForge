'use strict'
// 검수 원문 연결(2026-10-09) — 기대 대사는 그 음원을 만든 실행 기록에서. 실제 MCP 표준입출력 · 합성 사인파 · 가짜 실행 기록 폴더만.
// 실행: node test/e2e/audio-quality-source.cjs
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('node:assert/strict')
const ROOT = path.resolve(__dirname, '../..')
const dir = fs.mkdtempSync(path.join(ROOT, '_local/tmp/quality-source-'))
const LOCAL = path.join(dir, 'local'), RUNS = path.join(LOCAL, 'artifacts', 'runs')
process.env.AUDIOFORGE_LOCAL_ROOT = LOCAL              // 실행 기록 자리를 이 검사 폴더로(서버가 물려받는다)
const { McpClient } = require('../../tools/mcp/client.cjs')
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')

function wav(name, freq) {
  const n = 16000, b = Buffer.alloc(44 + n * 2)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i * freq) * 4000), 44 + i * 2)
  const p = path.join(dir, name); fs.writeFileSync(p, b); return p
}
function run(id, audio, raw, sent) {
  const d = path.join(RUNS, id); fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ run_id: id, header: { raw_text_sha256: sha(raw) }, result: { sha256: sha(fs.readFileSync(audio)) } }))
  fs.writeFileSync(path.join(d, 'script.private.json'), JSON.stringify({ raw_text: raw }))
  if (sent) fs.writeFileSync(path.join(d, 'sent.private.json'), JSON.stringify({ segments: sent.map((t, i) => ({ index: i, text: t })) }))
}
const RAW = '오늘은 7번째 수업이다.', OTHER = '오늘은 8번째 수업이다.'
const A = wav('a.wav', 0.05), B = wav('b.wav', 0.07), C = wav('c.wav', 0.09), N = wav('none.wav', 0.11)
run('run-a', A, RAW, [RAW])                         // 보정 끔: 원문 그대로 보냄
run('run-b', B, RAW, ['오늘은 일곱 번째 수업이다.'])  // 같은 원문, 보정한 글을 보냄
run('run-c', C, OTHER, [OTHER])                     // 원문이 다른 실행

;(async () => {
  const c = new McpClient(); await c.start()
  let n = 0; const ok = (v, label) => { assert.ok(v, label); n++; console.log('PASS', label) }
  const call = async (name, a) => { const r = await c.call('audio_quality_' + name, a); assert.equal(r.isError, false, r.text); return r.json }
  const fails = async (name, a, re) => { const r = await c.call('audio_quality_' + name, a); return r.isError && re.test(r.text) }
  try {
    const a = await call('analyze', { path: A })
    ok(a.textSource.kind === 'run_record' && a.textSource.verified && a.textSource.runId === 'run-a' && a.textSource.rawSha256 === sha(RAW), '대사를 비우면 음원 지문으로 찾은 실행 기록의 원문을 쓴다')
    const prov = (await call('read', { reportId: a.reportId, section: 'provenance' })).data
    ok(prov.textSource.runId === 'run-a' && prov.textSource.sentSha256 === sha(RAW) && prov.textSource.audioSha256 === sha(fs.readFileSync(A)) && !('rawText' in prov.textSource), '출처에 실행 ID·원문/전달문/음원 지문(본문은 싣지 않음)')
    ok(await fails('analyze', { path: A, text: OTHER }, /원문과 다릅니다/), '넘긴 대사가 그 실행 원문과 다르면 거부')
    ok(await fails('analyze', { path: A, runId: 'run-c' }, /음원 지문이 분석 파일과 다릅니다/), '다른 실행 ID 를 대면 거부(다른 실행의 글을 잇지 않음)')
    ok(await fails('analyze', { path: A, start: 0, end: 0.5, text: '없는 글' }, /원문 안에 없습니다/), '구간 대사는 그 실행 원문 안의 글만')
    const w = await call('analyze', { path: A, start: 0, end: 0.5 })
    ok(w.textSource.verified && w.textSource.scope === 'whole_run_not_applied_to_window', '구간 분석에 전체 원문을 대지 않는다')
    const u = await call('analyze', { path: N, text: RAW })
    ok(u.textSource.kind === 'unverified' && !u.textSource.verified && u.textSource.reason === 'no_run_record', '실행 기록이 없으면 출처 미확인')
    ok(await fails('review', { reportId: u.reportId, action: 'append', start: 0, end: 1, category: 'omission', verdict: 'confirmed', basis: 'user_report', observer: 't', note: 'n', userStatement: '없다' }, /출처 미확인/), '출처 미확인 보고서로 누락을 확정하지 않는다')
    ok((await call('review', { reportId: a.reportId, action: 'append', start: 0, end: 1, category: 'omission', verdict: 'confirmed', basis: 'user_report', observer: 't', note: 'n', userStatement: '없다' })).id, '확인된 보고서에서는 사람 판정으로 누락 확정 가능')

    const b = await call('analyze', { path: B }), cc = await call('analyze', { path: C })
    const r1 = (await call('compare', { reportId: a.reportId, otherReportId: b.reportId })).textRelation
    ok(r1.status === 'same_source_different_sent' && r1.normal && r1.sentDiff && r1.sentDiff.before === '7번째' && r1.sentDiff.after === '일곱 번째', '원문 같고 전달문만 다름(서수 보정) — 정상 비교, 바뀐 곳 표시')
    const r2 = (await call('compare', { reportId: a.reportId, otherReportId: cc.reportId })).textRelation
    ok(r2.status === 'undeclared_text_difference' && !r2.normal && r2.rawDiff.before === '7' && r2.rawDiff.after === '8', '원문이 다른데 의도를 적지 않으면 정상 비교 아님 · 실제 차이 표시')
    const r3 = (await call('compare', { reportId: a.reportId, otherReportId: cc.reportId, intendedDifference: '숫자 7→8' })).textRelation
    ok(r3.status === 'declared_text_difference' && r3.normal && r3.intendedDifference === '숫자 7→8' && r3.rawDiff.after === '8', '의도를 적으면 의도와 실제 차이를 나란히(각 음성은 자기 실행 글과 확인됨)')
    const r4 = (await call('compare', { reportId: a.reportId, otherReportId: u.reportId, intendedDifference: '아무 사유' })).textRelation
    ok(r4.status === 'unverified_basis' && !r4.normal, '한쪽이 출처 미확인이면 사유를 적어도 정상 비교 아님')
    const r5 = (await call('compare', { reportId: a.reportId, otherReportId: a.reportId })).textRelation
    ok(r5.status === 'same_text' && r5.normal, '같은 실행 = 같은 글')
    // 실행 기록 원문이 기록 지문과 다르면(손상) 거부
    fs.writeFileSync(path.join(RUNS, 'run-b', 'script.private.json'), JSON.stringify({ raw_text: RAW + '!' }))
    ok(await fails('analyze', { path: B, asr: 'none', records: [] }, /기록 손상/), '실행 기록 원문이 원문 지문과 다르면 거부')
    console.log(`RESULT ${n} checks, 0 fail`)
  } catch (e) { console.log('FAIL', e.message); process.exitCode = 1 } finally { await c.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})()
