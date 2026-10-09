'use strict'
// 검수 원문 연결(2026-10-09) — 기대 대사는 **그 음원을 만든 실행 기록**에서 가져온다.
// ★조각 번호·파일 번호로 다른 실행의 글을 잇지 않는다(10-04 검수에서 다른 측정의 같은 번호 덩이 글을 기대 대사로 써 '누락' 을 잘못 판정).
//
// 판정을 넷으로 나눈다(관리자 코드 검수 2026-10-09):
//   run        — 이 음원을 만든 실행 기록인가(manifest result.sha256 = 분석 파일 지문)
//   rawText    — 그 실행의 원문이 **저장된 지문**과 맞는가(header.raw_text_sha256 · manifest artifacts 의 파일 지문). 저장된 지문이 없으면 '확인 불가' — 새로 계산한 지문으로 대신하지 않는다.
//   sent       — 실제 전달문 기록이 있고 저장된 지문들과 맞는가(없음 / 맞음 / 어긋남을 구분)
//   window     — 구간 분석일 때 그 시간대의 대사가 무엇인지 — 시간·대사 대응 근거가 없으면 '대응 미확인'(원문에 들어 있다는 것만으로 확정하지 않는다)
// 누락 '확정' 은 run·rawText 확인 + 전체 구간(또는 대응 확인된 구간) + 기대 대사가 있을 때만(isOmissionEvidence).
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
const fileSha = (p) => { try { return sha(fs.readFileSync(p)) } catch { return null } }

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

/** manifest artifacts 에 적힌 파일 지문과 실제 파일을 대조한다. 적혀 있지 않으면 'unlisted'(확인 불가). */
function artifactCheck(dir, m, rel) {
  const entry = (Array.isArray(m.artifacts) ? m.artifacts : []).filter((a) => a && a.path === rel)
  if (entry.length > 1) return 'duplicate_listing'
  if (!entry.length) return 'unlisted'
  const got = fileSha(path.join(dir, rel))
  if (got == null) return 'missing_file'
  return got === entry[0].sha256 ? 'match' : 'file_sha_mismatch'
}

/**
 * 실제 전달문 — 저장된 근거로만. state: 'unrecorded'(기록 없음) · 'verified' · 'invalid'(어긋남, issues 에 사유).
 * - 문장별 경로: sent.private.json — 파일 지문(manifest artifacts)·문장마다 저장된 sha256·index 순서.
 * - 배치 경로: chunks/*.private.json — manifest chunks[] 와 조각 번호 대조(누락·중복·순서), 파일 지문, 조각마다 저장된 chunk_text_sha256.
 */
