#!/usr/bin/env node
'use strict'
// AudioForge 개발툴 MCP 서버 — AI(Claude Code 등)가 AudioForge 를 직접 켜고·조작하고·결과를 읽는 "리모컨".
//
// ★Spine2DManager 개발툴 MCP(§278, doc/MCP-DEVTOOL.md)를 본떴지만 **구조는 새로 짰다** (2026-09-30):
//   · Spine 은 앱을 감싸는 호스트 + 127.0.0.1 제어 창구(토큰)를 따로 두었다 — 앱의 require('electron') 를 가로채 창을 바꿔 끼우는 방식.
//     AudioForge 본체는 electron-vite 가 하나로 묶은 빌드라 그 가로채기 지점이 다르다.
//   · 대신 AudioForge 에는 이미 **검사 모드(AF_E2E)** 가 있다 — 사용자 데이터 격리 · 창을 앞으로 가져오지 않기 · 검사 전용 창구.
//     그리고 앱 검사 100여 개가 Playwright(_electron)로 앱을 띄운다. 그래서 이 서버가 **Playwright 로 앱을 직접** 띄운다.
//     → 호스트 파일도, 네트워크 포트도, 토큰도 없다(부품이 적고 밖에서 닿을 창구가 아예 없다).
//   · 창은 화면 밖(AF_E2E_OFFSCREEN=1 → src/main/services/offscreen.ts) · 포커스 없음 — 사용자 마우스·키보드를 빼앗지 않는다.
//   · OS 파일 열기·저장·메시지 대화상자는 앱 안에서 응답 큐로 바꿔 끼운다(진짜 창은 뜨지 않는다).
//   · 임시 파일은 테스트 전용 폴더(본체 저장소 _local/테스트/임시) 아래(C 드라이브 아님), 끝나면 지운다.
//     화면 캡처(ui_screenshot savePath 상대 경로)는 _local/테스트/화면 아래로 간다.
// ★표준출력은 MCP 메시지 전용 — 사람용 기록은 전부 표준오류(stderr). 섞이면 클라이언트가 끊긴다.
// 등록: 저장소 루트 .mcp.json. 설명서: doc/mcp-devtool.md
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const TR = require('../test-root.cjs')   // 테스트 전용 폴더(_local/테스트) — 2026-10-10
const SERVER_INFO = { name: 'audioforge-devtool', version: '0.4.0' }
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']
const HELPERS = fs.readFileSync(path.join(__dirname, 'domHelpers.js'), 'utf8')
// 이 앱에 맞춘 것들(화면 지도 · 상태 · 재생 관찰 · 기다리기 · 검사 재료 · 소리 수치 · 개인정보 가드)
const AF = require('./audioforge.cjs')
const QUALITY = require('./quality.cjs')
const log = (...a) => process.stderr.write('[audioforge-mcp] ' + a.join(' ') + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 기록(링 버퍼) — main 표준출력·오류 · 창별 렌더러 콘솔 · 대화상자 응답 ──
const LOG_MAX = 3000
const logs = []
let logSeq = 0
function record (source, level, text) {
  logs.push({ seq: ++logSeq, t: new Date().toISOString(), source, level, text: String(text).slice(0, 2000) })
  if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX)
}

// ── 빌드 상태 — 화면·본체 소스가 out 보다 새로우면 다시 빌드한다 ──
function newestMtime (dir) {
  let m = 0
  if (!fs.existsSync(dir)) return 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name)
    if (e.isDirectory()) m = Math.max(m, newestMtime(f)); else if (/\.(ts|tsx|css|html|mjs|js)$/.test(e.name)) m = Math.max(m, fs.statSync(f).mtimeMs)
  }
  return m
}
function buildState () {
  const outMain = path.join(ROOT, 'out', 'main', 'index.js')
  if (!fs.existsSync(outMain)) return { built: false, stale: true }
  const outT = Math.min(outMain && fs.statSync(outMain).mtimeMs, fs.existsSync(path.join(ROOT, 'out', 'renderer', 'index.html')) ? fs.statSync(path.join(ROOT, 'out', 'renderer', 'index.html')).mtimeMs : 0)
  const srcT = newestMtime(path.join(ROOT, 'src'))
  return { built: true, stale: srcT > outT, outAt: new Date(outT).toISOString(), srcAt: new Date(srcT).toISOString() }
}
function runBuild () {
  log('빌드 실행(npm run build)…')
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', timeout: 600000 })
  const out = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).slice(-12).join('\n')
  if (r.status !== 0) throw new Error('빌드 실패(exit ' + r.status + ')\n' + out)
  return out
}

