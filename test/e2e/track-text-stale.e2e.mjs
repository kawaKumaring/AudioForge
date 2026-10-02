// 결과 트랙의 글(원문·번역) — 결과가 바뀌면 이전 글이 남지 않는다 · 늦은 응답이 현재 결과에 붙지 않는다 ·
// 개별 받아쓰기·번역 작업의 완료·오류는 **그 결과의 것만** 받는다(이름 부분 일치 금지) · 시작 거절을 보인다.
// 왜(2026-10-02 관리자 검수 재현): 같은 이름(vocals)의 새 결과로 바뀌어도 TrackItem 이 그대로 살아 앞 결과의 글을 들고 있었고,
//   파일이 없으면 상태를 비우지 않아 남았다. 늦게 끝난 앞 읽기가 새 결과를 덮을 수도 있었다.
// 실제 파일 읽기 IPC · 실제 화면. 받아쓰기·번역 **작업 자체는 돌리지 않는다** — 시작 통로만 검사용으로 바꾸고,
//   완료·오류 알림은 본체가 실제 채널(audio:track-result / audio:track-error)로 보낸다. 사용자 음원·GPU 없음.
// 실행: node test/e2e/track-text-stale.e2e.mjs     (사전: npm run build)
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { _electron as electron } from 'playwright'
import { isolatedUserData, cleanupUserData, cleanupIsolated } from './_e2e-helper.mjs'