function sentEvidence(dir, m) {
  const issues = []
  if (fs.existsSync(path.join(dir, 'sent.private.json'))) {
    const fileState = artifactCheck(dir, m, 'sent.private.json')
    if (fileState !== 'match') issues.push('sent_file_' + fileState)
    const sent = readJson(path.join(dir, 'sent.private.json'))
    const segs = sent && Array.isArray(sent.segments) ? sent.segments : null
    if (!segs) return { state: 'invalid', issues: issues.concat('sent_unreadable') }
    segs.forEach((s, i) => {
      if (typeof s.sha256 !== 'string') issues.push(`sent_sha_missing@${i}`)
      else if (s.sha256 !== sha(String(s.text ?? ''))) issues.push(`sent_sha_mismatch@${i}`)
    })
    const idx = segs.map((s) => s.index)
    if (new Set(idx).size !== idx.length) issues.push('sent_index_duplicate')
    if (idx.some((v, i) => i > 0 && !(v > idx[i - 1]))) issues.push('sent_index_order')
    if (issues.length) return { state: 'invalid', issues }
    const text = segs.map((s) => String(s.text ?? '')).join('\n')
    return { state: 'verified', basis: 'sent.private.json', text, sha256: sha(text), count: segs.length, issues }
  }
  const cdir = path.join(dir, 'chunks')
  const files = fs.existsSync(cdir) ? fs.readdirSync(cdir).filter((n) => /\.private\.json$/.test(n)).sort() : []
  const rows = Array.isArray(m.chunks) ? m.chunks : []
  if (!files.length && !rows.length) return { state: 'unrecorded', issues }
  const manifestIdx = rows.map((r) => r.chunk_index)
  if (new Set(manifestIdx).size !== manifestIdx.length) issues.push('manifest_chunk_duplicate')
  if (manifestIdx.some((v, i) => v !== i)) issues.push('manifest_chunk_order')
  if (typeof m.chunk_count === 'number' && m.chunk_count !== rows.length) issues.push('manifest_chunk_count_mismatch')
  const priv = files.map((n) => ({ n, j: readJson(path.join(cdir, n)) }))
  if (priv.some((p) => !p.j)) issues.push('chunk_file_unreadable')
  const byIdx = new Map()
  for (const p of priv) {
    if (!p.j) continue
    const k = p.j.chunk_index
    if (byIdx.has(k)) issues.push(`chunk_file_duplicate@${k}`)
    byIdx.set(k, p)
    const fstate = artifactCheck(dir, m, 'chunks/' + p.n)
    if (fstate !== 'match') issues.push(`chunk_file_${fstate}@${k}`)
    if (typeof p.j.chunk_text_sha256 !== 'string') issues.push(`chunk_sha_missing@${k}`)
    else if (p.j.chunk_text_sha256 !== sha(String(p.j.chunk_text ?? ''))) issues.push(`chunk_sha_mismatch@${k}`)
  }
  for (const k of manifestIdx) if (!byIdx.has(k)) issues.push(`chunk_file_missing@${k}`)
  for (const k of byIdx.keys()) if (!manifestIdx.includes(k)) issues.push(`chunk_file_not_in_manifest@${k}`)
  if (issues.length) return { state: 'invalid', issues }
  const text = manifestIdx.map((k) => String(byIdx.get(k).j.chunk_text ?? '')).join('\n')
  return { state: 'verified', basis: 'chunks/*.private.json', text, sha256: sha(text), count: manifestIdx.length, issues }
}