// ── 앱 수명 ──
let session = null // { app, visible, userData, tmp, pages: Map<page, kind> }
function playwright () {
  try { return require(path.join(ROOT, 'node_modules', 'playwright')) } catch (e) { throw new Error('playwright 를 불러오지 못했습니다(npm install 필요): ' + e.message) }
}
function kindOf (page) {
  try { const u = page.url(); return /#console/.test(u) ? 'console' : 'main' } catch { return 'window' }
}
function watchPage (s, page) {
  if (s.pages.has(page)) return
  s.pages.set(page, true)
  page.on('console', (m) => record('renderer:' + kindOf(page), m.type(), m.text()))
  page.on('pageerror', (e) => record('renderer:' + kindOf(page), 'error', 'pageerror: ' + (e && e.message)))
  page.on('close', () => s.pages.delete(page))
}
async function findPage (kind = 'main') {
  if (!session) throw new Error('앱이 실행 중이 아닙니다 — 먼저 app_start')
  const pages = session.app.windows()
  for (const p of pages) watchPage(session, p)
  const hit = pages.find((p) => kindOf(p) === kind)
  if (!hit) throw new Error(`창 없음: ${kind} (열린 창: ${pages.map(kindOf).join(', ') || '없음'})`)
  return hit
}
async function inPage (kind, expr) {
  const page = await findPage(kind)
  return page.evaluate(`(async () => { ${HELPERS}\n return (${expr}) })()`)
}

// 대화상자 바꿔 끼우기 — main 안에서. 큐가 비면 '취소'(메시지는 기본 버튼).
const DIALOG_PATCH = `(({ dialog }) => {
  if (globalThis.__mcpDialog) return true
  const q = globalThis.__mcpDialog = { open: [], save: [], message: [], log: [] }
  const last = (a) => a[a.length - 1] || {}
  const open = (o) => { const p = q.open.shift(); q.log.push('열기 ' + (o.title || (o.properties || []).join(',')) + ' → ' + (p ? [].concat(p).join(' | ') : '(취소 — 큐 비어 있음)')); return p ? { canceled: false, filePaths: [].concat(p) } : { canceled: true, filePaths: [] } }
  const save = (o) => { const p = q.save.shift(); q.log.push('저장 ' + (o.defaultPath || '') + ' → ' + (p || '(취소 — 큐 비어 있음)')); return p ? { canceled: false, filePath: p } : { canceled: true, filePath: undefined } }
  const msg = (o) => { const i = q.message.length ? q.message.shift() : (Number.isInteger(o.defaultId) ? o.defaultId : 0); q.log.push('메시지 "' + String(o.message || o.title || '').slice(0, 120) + '" → 버튼 ' + i); return { response: i, checkboxChecked: false } }
  dialog.showOpenDialog = async (...a) => open(last(a))
  dialog.showOpenDialogSync = (...a) => { const r = open(last(a)); return r.canceled ? undefined : r.filePaths }
  dialog.showSaveDialog = async (...a) => save(last(a))
  dialog.showSaveDialogSync = (...a) => save(last(a)).filePath
  dialog.showMessageBox = async (...a) => msg(last(a))
  dialog.showMessageBoxSync = (...a) => msg(last(a)).response
  dialog.showErrorBox = (t, c) => { q.log.push('오류 상자: ' + t + ' — ' + c) }
  return true
})`

async function startApp ({ visible = false, build = 'auto', width = 1280, height = 860, keepData = false, prep = 'test' } = {}) {
  if (session) return { already: true, ...(await status()) }
  let built = null
  const bs = buildState()
  if (build === 'always' || (build === 'auto' && bs.stale)) built = runBuild()
  else if (!bs.built) throw new Error('out/ 없음 — build:"auto" 또는 "always" 로 다시 실행하세요')
  const base = TR.dir('temp')
  const tmp = path.join(base, 'mcp-' + process.pid)
  const userData = path.join(tmp, 'userdata')
  // keepData: 다시 켜기(app_restart) — 같은 사용자 데이터로 켠다(남는지·되살아나는지 확인). 아니면 새로.
  if (!keepData) fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  const env = {
    ...process.env, AF_E2E: '1', AF_E2E_OFFSCREEN: visible ? '0' : '1', AF_E2E_USER_DATA: userData,
    TEMP: tmp, TMP: tmp, TMPDIR: tmp, AF_TEST_RUN_DIR: tmp, HF_HUB_OFFLINE: '1',
  }
  // ★prep:'normal' — 보통 실행과 같은 **미리 준비**(낭독 목록을 열 때 Qwen 실행기·파일 미리 읽기, 고를 때 모델 열기, 켤 때 합성 라이브러리 미리 읽기).
  //   검사 기본('test')은 이것들을 끈다 — 그 수치를 보통 실행 성능으로 읽으면 안 된다. 'normal' 은 GPU 를 쓴다.
  if (prep === 'normal') env.AF_E2E_NORMAL_PREP = '1'; else delete env.AF_E2E_NORMAL_PREP
  delete env.ELECTRON_RUN_AS_NODE // 있으면 electron 이 Node 로 돌아 창을 못 띄운다
  const { _electron } = playwright()
  const app = await _electron.launch({ args: [path.join('out', 'main', 'index.js')], cwd: ROOT, env, timeout: 90000 })
  const s = { app, visible, userData, tmp, prep, pages: new Map() }
  session = s
  const proc = app.process()
  const keep = (src, lv) => (b) => { for (const line of String(b).split(/\r?\n/)) if (line.trim()) record(src, lv, line) }
  proc.stdout && proc.stdout.on('data', keep('main', 'info'))
  proc.stderr && proc.stderr.on('data', keep('main', 'error'))
  proc.on('exit', (code) => { log('앱 종료(exit ' + code + ')'); record('main', 'info', '앱 종료(exit ' + code + ')'); if (session === s) session = null })
  app.on('window', (p) => watchPage(s, p))
  // 재생 관찰 — 새 문서마다 먼저 심는다(낭독 소리 요소는 화면(DOM)에 없어 틀기 시작할 때 붙잡아야 한다).
  await app.context().addInitScript(AF.MEDIA_HOOK).catch(() => {})
  const page = await app.firstWindow({ timeout: 90000 })
  watchPage(s, page)
  await page.evaluate(AF.MEDIA_HOOK).catch(() => {})
  s.inputs = path.join(tmp, 'inputs')
  fs.mkdirSync(s.inputs, { recursive: true })
  await app.evaluate(new Function('return ' + DIALOG_PATCH)())
  // 화면이 뜰 때까지(앱 저장소가 생기면 준비된 것)
  const t0 = Date.now()
  while (Date.now() - t0 < 60000) {
    if (await page.evaluate(() => !!window.__afStore).catch(() => false)) break
    await sleep(250)
  }
  if (width && height) await resize({ window: 'main', width, height })
  return { started: true, visible, prep: prep === 'normal' ? 'normal(보통 실행과 같은 미리 준비 · GPU 사용)' : 'test(미리 준비 꺼짐 — 성능 수치로 쓰지 말 것)', build: built ? '빌드함' : (bs.stale ? '빌드 오래됨(건너뜀)' : '최신'), ...(await status()) }
}
async function stopApp ({ keepData = false } = {}) {
  if (!session) return { stopped: false, reason: '실행 중 아님' }
  const s = session
  session = null
  try { await Promise.race([s.app.close(), sleep(8000)]) } catch { /* 이미 닫혔다 */ }
  try { s.app.process().kill() } catch { /* 이미 끝났다 */ }
  await sleep(500)
  // Node rmSync 는 연결(정션)을 따라가지 않는다 — PowerShell Remove-Item 을 쓰지 않는다.
  if (keepData) return { stopped: true, kept: path.relative(ROOT, s.userData) }
  try { fs.rmSync(s.tmp, { recursive: true, force: true, maxRetries: 3 }) } catch (e) { log('임시 폴더를 다 지우지 못함: ' + e.message) }
  return { stopped: true }
}
async function windowsInfo () {
  if (!session) return []
  return session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => {
    const b = w.getBounds()
    return { id: w.id, title: w.getTitle(), url: w.webContents.getURL().slice(-60), x: b.x, y: b.y, width: b.width, height: b.height, visible: w.isVisible(), focused: w.isFocused() }
  })).then((ws) => ws.map((w) => ({ kind: /#console/.test(w.url) ? 'console' : 'main', ...w })))
}
async function status () {
  if (!session) return { running: false, build: buildState() }
  const q = await session.app.evaluate(() => { const d = globalThis.__mcpDialog; return d ? { open: d.open.length, save: d.save.length, message: d.message.length } : null }).catch(() => null)
  return { running: true, visible: session.visible, userData: path.relative(ROOT, session.userData), windows: await windowsInfo(), dialogQueued: q, logSeq }
}
async function resize ({ window = 'main', width, height }) {
  await findPage(window)
  return session.app.evaluate(({ BrowserWindow }, a) => {
    const w = BrowserWindow.getAllWindows().find((x) => (a.window === 'console') === /#console/.test(x.webContents.getURL()))
    if (!w) throw new Error('창 없음: ' + a.window)
    w.setSize(Math.round(a.width), Math.round(a.height))
    return w.getBounds()
  }, { window, width, height })
}

// ── 도구(AI 가 읽는 설명서) ──
const WIN = { type: 'string', description: "대상 창: 'main'(기본) · 'console'(콘솔 창 — 설정에서 콘솔을 켰을 때)" }
const TARGET = { type: 'string', description: "요소 지정: 'testid:reader-play'(data-testid — 가장 확실) · '@번호'(ui_query 의 ref) · CSS 선택자 · 보이는 글자('▶ 들어 보기')" }
const TOOLS = [
  ...QUALITY.tools,
  { name: 'app_start', description: 'AudioForge 를 실행한다(이미 실행 중이면 상태만). 기본은 화면 밖·포커스 없음 창이라 사용자 화면·마우스를 방해하지 않는다. 소스가 out/ 보다 새로우면 자동 빌드. 사용자 설정·작업은 임시 폴더로 격리(사용자 데이터 불변). OS 파일 창은 dialog_queue 로 넣어 둔 응답이 자동으로 쓰인다. ★성능 측정은 prep:"normal" — 기본(test)은 낭독 미리 준비(Qwen 실행기 띄우기·모델 열기·라이브러리 미리 읽기)를 끈다.', inputSchema: { type: 'object', properties: { visible: { type: 'boolean', description: 'true 면 보이는 창(사람이 함께 볼 때). 기본 false' }, build: { type: 'string', enum: ['auto', 'always', 'never'] }, width: { type: 'number' }, height: { type: 'number' }, prep: { type: 'string', enum: ['test', 'normal'], description: "'normal' = 보통 실행과 같은 미리 준비(GPU 사용) · 기본 'test' = 끔" } } } },
  { name: 'reader_trace', description: '낭독 관측 기록(최근 500개, 단조 시계 ms) — 재생 요청·덩이 요청(req·세대)·생성 시작·완료(줄 대기·생성 길이·캐시 적중·모델 처음 엶)·실제 재생 시작(playing)·버퍼 부족·문단 이동 후 첫 소리. mode 로 실행 방식(test/normal-prep/app)을 함께 준다. 본문·경로 없음.', inputSchema: { type: 'object', properties: { clear: { type: 'boolean', description: 'true 면 읽은 뒤 비운다(다음 측정을 새로)' }, window: WIN } } },
  { name: 'app_stop', description: 'AudioForge 를 종료하고 임시 폴더를 지운다.', inputSchema: { type: 'object', properties: {} } },
  { name: 'app_status', description: '실행 여부 · 창 목록(kind·위치·포커스) · 대화상자 응답 대기 수 · 마지막 기록 번호.', inputSchema: { type: 'object', properties: {} } },
  { name: 'app_reload', description: '창 화면을 새로 고친다.', inputSchema: { type: 'object', properties: { window: WIN } } },
  { name: 'ui_snapshot', description: '화면 구조를 접근성 트리(역할·이름) 글로 돌려준다 — 화면을 처음 파악할 때 가장 빠르다. 요소를 누를 땐 ui_query 의 testid·ref 를 쓴다.', inputSchema: { type: 'object', properties: { window: WIN, selector: { type: 'string', description: '이 CSS 선택자 안만(기본 body)' } } } },
  { name: 'ui_query', description: "보이는 요소 목록(ref · testid · 글자 · 비활성 · 체크 · 값 · 선택지 · 위치). filter 'interactive'(기본) | 'all'. testid 가 있으면 'testid:이름' 으로 지정하는 것이 가장 확실하다(ref 는 화면이 다시 그려지면 바뀐다).", inputSchema: { type: 'object', properties: { window: WIN, filter: { type: 'string', enum: ['interactive', 'all'] }, within: TARGET, text: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'ui_text', description: '요소(기본 body)의 보이는 글자.', inputSchema: { type: 'object', properties: { window: WIN, selector: TARGET, maxChars: { type: 'number' } } } },
  { name: 'ui_click', description: '요소를 누른다(화면 안 이벤트 — OS 마우스 미사용). 비활성 요소는 누르지 않고 알려 준다.', inputSchema: { type: 'object', properties: { window: WIN, target: TARGET, within: TARGET, exact: { type: 'boolean' }, index: { type: 'number' }, waitMs: { type: 'number', description: '누른 뒤 대기(기본 300ms)' } }, required: ['target'] } },
  { name: 'ui_set', description: '입력칸·선택 상자·체크박스 값을 바꾼다(React 가 알아채는 방식).', inputSchema: { type: 'object', properties: { window: WIN, target: TARGET, value: {}, within: TARGET, exact: { type: 'boolean' } }, required: ['target', 'value'] } },
  { name: 'ui_wait', description: '조건이 참이 될 때까지 대기: text(글자 등장) · selector(요소 보임) · code(화면 JS 식). met=false 면 시간 초과.', inputSchema: { type: 'object', properties: { window: WIN, text: { type: 'string' }, selector: TARGET, code: { type: 'string' }, timeoutMs: { type: 'number' } } } },
  { name: 'ui_screenshot', description: '창(또는 요소) 캡처 이미지. 화면 밖 창도 된다. savePath 를 주면 파일로도 저장 — 상대 경로는 테스트 폴더 _local/테스트/화면 아래(앞의 _local/ 는 떼어 냄), 절대 경로는 그대로.', inputSchema: { type: 'object', properties: { window: WIN, selector: TARGET, maxWidth: { type: 'number' }, savePath: { type: 'string' } } } },
  { name: 'window_resize', description: '창 크기 변경.', inputSchema: { type: 'object', properties: { window: WIN, width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] } },
  { name: 'api_list', description: "화면이 쓰는 앱 기능(window.api) 이름 목록 — 'audio.getFileUrl' · 'reader.speak' 처럼 점으로 이은 이름.", inputSchema: { type: 'object', properties: { window: WIN } } },
  { name: 'api_call', description: "앱 기능을 직접 호출한다(화면이 부르는 것과 같은 길: window.api → IPC → main). 예: method 'cards.builtinVoices' · 'settings.get'. 긴 문자열은 잘라서 돌려준다(full:true 면 전체). 오래 걸리면 timeoutMs 를 늘린다.", inputSchema: { type: 'object', properties: { window: WIN, method: { type: 'string' }, args: { type: 'array' }, full: { type: 'boolean' }, timeoutMs: { type: 'number' }, userApproved: { type: 'boolean', description: '사용자가 그 미디어 파일·그 작업을 명시적으로 허락했을 때만 true(검사용 자리 밖 미디어 경로를 쓸 때)' } }, required: ['method'] } },
  { name: 'js_eval', description: '화면(렌더러)에서 JS 식을 평가한다(점검용 — 화면 수정은 코드로). window.__afStore(앱 상태)·__mcp 도우미 사용 가능.', inputSchema: { type: 'object', properties: { window: WIN, code: { type: 'string' }, userApproved: { type: 'boolean', description: '사용자가 그 미디어 파일·그 작업을 명시적으로 허락했을 때만 true(검사용 자리 밖 미디어 경로를 쓸 때)' } }, required: ['code'] } },
  { name: 'dialog_queue', description: "다음에 뜰 OS 대화상자의 응답을 미리 넣는다. kind 'open'(파일·폴더 경로 또는 여러 파일 배열) · 'save'(저장 경로) · 'message'(버튼 번호). 비면 '취소'(진짜 창은 절대 안 뜸). ★낭독·카드의 파일 고르기도 여기로 온다.", inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['open', 'save', 'message'] }, answers: { type: 'array' }, userApproved: { type: 'boolean', description: '사용자가 그 미디어 파일·그 작업을 명시적으로 허락했을 때만 true(검사용 자리 밖 미디어 경로를 쓸 때)' } }, required: ['kind', 'answers'] } },
  { name: 'dialog_clear', description: '대화상자 응답 큐 비우기.', inputSchema: { type: 'object', properties: {} } },
  // ── AudioForge 전용 ──
  { name: 'app_state', description: '지금 상태 한눈에: 작업(mode) · 처리 상태 · 오류 · 다른 작업 때문에 합성이 막히는 사유(busy) · 떠 있는 대화창·경고 · 생성 카드(개수·생성본 수·진행 중 작업) · 낭독(책·문단 자리·목소리·읽는 중인지·상태 글) · 울리는 소리 수. 무엇을 하기 전후로 먼저 부른다.', inputSchema: { type: 'object', properties: {} } },
  { name: 'app_mode', description: "작업 화면을 바꾼다: " + Object.entries(AF.MODES).map(([k, v]) => `'${k}'(${v})`).join(' · ') + '. 한국어 이름도 된다. 처리 중에는 바뀌지 않는다(그렇다고 알려 준다).', inputSchema: { type: 'object', properties: { mode: { type: 'string' }, force: { type: 'boolean', description: '단추가 없는 화면을 앱 상태로 직접 바꾼다(사용자가 가는 길이 아니다)' } }, required: ['mode'] } },
  { name: 'audio_now', description: '★소리는 들을 수 없으므로 — 틀기 시작한 소리 요소들의 파일 이름 · 위치(초) · 길이 · 멈춤/끝남 · 재생 빠르기 · 음량 · 오류. 낭독·생성본·미리듣기 모두(화면 DOM 에 없는 요소 포함).', inputSchema: { type: 'object', properties: { window: WIN } } },
  { name: 'audio_inspect', description: '만든 소리(WAV)를 수치로: 길이 · 샘플레이트 · 최고/평균 크기(dBFS) · 잘린 표본 수 · 조용한 비율 · 앞뒤 조용함 · 가장 긴 틈 · 비었는지. ★검사용 자리(test/fixtures/audio · _local/테스트/임시 · 이 실행의 임시 폴더) 안의 파일만 — 그 밖은 userApproved:true(사용자 허락) 필요.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, userApproved: { type: 'boolean' } }, required: ['path'] } },
  { name: 'wait_idle', description: '긴 작업(합성·낭독 조각 만들기·분리 등)이 끝날 때까지 기다린다 — 처리 상태 · 카드 작업 · 합성 막힘 사유 · 낭독 "만드는 중" 이 모두 비고 1초 유지되면 끝. 반환 met=false 면 시간 초과(timeoutMs 기본 10분).', inputSchema: { type: 'object', properties: { timeoutMs: { type: 'number' } } } },
  { name: 'test_input', description: "사용자 파일 대신 쓰는 **검사 재료**를 이 실행의 임시 폴더에 만든다(경로를 돌려준다 — dialog_queue 에 그대로 넣는다). kind: 'text'(content · encoding utf-8|utf-8-bom|utf-16le|cp949 · name) · 'tone'(seconds · freq — 사인파 WAV) · 'speech'(text — 앱의 기본 목소리로 만든 말소리 WAV · 참조 목소리 검사용) · 'fixture'(name — 저장소 검사용 음원을 복사, 이름 없으면 목록).", inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['text', 'tone', 'speech', 'fixture'] }, content: { type: 'string' }, encoding: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, seconds: { type: 'number' }, freq: { type: 'number' } }, required: ['kind'] } },
  // ── 조작 보충(2026-10-01 · 개발툴과 비교해 빠졌던 것) ──
  { name: 'ui_drop_files', description: "파일을 끌어 놓는다(진짜 경로가 실린 파일 — 앱이 getPathForFile 로 경로를 읽는다). 낭독 책 · 생성 카드 목소리 · 노래 변환 · 실험실 · 파일 가져오기 카드처럼 끌어 놓기로 받는 곳. 대상 요소의 가운데 아래 가장 안쪽 요소에 놓는다(실제 끌어 놓기처럼 위로 전해진다). ★검사용 자리 밖 미디어는 userApproved 필요 — 대신 test_input.", inputSchema: { type: 'object', properties: { window: WIN, target: TARGET, paths: { type: 'array', items: { type: 'string' } }, userApproved: { type: 'boolean' } }, required: ['target', 'paths'] } },
  { name: 'ui_key', description: "키를 누른다(화면 안 입력 — OS 키보드 미사용). keys 예: 'Space' · 'Escape' · 'Enter' · 'Control+Z' · 'ArrowLeft' · 'Delete'. target 을 주면 그 요소에 먼저 초점을 둔다(대화 편집·트랙 분할·합성 탭의 단축키).", inputSchema: { type: 'object', properties: { window: WIN, keys: { type: 'string' }, target: TARGET, repeat: { type: 'number' } }, required: ['keys'] } },
  { name: 'ui_pointer', description: "요소 **안의 위치**를 누르거나 끈다 — 파형(구간 자르기·트랙 분할) · 참조 구간 끌기 · 대화 구간 끌기 · 카드 순서 끌기처럼 '어디를' 눌렀는지가 뜻인 곳. at=[가로, 세로] 비율(0~1, 기본 가운데). action: click · rightclick · hover · drag(to=[가로, 세로] 비율 · 또는 toTarget 요소 가운데로).", inputSchema: { type: 'object', properties: { window: WIN, target: TARGET, action: { type: 'string', enum: ['click', 'rightclick', 'hover', 'drag'] }, at: { type: 'array' }, to: { type: 'array' }, toTarget: TARGET, steps: { type: 'number' } }, required: ['target'] } },
  { name: 'ui_scroll', description: "요소(또는 창)를 굴린다. to: 'top' · 'bottom' · 숫자(px 자리) · by: 숫자(px 만큼). 긴 책·긴 목록에서.", inputSchema: { type: 'object', properties: { window: WIN, target: TARGET, to: {}, by: { type: 'number' } } } },
  { name: 'ui_audit', description: '★화면 점검 — 이름 없는 단추 · 이유 없이 비활성된 단추 · 창 밖으로 삐져나간 요소 · 가려져 누를 수 없는 요소 · 잘려서 못 읽는 글(볼 길이 없음) · 너무 작은 글씨(기본 11px 미만) · 가로 스크롤. 개수와 예(testid)를 돌려준다. 창 크기를 바꿔 가며(window_resize) 좁은 창도 본다. 캡처 대신 쓴다.', inputSchema: { type: 'object', properties: { window: WIN, within: TARGET, tinyPx: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'app_restart', description: '앱을 다시 켠다 — 기본은 **같은 사용자 데이터로**(설정·책·작업이 남는지, 되살리기가 되는지 확인). keepData:false 면 새 데이터로.', inputSchema: { type: 'object', properties: { keepData: { type: 'boolean' }, visible: { type: 'boolean' } } } },
  { name: 'errors', description: '문제만 모아 본다: 화면 오류·경고(pageerror 포함) · 본체 오류 줄 · 앱 기록의 WARN/ERROR. since=마지막으로 본 seq 이후만. 조작 뒤 건강 검사로 쓴다.', inputSchema: { type: 'object', properties: { since: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'logs', description: "기록: main(본체 출력) · renderer:<창>(화면 콘솔) · dialog(대화상자 응답) · app(앱 동작 기록 파일 — [reader]·[check] 같은 꼬리표). since=마지막으로 본 seq 이후만(app 은 파일이라 since 무시). grep=정규식.", inputSchema: { type: 'object', properties: { since: { type: 'number' }, source: { type: 'string', description: "'main'|'renderer'|'dialog'|'app'" }, grep: { type: 'string' }, limit: { type: 'number' } } } }
]

const text = (obj) => ({ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1) })
async function dialogLogs () {
  if (!session) return
  const lines = await session.app.evaluate(() => { const d = globalThis.__mcpDialog; if (!d) return []; const l = d.log.splice(0); return l }).catch(() => [])
  for (const l of lines) record('dialog', 'info', l)
}
function appLogLines () {
  if (!session) return []
  const dir = path.join(session.userData, 'logs')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).sort().flatMap((n) => fs.readFileSync(path.join(dir, n), 'utf8').split(/\r?\n/).filter(Boolean))
}
const HANDLERS = {
  ...Object.fromEntries(QUALITY.tools.map(t => [t.name, a => QUALITY.call(t.name, a)])),
  app_start: (a) => startApp(a),
  reader_trace: ({ clear = false, window = 'main' }) => inPage(window, `(() => { const t = window.__readerTrace; if (!t) return { error: '관측 기록이 없습니다 — 낭독 화면을 한 번 연 뒤에 생깁니다' }; const d = t.dump(); if (${clear ? 'true' : 'false'}) t.clear(); return d })()`),
  app_stop: () => stopApp(),
  app_status: () => status(),
  app_reload: async ({ window = 'main' }) => { const p = await findPage(window); await p.reload(); return true },
  ui_snapshot: async ({ window = 'main', selector = 'body' }) => (await findPage(window)).locator(selector).first().ariaSnapshot({ timeout: 10000 }),
  ui_query: ({ window = 'main', filter = 'interactive', within = null, text: t = null, limit = 200 }) => inPage(window, `__mcp.query(${JSON.stringify({ filter, within, text: t, limit })})`),
  ui_text: ({ window = 'main', selector = 'body', maxChars = 20000 }) => inPage(window, `__mcp.text(${JSON.stringify(selector)}, ${Number(maxChars)})`),
  ui_click: async ({ window = 'main', target, within = null, exact = false, index = 0, waitMs }) => { const r = await inPage(window, `__mcp.click(${JSON.stringify({ target, within, exact, index })})`); await sleep(waitMs == null ? 300 : waitMs); return r },
  ui_set: ({ window = 'main', target, value, within = null, exact = false }) => inPage(window, `__mcp.set(${JSON.stringify({ target, value, within, exact })})`),
  ui_wait: async ({ window = 'main', code = null, text: t = null, selector = null, timeoutMs = 30000 }) => {
    const cond = code || (t ? `(document.body.innerText || '').includes(${JSON.stringify(t)})` : selector ? `!!__mcp.visibleEl(${JSON.stringify(selector)})` : 'true')
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      try { const v = await inPage(window, cond); if (v) return { met: true, value: v, ms: Date.now() - t0 } } catch { /* 화면이 바뀌는 중 */ }
      await sleep(300)
    }
    return { met: false, ms: Date.now() - t0 }
  },
  ui_screenshot: async ({ window = 'main', selector = null, maxWidth = 1400, savePath = null }) => {
    const page = await findPage(window)
    let rect = null
    if (selector) { rect = await inPage(window, `__mcp.rect(${JSON.stringify(selector)})`); if (!rect) throw new Error('선택자 대상 없음(보이는 요소): ' + selector) }
    // 화면 밖 창도 찍히게 본체의 capturePage 를 쓴다(Playwright 캡처는 가려진 창에서 멈출 수 있다).
    const shot = await session.app.evaluate(async ({ BrowserWindow }, a) => {
      const w = BrowserWindow.getAllWindows().find((x) => (a.window === 'console') === /#console/.test(x.webContents.getURL()))
      if (!w) throw new Error('창 없음: ' + a.window)
      let img = await (a.rect ? w.webContents.capturePage(a.rect) : w.webContents.capturePage())
      const orig = img.getSize()
      if (a.maxWidth && orig.width > a.maxWidth) img = img.resize({ width: a.maxWidth, quality: 'good' })
      return { b64: img.toPNG().toString('base64'), size: img.getSize(), orig }
    }, { window, rect, maxWidth })
    void page
    if (savePath && !path.isAbsolute(savePath)) savePath = TR.shot(savePath.replace(/^_local[\\/]/, ''))
    if (savePath) { fs.mkdirSync(path.dirname(savePath), { recursive: true }); fs.writeFileSync(savePath, Buffer.from(shot.b64, 'base64')) }
    return { content: [{ type: 'image', data: shot.b64, mimeType: 'image/png' }, text({ width: shot.size.width, height: shot.size.height, original: shot.orig, savedTo: savePath || null })] }
  },
  window_resize: (a) => resize(a),
  api_list: ({ window = 'main' }) => inPage(window, '__mcp.apiList()'),
  api_call: async ({ window = 'main', method, args = [], full = false, timeoutMs = 300000, userApproved }) => {
    AF.guardMedia(args, session, userApproved)
    const call = inPage(window, `__mcp.api(${JSON.stringify(method)}, ${JSON.stringify(args)}, ${!!full})`)
    return Promise.race([call, sleep(timeoutMs).then(() => { throw new Error(`시간 초과(${timeoutMs}ms): ${method}`) })])
  },
  js_eval: ({ window = 'main', code, userApproved }) => { AF.guardMedia(code, session, userApproved); return inPage(window, `(async () => { return (${code}) })()`) },
  dialog_queue: async ({ kind = 'open', answers = [], userApproved }) => {
    AF.guardMedia(answers, session, userApproved)
    if (!['open', 'save', 'message'].includes(kind)) throw new Error("kind = open|save|message")
    if (!session) throw new Error('앱이 실행 중이 아닙니다 — 먼저 app_start')
    return session.app.evaluate((_e, a) => { const d = globalThis.__mcpDialog; d[a.kind].push(...a.answers); return { kind: a.kind, queued: d[a.kind].length } }, { kind, answers })
  },
  dialog_clear: async () => { if (!session) return false; return session.app.evaluate(() => { const d = globalThis.__mcpDialog; d.open.length = d.save.length = d.message.length = 0; return true }) },
  // ── AudioForge 전용 ──
  app_state: async () => {
    const st = await inPage('main', AF.STATE)
    const q = await session.app.evaluate(() => { const d = globalThis.__mcpDialog; return d ? { open: d.open.length, save: d.save.length, message: d.message.length } : null }).catch(() => null)
    return { ...st, dialogQueued: q, windows: (await windowsInfo()).map((w) => w.kind), logSeq }
  },
  app_mode: async ({ mode, force = false }) => {
    const want = String(mode || '').trim()
    const id = AF.MODES[want] ? want : Object.keys(AF.MODES).find((k) => AF.MODES[k] === want || AF.MODES[k].includes(want))
    if (!id) throw new Error('모르는 작업: ' + want + ' — ' + Object.entries(AF.MODES).map(([k, v]) => `${k}(${v})`).join(' · '))
    // ★시작 화면(AppEntrance, 2026-10-03)이 떠 있으면 먼저 '작업실 시작' 을 누른다 — 사용자가 작업실로 들어가는 길과 같다.
    //   시작 화면 자체를 보는 검사는 app_start 직후 app_mode 를 부르기 전에 본다(welcome-mcp).
    const onWelcome = await inPage('main', `!!document.querySelector('[data-testid="welcome-start"]')`).catch(() => false)
    if (onWelcome) {
      const w = await inPage('main', `__mcp.click(${JSON.stringify({ target: 'testid:welcome-start' })})`)
      if (!w || !w.clicked) return { mode: id, changed: false, why: '시작 화면의 작업실 시작을 누르지 못함: ' + ((w && w.error) || '') }
      const t1 = Date.now()
      while (Date.now() - t1 < 8000 && !(await inPage('main', `!!document.querySelector('[data-testid="mode-${id}"]')`).catch(() => false))) await sleep(100)
    }
    if (AF.NO_BUTTON[id] && !force) return { mode: id, changed: false, why: '화면에 단추가 없는 작업이다 — ' + AF.NO_BUTTON[id], hint: '그 길로 들어가거나, 상태를 직접 바꾸려면 force:true(단추를 누르지 않고 앱 상태를 바꾼다 — 사용자가 하는 길이 아니다)' }
    if (AF.NO_BUTTON[id] && force) {
      await inPage('main', `window.__afStore.getState().setMode(${JSON.stringify(id)})`)
      const cur = await inPage('main', 'window.__afStore.getState().mode')
      return { mode: id, label: AF.MODES[id], changed: cur === id, forced: true, note: '단추 없이 앱 상태를 바꿨다 — 사용자가 들어가는 길과 다를 수 있다' }
    }
    const r = await inPage('main', `__mcp.click(${JSON.stringify({ target: 'testid:mode-' + id })})`)
    if (!r || !r.clicked) return { mode: id, changed: false, why: (r && r.error) || '누르지 못함', hint: r && r.error === '비활성 요소' ? '처리 중에는 작업을 바꿀 수 없다 — wait_idle 뒤 다시' : undefined }
    const t0 = Date.now()
    while (Date.now() - t0 < 5000) {
      const cur = await inPage('main', `document.querySelector('[data-testid="mode-${id}"]')?.getAttribute('aria-current') === 'page'`).catch(() => false)
      if (cur) return { mode: id, label: AF.MODES[id], changed: true }
      await sleep(150)
    }
    return { mode: id, changed: false, why: '눌렀지만 화면이 바뀌지 않았다(5초)' }
  },
  audio_now: ({ window = 'main' }) => inPage(window, AF.MEDIA_NOW),
  audio_inspect: async ({ path: p, userApproved }) => {
    const full = path.isAbsolute(String(p || '')) ? String(p) : path.join(ROOT, String(p || ''))
    AF.guardMedia(full, session, userApproved)
    if (!fs.existsSync(full)) throw new Error('파일이 없습니다: ' + path.basename(full))
    return AF.inspectWav(full)
  },
  wait_idle: async ({ timeoutMs = 600000 }) => {
    const t0 = Date.now()
    let calm = 0, last = null
    while (Date.now() - t0 < timeoutMs) {
      last = await inPage('main', AF.STATE).catch(() => null)
      const busy = !last || last.status === 'processing' || (last.cards && last.cards.job) || last.busy ||
        (last.reader && /만드는 중|기다리는 중/.test(last.reader.state || ''))
      calm = busy ? 0 : calm + 1
      if (calm >= 2) return { met: true, ms: Date.now() - t0, state: last }
      await sleep(500)
    }
    return { met: false, ms: Date.now() - t0, state: last }
  },
  test_input: async ({ kind, content = '', encoding = 'utf-8', name = null, text: t = '', seconds = 2, freq = 440 }) => {
    if (!session) throw new Error('앱이 실행 중이 아닙니다 — 먼저 app_start(재료는 이 실행의 임시 폴더에 만든다)')
    const n = session.inputSeq = (session.inputSeq || 0) + 1
    const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
    if (kind === 'text') {
      const file = path.join(session.inputs, safe(name || `글-${n}`) + (/\.txt$/i.test(name || '') ? '' : '.txt'))
      AF.writeText(file, String(content || '첫째 문단이다. 그는 천천히 문을 열었다.'), encoding)
      return { path: file, bytes: fs.statSync(file).size, encoding }
    }
    if (kind === 'tone') {
      const file = path.join(session.inputs, safe(name || `소리-${n}`) + '.wav')
      AF.writeTone(file, Number(seconds) || 2, Number(freq) || 440)
      return { path: file, seconds: Number(seconds) || 2 }
    }
    if (kind === 'fixture') {
      const list = AF.listFixtures()
      if (!name) return { fixtures: list, dir: path.relative(ROOT, AF.FIXTURES) }
      if (!list.includes(name)) throw new Error('없는 검사용 음원: ' + name + ' — 목록: ' + list.join(', '))
      const file = path.join(session.inputs, name)
      fs.copyFileSync(path.join(AF.FIXTURES, name), file)
      return { path: file, from: path.join('test', 'fixtures', 'audio', name) }
    }
    if (kind === 'speech') {
      // 앱의 기본 목소리로 만든다 — 사용자 음성이 아니므로 참조 목소리 검사에 써도 된다(기능 검사와 같은 방법).
      const say = String(t || content || '안녕하세요. 이 목소리로 읽습니다.')
      const made = await inPage('main', `(async () => {
        const v = (await window.api.cards.builtinVoices())?.data?.voices || []
        const b = v.find((x) => x.engineId !== 'qwen-custom') || v[0]
        if (!b) throw new Error('쓸 수 있는 기본 목소리가 없습니다')
        const r = await window.api.reader.speak(${JSON.stringify(say)}, { kind: 'builtin', path: b.path, engineId: b.engineId }, 'builtin:' + b.engineId + ':' + b.path)
        if (r.error || !r.data?.path) throw new Error(r.error || '말소리를 만들지 못했습니다')
        return { path: r.data.path, voice: b.label }
      })()`)
      const file = path.join(session.inputs, safe(name || `말소리-${n}`) + '.wav')
      fs.copyFileSync(made.path, file)
      return { path: file, voice: made.voice, ...AF.inspectWav(file) }
    }
    throw new Error("kind = text | tone | speech | fixture")
  },
  // ── 조작 보충 ──
  ui_drop_files: async ({ window = 'main', target, paths = [], userApproved }) => {
    const list = [].concat(paths).map((p) => (path.isAbsolute(String(p)) ? String(p) : path.join(ROOT, String(p))))
    AF.guardMedia(list, session, userApproved)
    for (const p of list) if (!fs.existsSync(p)) throw new Error('파일이 없습니다: ' + path.basename(p))
    const page = await findPage(window)
    // 진짜 경로가 실린 파일을 만드는 길: 숨긴 파일 입력칸에 경로로 넣는다(Electron 이 그 파일의 경로를 안다 — 실측).
    await page.evaluate(() => { let i = document.getElementById('__mcpDropInput'); if (!i) { i = document.createElement('input'); i.type = 'file'; i.id = '__mcpDropInput'; i.multiple = true; i.style.display = 'none'; document.body.appendChild(i) } })
    await page.setInputFiles('#__mcpDropInput', list)
    const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); for (const f of document.getElementById('__mcpDropInput').files) d.items.add(f); return d })
    // 핸들(dt)을 넘겨야 해서 함수형으로 부른다 — 화면 안 도우미는 글로 넘겨 그 자리에서 만든다(검사 모드는 eval 허락).
    return page.evaluate(({ dt, t, helpers }) => {
      // eslint-disable-next-line no-new-func
      const __mcp = new Function(helpers + '\nreturn __mcp')()
      const el = __mcp.resolve(t, null, false, 0)
      if (!el) return { dropped: false, error: '대상 없음: ' + t }
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) || el
      for (const ty of ['dragenter', 'dragover', 'drop']) hit.dispatchEvent(new DragEvent(ty, { bubbles: true, cancelable: true, dataTransfer: dt }))
      return { dropped: true, files: dt.files.length, on: __mcp.describe(hit, false) }
    }, { dt, t: target, helpers: HELPERS })
  },
  ui_key: async ({ window = 'main', keys, target = null, repeat = 1 }) => {
    const page = await findPage(window)
    if (target) {
      const f = await inPage(window, `(() => { const el = __mcp.resolve(${JSON.stringify(target)}, null, false, 0); if (!el) return null; el.focus(); return __mcp.describe(el, false) })()`)
      if (!f) throw new Error('대상 없음: ' + target)
    }
    for (let i = 0; i < Math.max(1, Math.min(50, Number(repeat) || 1)); i++) await page.keyboard.press(String(keys))
    await sleep(200)
    return { pressed: keys, repeat, focused: await inPage(window, '(document.activeElement && document.activeElement !== document.body) ? __mcp.describe(document.activeElement, false) : null') }
  },
  ui_pointer: async ({ window = 'main', target, action = 'click', at = [0.5, 0.5], to = null, toTarget = null, steps = 12 }) => {
    const page = await findPage(window)
    const r = await inPage(window, `__mcp.rect(${JSON.stringify(target)})`)
    if (!r) throw new Error('대상 없음(보이는 요소): ' + target)
    // ★끝에서 1px 안쪽으로 — 비율 1(오른쪽 끝)은 요소 바로 밖을 눌러, 대화창이면 뒤의 가림막을 눌러 창이 닫혔다(실측).
    const inside = (start, size, f) => start + Math.max(1, Math.min(size - 1, size * Math.min(1, Math.max(0, Number(f)))))
    const pt = (rect, f) => ({ x: inside(rect.x, rect.width, f[0]), y: inside(rect.y, rect.height, f[1]) })
    const a = pt(r, at)
    if (action === 'hover') { await page.mouse.move(a.x, a.y) }
    else if (action === 'click') { await page.mouse.click(a.x, a.y) }
    else if (action === 'rightclick') { await page.mouse.click(a.x, a.y, { button: 'right' }) }
    else if (action === 'drag') {
      let b
      if (toTarget) { const r2 = await inPage(window, `__mcp.rect(${JSON.stringify(toTarget)})`); if (!r2) throw new Error('끌어 갈 대상 없음: ' + toTarget); b = pt(r2, [0.5, 0.5]) }
      else if (to) b = pt(r, to)
      else throw new Error('drag 에는 to(비율) 또는 toTarget 이 필요하다')
      await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: Math.max(2, Number(steps) || 12) }); await page.mouse.up()
    } else throw new Error('action = click | rightclick | hover | drag')
    await sleep(250)
    return { action, at: [Math.round(a.x), Math.round(a.y)], rect: r }
  },
  ui_scroll: ({ window = 'main', target = null, to = null, by = null }) => inPage(window, `(() => {
    const el = ${target ? `__mcp.resolve(${JSON.stringify(target)}, null, false, 0)` : 'document.scrollingElement'}
    if (!el) return { error: '대상 없음' }
    const t = ${JSON.stringify(to)}, b = ${JSON.stringify(by)}
    if (t === 'top') el.scrollTop = 0; else if (t === 'bottom') el.scrollTop = el.scrollHeight; else if (typeof t === 'number') el.scrollTop = t
    if (typeof b === 'number') el.scrollTop += b
    el.dispatchEvent(new Event('scroll'))
    return { scrollTop: Math.round(el.scrollTop), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })()`),
  ui_audit: ({ window = 'main', within = null, tinyPx = 11, limit = 15 }) => inPage(window, AF.auditExpr({ within, tinyPx, limit })),
  app_restart: async ({ keepData = true, visible }) => {
    if (!session) throw new Error('앱이 실행 중이 아닙니다 — 먼저 app_start')
    const v = visible == null ? session.visible : !!visible
    const prep = session.prep         // 끄면 session 이 비므로 먼저 붙든다
    await stopApp({ keepData })
    return startApp({ visible: v, build: 'never', keepData, prep })
  },
  errors: async ({ since = 0, limit = 100 }) => {
    await dialogLogs()
    const bad = logs.filter((l) => l.seq > since && (
      (l.source.startsWith('renderer') && (l.level === 'error' || l.level === 'warning' || /pageerror/.test(l.text))) ||
      (l.source === 'main' && /\b(error|exception|fail|crash)|실패|오류/i.test(l.text) && !/DevTools|Autofill|GPU process/i.test(l.text))))
    // ★검사 모드에서만 나는 알려진 경고는 따로 센다 — 검사 도구(Playwright) 때문에 검사 모드의 화면 정책에만 eval 을 허락해서
    //   Electron 이 늘 경고한다(제품 정책엔 eval 이 없다 — offlinePolicy.test 가 본다). 매번 섞이면 진짜 문제가 묻힌다.
    const KNOWN = /Electron Security Warning \(Insecure Content-Security-Policy\)/
    const real = bad.filter((l) => !KNOWN.test(l.text))
    const app = appLogLines().filter((l) => /\b(WARN|ERROR)\b/.test(l) && !KNOWN.test(l)).slice(-limit)
    return { lastSeq: logSeq, count: real.length, items: real.slice(-limit), appWarnings: app,
      knownTestModeNotices: bad.length - real.length + appLogLines().filter((l) => KNOWN.test(l)).length }
  },
  logs: async ({ since = 0, source = null, grep = null, limit = 300 }) => {
    const re = grep ? new RegExp(grep, 'i') : null
    if (source === 'app') {
      let lines = appLogLines()
      if (re) lines = lines.filter((l) => re.test(l))
      return { items: lines.slice(-limit) }
    }
    await dialogLogs()
    let out = logs.filter((l) => l.seq > since)
    if (source) out = out.filter((l) => l.source.startsWith(source))
    if (re) out = out.filter((l) => re.test(l.text))
    return { lastSeq: logSeq, items: out.slice(-limit) }
  }
}
const MAX_TEXT = 60000
async function callTool (name, args) {
  const fn = HANDLERS[name]
  if (!fn) return { content: [text('알 수 없는 도구: ' + name)], isError: true }
  try {
    const r = await fn(args || {})
    if (r && Array.isArray(r.content)) return r
    let t = typeof r === 'string' ? r : JSON.stringify(r, null, 1)
    if (t && t.length > MAX_TEXT) t = t.slice(0, MAX_TEXT) + `\n…<${t.length - MAX_TEXT}자 생략 — 범위를 좁혀 다시 요청>`
    return { content: [{ type: 'text', text: t === undefined ? 'null' : t }] }
  } catch (e) {
    return { content: [text('오류: ' + ((e && e.message) || e))], isError: true }
  }
}

