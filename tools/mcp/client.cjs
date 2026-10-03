'use strict'
// AudioForge 개발툴 MCP — 최소 MCP 클라이언트(테스트·수동 점검용). 출처: Spine2DManager tools/mcp/client.cjs(§278) — 이름·결과 폴더만 바꿨다. MCP가 연결되지 않은 환경(CI, 다른 AI 세션, 사람)에서도
//   server.cjs를 똑같은 MCP 규약으로 부를 수 있게 한다.
//   코드에서:  const { McpClient } = require('./tools/mcp/client.cjs'); const c = new McpClient(); await c.start(); await c.call('app_start')
//   명령줄:    node tools/mcp/client.cjs steps.json      (steps.json = [{ "tool": "app_start" }, { "tool": "ui_query", "args": {...} }, ...])
//             node tools/mcp/client.cjs --list            (도구 목록)
//   이미지 결과는 --out 폴더(기본 임시 폴더)에 step번호.png 로 저장하고 경로만 출력한다.
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

class McpClient {
  constructor ({ serverPath = path.join(__dirname, 'server.cjs'), onStderr = null } = {}) { this.serverPath = serverPath; this.onStderr = onStderr; this.nextId = 1; this.pending = new Map(); this.buf = '' }
  async start () {
    this.proc = spawn(process.execPath, [this.serverPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (c) => {
      this.buf += c
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1)
        if (!line) continue
        let m; try { m = JSON.parse(line) } catch { this.protocolError = 'stdout에 JSON 아닌 줄: ' + line.slice(0, 120); continue }
        const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error.message), { code: m.error.code })) : p.resolve(m.result) }
      }
    })
    this.proc.stderr.on('data', (c) => { if (this.onStderr) this.onStderr(String(c)) })
    this.init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'audioforge-mcp-client', version: '0.1.0' } })
    this.notify('notifications/initialized')
    return this.init
  }
  request (method, params, timeoutMs = 600000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('응답 시간 초과: ' + method)) }, timeoutMs)
      this.pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r) }, reject: (e) => { clearTimeout(t); reject(e) } })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  notify (method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n') }
  listTools () { return this.request('tools/list', {}).then((r) => r.tools) }
  // 도구 호출 — 반환: { isError, text(합친 글자), json(글자가 JSON이면 파싱), images: [base64...] }
  async call (name, args = {}) {
    const r = await this.request('tools/call', { name, arguments: args })
    const texts = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text)
    const images = (r.content || []).filter((c) => c.type === 'image').map((c) => c.data)
    const t = texts.join('\n')
    let json = null; try { json = JSON.parse(texts[0]) } catch {}
    return { isError: !!r.isError, text: t, json, images, raw: r }
  }
  async close () { if (!this.proc) return; this.proc.stdin.end(); await new Promise((r) => { const t = setTimeout(() => { try { this.proc.kill() } catch {} r() }, 8000); this.proc.once('exit', () => { clearTimeout(t); r() }) }) }
}
module.exports = { McpClient }

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2)
    const outIdx = argv.indexOf('--out'); const OUT = outIdx >= 0 ? argv[outIdx + 1] : path.join(__dirname, '..', '..', '_local', 'tmp', 'mcp-client')
    const c = new McpClient({ onStderr: (s) => process.stderr.write(s) })
    await c.start()
    try {
      if (argv.includes('--list')) { for (const t of await c.listTools()) console.log(`${t.name} — ${t.description}`); return }
      const file = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out')
      if (!file) { console.error('사용: node tools/mcp/client.cjs <steps.json> [--out 폴더] | --list'); process.exitCode = 2; return }
      const steps = JSON.parse(fs.readFileSync(file, 'utf8'))
      fs.mkdirSync(OUT, { recursive: true })
      for (const [i, s] of steps.entries()) {
        const r = await c.call(s.tool, s.args || {})
        const imgs = r.images.map((b64, j) => { const f = path.join(OUT, `${String(i).padStart(2, '0')}_${s.tool}${j ? '_' + j : ''}.png`); fs.writeFileSync(f, Buffer.from(b64, 'base64')); return f })
        console.log(`\n### [${i}] ${s.tool}${r.isError ? ' ❌' : ''}\n${r.text.slice(0, s.maxChars || 4000)}${imgs.length ? '\n이미지: ' + imgs.join(', ') : ''}`)
        if (r.isError && s.stopOnError !== false) break
      }
    } finally { await c.close() }
  })().catch((e) => { console.error(e); process.exit(1) })
}