/**
 * 분석할 음원의 대사 출처를 정한다. 거부(throw)하는 것: 다른 실행 ID(음원 지문 불일치), 넘긴 대사가 원문과 다름, 구간 대사가 원문에 없음,
 * 원문이 저장된 지문과 다름(기록 손상). 나머지 부족함은 표시로 남긴다(verified=false 또는 상태 필드).
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
  const unverified = (reason, extra = {}) => ({ kind: 'unverified', verified: false, runVerified: false, reason, audioSha256: audioSha, text: callerText ?? null,
    windowAlignment: partialWindow ? 'unaligned' : 'whole', ...extra })
  if (found.length > 1) return unverified('ambiguous_run_records', { candidates: found })
  if (!found.length) return unverified('no_run_record')
  const dir = path.join(runs, found[0])
  const m = readJson(path.join(dir, 'manifest.json'))
  const script = readJson(path.join(dir, 'script.private.json'))
  const raw = script && typeof script.raw_text === 'string' ? script.raw_text : null
  const base = { runId: found[0], runVerified: true, audioSha256: audioSha }
  if (raw == null) return { ...unverified('run_record_without_script'), ...base, kind: 'run_record', rawTextState: 'missing' }
  // 원문 — 저장된 지문과만 대조한다. 저장된 지문이 없으면 확인 불가(새로 계산한 지문으로 '확인' 하지 않는다).
  const storedRaw = m.header && typeof m.header.raw_text_sha256 === 'string' ? m.header.raw_text_sha256 : null
  const scriptFile = artifactCheck(dir, m, 'script.private.json')
  if (storedRaw && sha(raw) !== storedRaw) throw Error('실행 기록의 원문이 기록된 원문 지문과 다릅니다(기록 손상).')
  if (scriptFile === 'file_sha_mismatch') throw Error('원문 파일이 실행 기록에 적힌 파일 지문과 다릅니다(기록 손상).')
  const rawTextState = storedRaw ? 'verified' : 'stored_sha_missing'
  const sent = sentEvidence(dir, m)
  // 대사·구간
  let text = raw, windowAlignment = 'whole'
  if (partialWindow) {
    // ★원문에 들어 있다는 것만으로 '그 시간대의 대사' 라고 확정하지 않는다 — 시간·대사 대응 근거가 아직 없다.
    if (callerText != null && !raw.includes(callerText)) throw Error('구간 대사가 그 실행의 원문 안에 없습니다 — 다른 실행의 글로 보입니다.')
    text = callerText ?? null
    windowAlignment = 'unaligned'
  } else if (callerText != null && sha(callerText) !== sha(raw)) throw Error('넘긴 대사가 그 실행의 원문과 다릅니다 — 기록 원문을 쓰려면 대사를 비워 두세요.')
  return { kind: 'run_record', ...base, verified: rawTextState === 'verified', rawTextState, scriptFile,
    rawSha256: storedRaw, text, windowAlignment,
    sentState: sent.state, sentIssues: sent.issues, sentBasis: sent.basis ?? null, sentSha256: sent.state === 'verified' ? sent.sha256 : null,
    rawText: raw, sentText: sent.state === 'verified' ? sent.text : null }
}

/** 누락을 '확정' 할 근거가 되는가 — 아니면 사유. 사람 의견은 막지 않고 미확정으로 남긴다(호출부). */
function omissionBlocker(ts) {
  if (!ts || !ts.runVerified) return '대사 출처(실행 기록) 미확인'
  if (ts.rawTextState !== 'verified') return '원문 지문을 저장된 근거로 확인하지 못함'
  if (ts.windowAlignment !== 'whole') return '구간의 시간·대사 대응 근거 없음'
  if (ts.text == null) return '기대 대사 없음'
  return null
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
 * rawMatch(원문 같음)와 sentMatch(전달문 같음: true/false/null=한쪽이라도 기록 없음·어긋남)를 따로 보인다.
 */
function relation(x, y, intendedDifference) {
  const sx = x.identity.textSource, sy = y.identity.textSource
  const base = { textSources: [brief(sx), brief(sy)], intendedDifference: intendedDifference || null }
  if (!sx || !sy || !sx.verified || !sy.verified) return { ...base, status: 'unverified_basis', normal: false, rawMatch: null, sentMatch: null, note: '대사 출처가 실행 기록·저장된 원문 지문으로 확인되지 않은 쪽이 있다 — 사유를 적어도 정상 비교가 아니다.' }
  const rawMatch = sx.rawSha256 === sy.rawSha256
  const sentBoth = sx.sentState === 'verified' && sy.sentState === 'verified'
  const sentMatch = sentBoth ? sx.sentSha256 === sy.sentSha256 : null
  const sentStates = [sx.sentState, sy.sentState]
  const rawDiff = rawMatch ? null : textDiff(sx.rawText, sy.rawText)
  const sentDiff = sentBoth && !sentMatch ? textDiff(sx.sentText, sy.sentText) : null
  const r = { ...base, rawMatch, sentMatch, sentStates }
  if (rawMatch && sentMatch === true) return { ...r, status: 'same_text', normal: true }
  if (rawMatch && sentMatch === false) return { ...r, status: 'same_source_different_sent', normal: true, sentDiff, note: '원문은 같고 엔진에 보낸 글이 다르다(예: 서수 보정).' }
  if (rawMatch) return { ...r, status: 'same_source_sent_unconfirmed', normal: true, note: '원문은 같다. 전달문은 한쪽이라도 기록이 없거나 근거가 어긋나 같다고 말할 수 없다.' }
  if (!intendedDifference) return { ...r, status: 'undeclared_text_difference', normal: false, rawDiff, sentDiff, note: '원문이 다르다. 의도한 차이(intendedDifference)를 적으면 실제 차이와 나란히 보인다.' }
  return { ...r, status: 'declared_text_difference', normal: true, rawDiff, sentDiff, note: '각 음성은 자기 실행의 글과 확인됨. 적은 의도와 실제 차이가 맞는지는 사람이 본다.' }
}
const brief = (s) => s ? { kind: s.kind, verified: !!s.verified, runVerified: !!s.runVerified, runId: s.runId ?? null, rawTextState: s.rawTextState ?? null,
  rawSha256: s.rawSha256 ?? null, sentState: s.sentState ?? null, sentIssues: s.sentIssues ?? [], sentSha256: s.sentSha256 ?? null,
  windowAlignment: s.windowAlignment ?? null, audioSha256: s.audioSha256 ?? null, reason: s.reason ?? null } : null

module.exports = { resolveTextSource, relation, textDiff, findRunsByAudio, sentEvidence, omissionBlocker, runsRoot, brief }
