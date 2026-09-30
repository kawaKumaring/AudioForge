// 개발툴 MCP 종단 검증 — 진짜 MCP 규약(JSON-RPC · 표준입출력)으로 서버에 붙어 앱을 켜고·조작하고·끈다.
//
// ★왜 (2026-09-30): AI 가 AudioForge 를 직접 켜고 한 단계씩 확인하게 하는 도구(tools/mcp/server.cjs).
//   Spine2DManager 의 같은 도구(§278)를 본떴고, 그 검증 항목을 이 앱에 맞게 옮겼다.
//
// 여기서 보는 것
//   1) 핸드셰이크 · 도구 목록 · 표준출력에 MCP 메시지 말고는 없다(섞이면 AI 쪽 연결이 끊긴다)
//   2) ★창이 화면 밖 · 포커스 없음으로 뜬다(사용자 화면·마우스를 방해하지 않는다)
//   3) 화면 파악(접근성 트리 · 요소 목록의 testid) · 누르기(낭독 화면으로) · 캡처(PNG, 화면 밖 창)
//   4) 앱 기능 호출(window.api 묶음 이름) · 없는 기능은 오류로 안내
//   5) ★OS 파일 창이 뜨지 않고 큐 응답으로 바뀐다(큐가 비면 취소) · 응답이 기록에 남는다
//   6) 앱 동작 기록(파일) 읽기
//   7) ★끝나면 앱 프로세스와 임시 폴더가 남지 않는다
//
// 실행: node test/e2e/mcp-devtool.e2e.mjs   (사전: npm run build)
import '../_temp-root.mjs'           // ★맨 앞 — 검사 도구가 임시 자리를 C 드라이브로 정하기 전에
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { McpClient } = require('../../tools/mcp/client.cjs')
const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }

let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

