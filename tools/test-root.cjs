'use strict'
// 테스트 전용 폴더 — 검사·개발 도구가 만드는 파일은 **모두 여기로** (2026-10-10 사용자 결정).
// 자리: 본체 저장소의 `_local/테스트` (작업 트리에서 실행해도 본체 저장소 — python/local_assets.py 와 같은 규칙, Git 제외).
// 바꾸려면 환경변수 AF_TEST_ROOT. 파이썬 짝: python/_test_root.py
//
// 하위 폴더(README.md 참고)
//   임시/   검사 실행마다의 임시 자리(r<pid>, 끝나면 지움) — test/_temp-root.mjs · python/_test_temp.py
//   결과/   생성물·비교·청취 묶음(주제별 폴더)
//   화면/   화면 캡처(e2e·MCP ui_screenshot)
//   기록/   로그·보고서·수치 JSON
//   도구/   개발 도구 자체의 산출물(검수 MCP 보고서 등)
//   스크립트/ 일회성 검사·실험 스크립트
//   입력/   시험 입력(승인된 참조·곡·데이터셋 사본)
const fs = require('fs'), path = require('path')

/** 이 파일이 든 저장소의 본체 저장소 루트 — 작업 트리면 `.git` 파일의 gitdir 을 따라 올라간다. */
function mainRepoRoot(from = path.resolve(__dirname, '..')) {
  const dotgit = path.join(from, '.git')
  try {
    const st = fs.statSync(dotgit)
    if (st.isDirectory()) return from
    const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotgit, 'utf-8'))
    if (m) {
      // <main>/.git/worktrees/<name> → <main>
      const gitdir = path.resolve(from, m[1].trim())
      const idx = gitdir.replace(/\\/g, '/').lastIndexOf('/.git/worktrees/')
      if (idx >= 0) return gitdir.slice(0, idx)
    }
  } catch { /* 아래 기본값 */ }
  return from
}

const TEST_ROOT = process.env.AF_TEST_ROOT ? path.resolve(process.env.AF_TEST_ROOT) : path.join(mainRepoRoot(), '_local', '테스트')
const SUB = { temp: '임시', results: '결과', shots: '화면', records: '기록', tools: '도구', scripts: '스크립트', inputs: '입력' }
/** 하위 폴더 경로(만들어 둔다). sub = 'temp'|'results'|'shots'|'records'|'tools'|'scripts'|'inputs', 나머지는 그 아래 경로. */
function dir(sub, ...rest) {
  if (!SUB[sub]) throw new Error('테스트 폴더 종류가 아님: ' + sub)
  const p = path.join(TEST_ROOT, SUB[sub], ...rest)
  fs.mkdirSync(p, { recursive: true })
  return p
}
/** 화면 캡처 파일 경로(폴더를 만들어 둔다). */
const shot = (...name) => { const p = path.join(TEST_ROOT, SUB.shots, ...name); fs.mkdirSync(path.dirname(p), { recursive: true }); return p }

module.exports = { TEST_ROOT, SUB, dir, shot, mainRepoRoot }