// ── MCP(JSON-RPC 2.0 · 표준입출력 한 줄 = 메시지 하나) ──
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })
async function onMessage (m) {
  const isRequest = m && m.id !== undefined && m.id !== null
  switch (m && m.method) {
    case 'initialize': {
      const want = m.params && m.params.protocolVersion
      return reply(m.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(want) ? want : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'AudioForge(음원 도구)를 직접 실행·조작·관찰하는 도구. 순서: app_start → ui_snapshot/ui_query 로 화면 파악 → ui_click/ui_set/api_call 로 조작 → ui_wait/logs 로 결과 확인 → app_stop. 요소는 testid 로 지정하는 것이 가장 확실하다(예: testid:mode-reader). 창은 기본적으로 화면 밖이라 사용자 작업을 방해하지 않는다. 파일 고르기는 dialog_queue 로 미리 응답을 넣는다. 사용자 데이터는 격리된 임시 폴더를 쓴다. ★사용자의 음성·영상 파일은 사용자가 명시적으로 허락한 것만 연다(검사용 자리 밖 미디어 경로는 도구가 막는다 — 대신 test_input). 소리는 들을 수 없다 — audio_now·audio_inspect로 본다. 음원 품질 검수는 앱 실행 없이 audio_quality_capabilities → analyze → read(전 페이지) → plot/compare/clip. 자동 지표를 청취 합격으로 해석하지 않는다.\n' + AF.SCREEN_MAP
      })
    }
    case 'notifications/initialized': case 'notifications/cancelled': return
    case 'ping': return isRequest && reply(m.id, {})
    case 'tools/list': return reply(m.id, { tools: TOOLS })
    case 'tools/call': return reply(m.id, await callTool(m.params && m.params.name, m.params && m.params.arguments))
    default:
      if (isRequest) fail(m.id, -32601, 'Method not found: ' + (m && m.method))
  }
}
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let m
    try { m = JSON.parse(line) } catch { fail(null, -32700, 'Parse error'); continue }
    onMessage(m).catch((e) => { log('처리 실패: ' + ((e && e.stack) || e)); if (m.id != null) fail(m.id, -32603, String((e && e.message) || e)) })
  }
})
const shutdown = async () => { QUALITY.stop(); try { await stopApp() } catch { /* 이미 닫혔다 */ } process.exit(0) }
process.stdin.on('end', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
log('준비됨 (프로젝트: ' + ROOT + ')')