const c = new McpClient({ serverPath: path.join(APP, 'tools', 'mcp', 'server.cjs') })
let stderr = ''
c.onStderr = (s) => { stderr += s }
let tmpDir = null
try {
  const init = await c.start()
  ok(init?.serverInfo?.name === 'audioforge-devtool' && init?.capabilities?.tools, '핸드셰이크: 서버 정보 · tools 기능 선언')
  const tools = await c.listTools()
  const names = tools.map((t) => t.name)
  const need = ['app_start', 'app_stop', 'app_status', 'ui_snapshot', 'ui_query', 'ui_click', 'ui_set', 'ui_wait', 'ui_screenshot', 'api_list', 'api_call', 'js_eval', 'dialog_queue', 'logs']
  ok(need.every((n) => names.includes(n)) && tools.every((t) => t.description && t.inputSchema?.type === 'object'), `도구 목록: 필수 ${need.length}종 + 설명·입력 형식`)
  const early = await c.call('ui_query')
  ok(early.isError && /app_start/.test(early.text), '앱을 켜기 전 조작은 오류로 안내(app_start 먼저)')

  const st = await c.call('app_start', { build: 'never' })
  ok(!st.isError && st.json?.running, '앱 시작' + (st.isError ? ' — ' + st.text.slice(0, 300) : ''))
  tmpDir = st.json?.userData ? path.join(APP, path.dirname(st.json.userData)) : null
  const main = st.json?.windows?.find((w) => w.kind === 'main')
  ok(main && main.x <= -20000 && main.y <= -20000 && main.focused === false, `★창이 화면 밖 · 포커스 없음 (x=${main?.x}, focused=${main?.focused})`)
  ok(/^_local[\\/]tmp[\\/]mcp-/.test(st.json?.userData || ''), '★사용자 데이터는 저장소 안 임시 폴더(사용자 설정 불변 · C 드라이브 아님)', st.json?.userData)

  const snap = await c.call('ui_snapshot')
  ok(!snap.isError && snap.text.length > 50, `화면 구조(접근성 트리) ${snap.text.length}자`)
  const q = await c.call('ui_query', { limit: 400 })
  ok(!q.isError && q.json?.total > 5 && q.json.items.some((it) => it.testid === 'mode-reader'), `요소 목록에 testid 가 실린다(mode-reader) · 전체 ${q.json?.total}개`)
  const clk = await c.call('ui_click', { target: 'testid:mode-reader' })
  const inReader = await c.call('ui_wait', { selector: 'testid:reader-add-text', timeoutMs: 10000 })
  ok(!clk.isError && clk.json?.clicked && inReader.json?.met, '★testid 로 눌러 낭독 화면으로 간다')
  const bad = await c.call('ui_click', { target: '존재하지않는버튼xyz' })
  ok(!bad.isError && bad.json?.clicked === false, '없는 요소는 clicked=false 로 알려 준다')

  const shot = await c.call('ui_screenshot', { maxWidth: 800 })
  const png = shot.images[0] ? Buffer.from(shot.images[0], 'base64') : Buffer.alloc(0)
  ok(!shot.isError && png.length > 3000 && png.readUInt32BE(0) === 0x89504e47 && png.readUInt32BE(16) === 800, `★캡처: PNG(폭 800 · ${png.length}바이트) — 화면 밖 창도`)

  const list = await c.call('api_list')
  ok(!list.isError && Array.isArray(list.json) && list.json.includes('audio.getFileUrl') && list.json.includes('reader.speak'), `앱 기능 목록(묶음 이름) ${list.json?.length}개`)
  const voices = await c.call('api_call', { method: 'cards.builtinVoices' })
  ok(!voices.isError && Array.isArray(voices.json?.data?.voices), '앱 기능 호출(진짜 IPC 경로) — 기본 목소리 목록', voices.text.slice(0, 200))
  const miss = await c.call('api_call', { method: 'noSuch.thing' })
  ok(miss.isError && /noSuch\.thing/.test(miss.text), '없는 기능은 오류로 안내')

  // 파일 창: 큐 → 비면 취소. 낭독의 '텍스트 추가' 는 pickTexts → 본체 대화상자를 탄다.
  const book = path.join(APP, '_local', 'tmp', 'mcp-e2e-book.txt')
  fs.writeFileSync(book, '첫째 문단이다. 그는 천천히 문을 열었다.', 'utf-8')
  await c.call('dialog_queue', { kind: 'open', answers: [book] })
  const d1 = await c.call('api_call', { method: 'reader.pickTexts' })
  const d2 = await c.call('api_call', { method: 'reader.pickTexts' })
  ok(!d1.isError && d1.json?.data?.[0]?.name === 'mcp-e2e-book.txt', '★OS 파일 창 → 큐에 넣은 파일로 응답(진짜 창 안 뜸)', d1.text.slice(0, 200))
  ok(!d2.isError && Array.isArray(d2.json?.data) && d2.json.data.length === 0, '큐가 비면 취소로 응답')
  const dl = await c.call('logs', { source: 'dialog' })
  ok(!dl.isError && dl.json?.items?.length >= 2, '대화상자 응답이 기록에 남는다')
  fs.rmSync(book, { force: true })

  const al = await c.call('logs', { source: 'app', grep: 'pick' })
  ok(!al.isError && al.json?.items?.some((l) => /\[pick\]/.test(l)), '앱 동작 기록(파일)을 읽는다([pick] 줄)')
  const ev = await c.call('js_eval', { code: 'typeof window.__afStore' })
  ok(!ev.isError && /function|object/.test(ev.text), '화면 JS 평가(점검용)')
} catch (e) {
  fails.push('예외: ' + (e?.message || e))
  console.log('FAIL 예외', e?.message || e)
} finally {
  const stop = await c.call('app_stop').catch((e) => ({ isError: true, text: String(e) }))
  ok(!stop.isError && stop.json?.stopped, '앱 종료')
  const after = await c.call('app_status').catch(() => null)
  ok(after && !after.isError && after.json?.running === false, '종료 후 실행 중 아님')
  await c.close()
}
ok(!c.protocolError, '★표준출력에 MCP 메시지 말고는 없다' + (c.protocolError ? ' — ' + c.protocolError : ''))
ok(!tmpDir || !fs.existsSync(tmpDir), '★끝나면 임시 폴더(사용자 데이터 포함)가 남지 않는다', tmpDir)
console.log(`RESULT ${passed} checks · ${fails.length} fail`)
if (fails.length) console.log('--- 서버 stderr(끝부분) ---\n' + stderr.split('\n').slice(-20).join('\n'))
process.exit(fails.length ? 1 : 0)
