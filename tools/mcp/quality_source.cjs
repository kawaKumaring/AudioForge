'use strict'
// 검수 원문 연결(2026-10-09) — 기대 대사는 **그 음원을 만든 실행 기록**에서 가져온다.
// ★조각 번호·파일 번호로 다른 실행의 글을 잇지 않는다(10-04 검수에서 다른 측정의 같은 번호 덩이 글을 기대 대사로 써 '누락' 을 잘못 판정).
// 연결 근거: 실행 기록 manifest 의 result.sha256 = 분석 파일 지문. 원문 = script.private.json(raw_sha256 대조),
//            실제 전달문 = sent.private.json(문장별 경로) 또는 chunks/*.private.json(배치 경로). 기록이 없으면 '출처 미확인'.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

let rootCache = null
/** 실행 기록 자리 — 파이썬 local_assets 의 판정 그대로(환경변수 AUDIOFORGE_LOCAL_ROOT 가 이긴다). */
function runsRoot(ROOT, python) {
  if (process.env.AUDIOFORGE_LOCAL_ROOT) return path.join(process.env.AUDIOFORGE_LOCAL_ROOT, 'artifacts', 'runs')
  if (!rootCache) rootCache = execFileSync(python(), ['-c', 'import sys;sys.path.insert(0,"python");import local_assets as l;print(l.local_root())'], { cwd: ROOT, encoding: 'utf-8', windowsHide: true }).trim()
  return path.join(rootCache, 'artifacts', 'runs')
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null } }

/** 음원 지문으로 실행 기록을 찾는다(manifest 만 읽는다). 둘 이상이면 모두 돌려준다 — 부르는 쪽이 모호함으로 다룬다. */
function findRunsByAudio(runs, audioSha) {
  if (!fs.existsSync(runs)) return []
  const out = []
  for (const n of fs.readdirSync(runs)) {
    const m = readJson(path.join(runs, n, 'manifest.json'))
    if (m && m.result && m.result.sha256 === audioSha) out.push(n)
  }
  return out
}

/** 그 실행이 엔진에 실제로 보낸 글 — 기록된 것만. 없으면 null. */
function sentTexts(dir) {
  const sent = readJson(path.join(dir, 'sent.private.json'))
  if (sent && Array.isArray(sent.segments)) return sent.segments.map((s) => String(s.text ?? ''))
  const cdir = path.join(dir, 'chunks')
  if (!fs.existsSync(cdir)) return null
  const rows = fs.readdirSync(cdir).filter((n) => /\.private\.json$/.test(n)).sort().map((n) => readJson(path.join(cdir, n)))
  if (!rows.length || rows.some((r) => !r || typeof r.chunk_text !== 'string')) return null
  return rows.sort((a, b) => a.chunk_index - b.chunk_index).map((r) => r.chunk_text)
}

/**
 * 분석할 음원의 대사 출처를 정한다.
 * - runId 를 주면 그 기록만, 아니면 음원 지문으로 찾는다. 기록의 음원 지문이 분석 파일과 다르면 거부한다.
 * - 부르는 쪽이 대사를 줬는데 기록 원문과 다르면 거부한다(구간 분석이면 원문 안에 있어야 한다).
 * - 기록이 없으면 kind='unverified'(출처 미확인) — 누락 판정의 확정 근거로 쓰지 않는다.
 */