const APP = process.cwd()
if (!fs.existsSync(path.join(APP, 'out/main/index.js'))) { console.error('빌드 필요'); process.exit(2) }
const UD = isolatedUserData()
const ISO = path.join(os.tmpdir(), 'audioforge_e2e_' + randomUUID())
fs.mkdirSync(ISO, { recursive: true })
let passed = 0
const fails = []
const ok = (v, label, extra) => {
  if (v) { passed++; console.log('PASS', label) }
  else { fails.push(label); console.log('FAIL', label, extra === undefined ? '' : JSON.stringify(extra)) }
}
/** 0.3초 무음 WAV(검사용 — 사용자 음원이 아니다). */
function silentWav(file) {
  const n = 2400, buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(8000, 24); buf.writeUInt32LE(16000, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  fs.writeFileSync(file, buf)
}
const P = (n) => path.join(ISO, n)
for (const n of ['a', 'b', 'c', 'ax']) silentWav(P(`audit-${n}.wav`))
fs.writeFileSync(P('audit-a.txt'), '앞 결과에서만 존재하는 원문', 'utf-8')
fs.writeFileSync(P('audit-a_korean.txt'), '앞 결과의 번역', 'utf-8')
fs.writeFileSync(P('audit-b.txt'), '뒤 결과의 원문', 'utf-8')
fs.writeFileSync(P('audit-b_korean.txt'), '뒤 결과의 번역', 'utf-8')
// c 는 글 파일이 없다.

const firstLine = (e) => String(e?.message || e).split('\n')[0]
const ONLY = process.env.TRACK_E2E_ONLY || ''      // 구간 이름의 일부만 돌릴 때(예: 작업 알림)
const section = async (name, fn) => { if (ONLY && !name.includes(ONLY)) return; try { await fn() } catch (e) { fails.push(`예외(${name}): ${firstLine(e)}`); console.log('FAIL 예외', name, firstLine(e)) } }
let app = null
try {
  app = await electron.launch({ args: ['out/main/index.js'], cwd: APP, env: { ...process.env, AF_E2E: '1', AF_E2E_USER_DATA: UD } })
  const win = await app.firstWindow()
  win.setDefaultTimeout(15000)
  await win.waitForFunction(() => !!window.__afStore)
  const show = (n) => win.evaluate(({ dir, p }) => window.__afStore.setState({
    mode: 'music', status: 'done', resultMode: 'music', outputDir: dir, tracks: [{ name: 'vocals', label: '보컬', path: p }] }), { dir: ISO, p: P(`audit-${n}.wav`) })
  const bodyHas = (s) => win.evaluate((t) => document.body.innerText.includes(t), s)
  const expandBtn = win.locator('button[aria-label="보컬 텍스트 펼치기"]')
  const collapseBtn = win.locator('button[aria-label="보컬 텍스트 접기"]')
  const open = async () => { if (await expandBtn.count()) await expandBtn.click() }
  const settle = (ms = 500) => win.waitForTimeout(ms)

  // ── 1. A 에만 글이 있고 B 에는 없다(같은 이름 vocals) ────────────────────────────────────────
  await section("같은 이름·글 없음", async () => {
  await show('a'); await expandBtn.waitFor(); await open()
  ok(await bodyHas('앞 결과에서만 존재하는 원문') && await bodyHas('앞 결과의 번역'), '준비: 앞 결과의 원문·번역이 보인다')
  await show('c'); await settle()
  ok(!(await bodyHas('앞 결과에서만 존재하는 원문')) && !(await bodyHas('앞 결과의 번역')), '★글이 없는 새 결과에는 앞 결과의 원문·번역이 남지 않는다')
  ok((await expandBtn.count()) === 0 && (await collapseBtn.count()) === 0, '글이 없는 새 결과에는 텍스트 단추도 없다')
  })

  // ── 2. B 에는 다른 글이 있다 ─────────────────────────────────────────────────────────────────
  await section("다른 글", async () => {
  await show('a'); await expandBtn.waitFor(); await open()
  await show('b'); await settle(); await open()
  ok(!(await bodyHas('앞 결과에서만 존재하는 원문')) && !(await bodyHas('앞 결과의 번역')), '★다른 글이 있는 새 결과에도 앞 결과의 글이 남지 않는다')
  ok(await bodyHas('뒤 결과의 원문') && await bodyHas('뒤 결과의 번역'), '새 결과의 원문·번역이 보인다')
  })

  // ── 3. 앞 결과의 읽기가 늦게 끝난다 — 새 결과를 덮지 않는다 ─────────────────────────────────────
  await section("늦은 읽기", async () => {
  await show('c'); await settle()
  await app.evaluate(({ ipcMain }) => {
    const m = ipcMain._invokeHandlers
    globalThis.__origReads = {}
    for (const ch of [...m.keys()].filter((k) => k.startsWith('app:read-text-file'))) {
      const orig = m.get(ch); globalThis.__origReads[ch] = orig
      m.set(ch, async (e, p) => { if (/audit-a(_korean)?\.txt$/.test(String(p))) await new Promise((r) => setTimeout(r, 1200)); return orig(e, p) })
    }
  })
  await show('a'); await settle(150)          // 앞 결과의 읽기가 아직 끝나지 않았다
  await show('b'); await settle(1800); await open()
  ok(!(await bodyHas('앞 결과에서만 존재하는 원문')) && !(await bodyHas('앞 결과의 번역')), '★앞 결과의 늦은 읽기가 새 결과 아래에 붙지 않는다(원문·번역)')
  ok(await bodyHas('뒤 결과의 원문') && await bodyHas('뒤 결과의 번역'), '새 결과의 글은 그대로다')
  await app.evaluate(({ ipcMain }) => { for (const [ch, h] of Object.entries(globalThis.__origReads)) ipcMain._invokeHandlers.set(ch, h) })
  })

  // ── 4. 개별 작업의 완료·오류는 그 결과의 것만 받는다 ───────────────────────────────────────────
  const emit = (channel, payload) => app.evaluate(({ BrowserWindow }, a) => { BrowserWindow.getAllWindows()[0].webContents.send(a.channel, a.payload) }, { channel, payload })
  await app.evaluate(({ ipcMain }) => {
    globalThis.__origProc = ipcMain._invokeHandlers.get('audio:process-track')
    globalThis.__procMode = 'start'
    ipcMain._invokeHandlers.set('audio:process-track', async (_e, _p, _d, _o, id) => { globalThis.__lastReq = id; if (globalThis.__procMode === 'refuse') throw new Error('이미 처리 중인 트랙 작업이 있습니다'); return undefined })
  })
  /** 새 결과로 갈아 끼운다 — 앞 작업이 처리 중으로 남은 같은 경로의 행을 이어 쓰지 않게 다른 경로를 거친다. */
  const fresh = async (n) => { await show('ax'); await settle(200); await show(n); await settle() }
  /** 방금 시작한 요청의 식별자(화면이 만들어 시작 통로로 보낸 값). */
  const reqId = () => app.evaluate(() => globalThis.__lastReq)
  const startTranscribe = async () => {
    await win.getByTestId('track-menu').click()
    await win.getByTestId('track-menu-transcribe').click()
    await win.getByRole('status').filter({ hasText: '처리 중' }).waitFor()
  }

  await section("작업 알림", async () => {
  await fresh('c')
  await startTranscribe()
  // (a) 이름이 부분만 겹치는 다른 작업의 완료 — 받지 않는다
  await emit('audio:track-result', { trackPath: P('audit-c-extra.wav'), tracks: [{ name: 'audit-c-extra', text: '다른 작업의 글' }] })      // 이름에 audit-c 가 들어 있다
  await settle(400)
  ok(!(await bodyHas('다른 작업의 글')) && (await win.getByRole('status').filter({ hasText: '처리 중' }).count()) === 1,
    '★이름이 부분만 겹치는 다른 작업의 완료는 받지 않는다(처리 중 그대로)')
  })
  await section("작업 알림-늦은 완료", async () => {
    await fresh('c'); await startTranscribe()
  const idLate = await reqId()
  // (b) 앞 작업이 도는 중 결과가 바뀐다 → 앞 작업의 늦은 완료가 새 결과에 붙지 않는다
  await show('b'); await settle()
  await emit('audio:track-result', { trackPath: P('audit-c.wav'), requestId: idLate, tracks: [{ name: 'audit-c', text: '앞 작업의 늦은 글' }] })
  await settle(400); await open()
  ok(!(await bodyHas('앞 작업의 늦은 글')), '★결과가 바뀐 뒤 도착한 앞 작업의 완료는 새 결과에 붙지 않는다')
  })
  await section("작업 알림-완료", async () => {
  // (c) 맞는 완료는 받는다
  await fresh('c')
  await startTranscribe()
  await emit('audio:track-result', { trackPath: P('audit-c.wav'), requestId: await reqId(), tracks: [{ name: 'audit-c', text: '맞는 작업의 글', translated_text: '맞는 작업의 번역' }] })
  await win.getByRole('status').filter({ hasText: '처리 중' }).waitFor({ state: 'detached' })
  await open()
  ok(await bodyHas('맞는 작업의 글') && await bodyHas('맞는 작업의 번역'), '이 결과의 완료는 받는다(원문·번역)')
  // (d) 다른 결과의 오류는 무시, 이 결과의 오류는 짧게 보인다
  await fresh('c')
  await startTranscribe()
  const idErr = await reqId()
  await emit('audio:track-error', { trackPath: P('audit-ax.wav'), requestId: idErr, message: '다른 작업의 오류' })
  await settle(300)
  ok((await win.getByRole('status').filter({ hasText: '처리 중' }).count()) === 1 && !(await bodyHas('다른 작업의 오류')), '★다른 결과의 오류는 이 결과의 처리를 멈추지 않는다')
  await emit('audio:track-error', { trackPath: P('audit-c.wav'), message: '식별 정보 없는 오류' })
  await settle(300)
  ok((await win.getByRole('status').filter({ hasText: '처리 중' }).count()) === 1 && !(await bodyHas('식별 정보 없는 오류')), '★요청 식별자가 없는 오류는 이 작업의 오류로 받지 않는다')
  await emit('audio:track-error', { trackPath: P('audit-c.wav'), requestId: 'OTHER-REQUEST-0001', message: '다른 요청의 오류' })
  await settle(300)
  ok((await win.getByRole('status').filter({ hasText: '처리 중' }).count()) === 1 && !(await bodyHas('다른 요청의 오류')), '★경로가 맞아도 요청 식별자가 다른 오류는 받지 않는다')
  await emit('audio:track-error', { trackPath: P('audit-c.wav'), requestId: idErr, message: '이 작업의 오류' })
  await win.getByRole('status').filter({ hasText: '처리 중' }).waitFor({ state: 'detached' })
  ok(await bodyHas('이 작업의 오류'), '★이 결과의 오류는 그 자리에 짧게 보인다')
  })
  await section("같은 파일 다시 처리", async () => {
  // 같은 파일을 두 번 처리한다 — 첫 실행의 늦은 응답이 둘째 실행에 붙지 않는다(경로는 같고 요청 식별자만 다르다).
  await fresh('c'); await startTranscribe()
  const id1 = await reqId()
  await show('ax'); await settle(200); await show('c'); await settle()       // 같은 파일 — 새 행(첫 실행의 구독은 끊겼다)
  await startTranscribe()
  const id2 = await reqId()
  ok(!!id2 && id1 !== id2, '요청마다 다른 식별자가 발급된다', { id1, id2 })
  await emit('audio:track-result', { trackPath: P('audit-c.wav'), requestId: id1 ?? 'OLD-RUN-ID', tracks: [{ name: 'audit-c', text: '앞 실행의 늦은 글' }] })
  await emit('audio:track-error', { trackPath: P('audit-c.wav'), requestId: id1 ?? 'OLD-RUN-ID', message: '앞 실행의 늦은 오류' })
  await settle(400)
  ok(!(await bodyHas('앞 실행의 늦은 글')) && !(await bodyHas('앞 실행의 늦은 오류')) && (await win.getByRole('status').filter({ hasText: '처리 중' }).count()) === 1,
    '★같은 파일을 다시 처리할 때 앞 실행의 늦은 완료·오류가 붙지 않는다(처리 중 그대로)')
  await emit('audio:track-result', { trackPath: P('audit-c.wav'), requestId: id2, tracks: [{ name: 'audit-c', text: '이번 실행의 글' }] })
  await win.getByRole('status').filter({ hasText: '처리 중' }).waitFor({ state: 'detached' })
  await open()
  ok(await bodyHas('이번 실행의 글'), '이번 실행의 완료는 받는다')
  })
  await section("요청 식별자 필수", async () => {
  // 실제 본체 핸들러 — 식별자 없는 시작은 거절한다(파이썬을 띄우기 전에).
  await app.evaluate(({ ipcMain }) => { ipcMain._invokeHandlers.set('audio:process-track', globalThis.__origProc) })
  const bad = await win.evaluate(() => window.api.audio.processTrack('E:/없는/a.wav', 'E:/없는', { transcribe: true }, '').then(() => 'accepted', (e) => String(e?.message || e)))
  ok(/요청 식별자/.test(bad), '★요청 식별자 없는 시작은 본체가 거절한다', bad)
  const bad2 = await win.evaluate(() => window.api.audio.processTrack('E:/없는/a.wav', 'E:/없는', { transcribe: true }, '../../x').then(() => 'accepted', (e) => String(e?.message || e)))
  ok(/요청 식별자/.test(bad2), '모양이 틀린 식별자도 거절한다', bad2)
  })
  await section("시작 거절", async () => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain._invokeHandlers.set('audio:process-track', async () => { if (globalThis.__procMode === 'refuse') throw new Error('이미 처리 중인 트랙 작업이 있습니다'); return undefined })
  })
  // (e) 시작 거절 응답을 보인다
  await show('a'); await settle()
  await app.evaluate(() => { globalThis.__procMode = 'refuse' })
  await win.getByTestId('track-menu').click(); await win.getByTestId('track-menu-translate').click()
  await settle(500)
  ok(await bodyHas('이미 처리 중인 트랙 작업이 있습니다') && (await win.getByRole('status').filter({ hasText: '처리 중' }).count()) === 0, '★시작이 거절되면 사유를 보이고 처리 중으로 남지 않는다')
  await app.evaluate(({ ipcMain }) => { ipcMain._invokeHandlers.set('audio:process-track', globalThis.__origProc) })
  })

} catch (e) {
  fails.push('예외: ' + (e?.message || e)); console.log('FAIL 예외', e?.message || e)
} finally {
  if (app) { try { await app.close() } catch { /* 이미 닫혔다 */ } }
  cleanupUserData(UD); cleanupIsolated(ISO)
}
console.log(`RESULT ${passed + fails.length} checks · ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)