function resolveTextSource({ ROOT, python, audioSha, runId, callerText, partialWindow }) {
  const runs = runsRoot(ROOT, python)
  let found = []
  if (runId) {
    if (!/^[\w.-]+$/.test(runId)) throw Error('잘못된 실행 ID')
    const m = readJson(path.join(runs, runId, 'manifest.json'))
    if (!m) throw Error('실행 기록을 찾지 못했습니다: ' + runId)
    if (!m.result || m.result.sha256 !== audioSha) throw Error('실행 기록의 음원 지문이 분석 파일과 다릅니다 — 다른 실행의 글을 잇지 않습니다.')
    found = [runId]
  } else found = findRunsByAudio(runs, audioSha)
  if (found.length > 1) return { kind: 'unverified', verified: false, reason: 'ambiguous_run_records', candidates: found, audioSha256: audioSha, text: callerText ?? null }
  if (!found.length) return { kind: 'unverified', verified: false, reason: 'no_run_record', audioSha256: audioSha, text: callerText ?? null }
  const dir = path.join(runs, found[0])
  const m = readJson(path.join(dir, 'manifest.json'))
  const script = readJson(path.join(dir, 'script.private.json'))
  const raw = script && typeof script.raw_text === 'string' ? script.raw_text : null
  const rawSha = m.header && m.header.raw_text_sha256
  if (raw == null) return { kind: 'unverified', verified: false, reason: 'run_record_without_script', runId: found[0], audioSha256: audioSha, text: callerText ?? null }
  if (rawSha && sha(raw) !== rawSha) throw Error('실행 기록의 원문이 기록된 원문 지문과 다릅니다(기록 손상).')
  const sent = sentTexts(dir)
  let text = raw, scope = 'whole_run'
  if (partialWindow && callerText == null) { text = null; scope = 'whole_run_not_applied_to_window' }   // 구간 음원에 전체 원문을 대지 않는다
  if (callerText != null) {
    if (partialWindow) {
      if (!raw.includes(callerText)) throw Error('구간 대사가 그 실행의 원문 안에 없습니다 — 다른 실행의 글로 보입니다.')
      text = callerText; scope = 'window_substring'
    } else if (sha(callerText) !== sha(raw)) throw Error('넘긴 대사가 그 실행의 원문과 다릅니다 — 기록 원문을 쓰려면 대사를 비워 두세요.')
  }
  return { kind: 'run_record', verified: true, runId: found[0], scope, audioSha256: audioSha,
    rawSha256: sha(raw), sentSha256: sent ? sha(sent.join('\n')) : null, sentRecorded: !!sent, text,
    rawText: raw, sentText: sent ? sent.join('\n') : null }
}

/** 두 글의 바뀐 곳 — 공통 앞뒤를 뺀 가운데. 같으면 null. */
function textDiff(a, b) {
  if (a == null || b == null || a === b) return null
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return { at: p, before: a.slice(p, a.length - s), after: b.slice(p, b.length - s) }
}

/**
 * 두 보고서의 글 관계 — 비교가 '정상' 인지 정한다. 사유만으로 근거 불일치를 덮지 않는다.
 * - 한쪽이라도 출처 미확인 → unverified_basis(정상 아님, 사유를 적어도).
 * - 원문·전달문 같음 → same_text. 원문 같고 전달문 다름 → same_source_different_sent(서수 보정처럼).
 * - 원문 다름 → 사유(intendedDifference)가 있으면 declared_text_difference(실제 차이와 나란히), 없으면 undeclared_text_difference(정상 아님).
 */
function relation(x, y, intendedDifference) {
  const sx = x.identity.textSource, sy = y.identity.textSource
  const base = { textSources: [brief(sx), brief(sy)], intendedDifference: intendedDifference || null }
  if (!sx || !sy || !sx.verified || !sy.verified) return { ...base, status: 'unverified_basis', normal: false, note: '대사 출처가 실행 기록으로 확인되지 않은 쪽이 있다 — 사유를 적어도 정상 비교가 아니다.' }
  const rawDiff = textDiff(sx.rawText, sy.rawText), sentDiff = textDiff(sx.sentText, sy.sentText)
  if (!rawDiff && !sentDiff) return { ...base, status: 'same_text', normal: true }
  if (!rawDiff) return { ...base, status: 'same_source_different_sent', normal: true, sentDiff, note: '원문은 같고 엔진에 보낸 글이 다르다(예: 서수 보정).' }
  if (!intendedDifference) return { ...base, status: 'undeclared_text_difference', normal: false, rawDiff, sentDiff, note: '원문이 다르다. 의도한 차이(intendedDifference)를 적으면 실제 차이와 나란히 보인다.' }
  return { ...base, status: 'declared_text_difference', normal: true, rawDiff, sentDiff, note: '각 음성은 자기 실행의 글과 확인됨. 적은 의도와 실제 차이가 맞는지는 사람이 본다.' }
}
const brief = (s) => s ? { kind: s.kind, verified: !!s.verified, runId: s.runId ?? null, scope: s.scope ?? null, rawSha256: s.rawSha256 ?? null, sentSha256: s.sentSha256 ?? null, audioSha256: s.audioSha256 ?? null, reason: s.reason ?? null } : null

module.exports = { resolveTextSource, relation, textDiff, findRunsByAudio, sentTexts, runsRoot, brief }
